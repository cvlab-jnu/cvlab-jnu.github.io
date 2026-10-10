'use strict';

const express = require('express');
const mongoose = require('mongoose');
const { requireAdmin, attachAdmin } = require('../middleware/auth');
const { placeAt, renumberOps, scopeFilter } = require('../lib/ordering');

/**
 * Builds a REST router for one model.
 *
 *   GET    /            public   list (admins also see hidden items)
 *   GET    /:id         public
 *   POST   /            admin    create
 *   PUT    /:id         admin    replace the given fields
 *   DELETE /:id         admin
 *   POST   /reorder     admin    apply a new order to several documents
 *
 * `fields` is an allow-list. Anything a client sends that is not on it is
 * dropped, so a crafted request cannot set `_id`, `createdAt`, or a field the
 * schema happens to gain later.
 */
function crudRouter(Model, options) {
  const opts = options || {};
  const fields = opts.fields || [];
  const sort = opts.sort || { order: 1, _id: 1 };

  // Which fields partition this collection into separate ordered lists.
  // Members order within their group; research within its kind; courses and
  // the gallery are each a single list.
  const scopeFields = opts.scope || [];

  const router = express.Router();

  /**
   * Renumber one list densely, 0..n-1, closing any gaps.
   *
   * Needed after a deletion, and after a row leaves one list for another — the
   * list it left keeps a hole otherwise.
   */
  async function compact(filter) {
    const siblings = await Model.find(filter)
      .select('_id order')
      .sort(sort)
      .limit(2000)
      .lean();

    const ops = renumberOps(
      siblings.map((s) => String(s._id)),
      new Map(siblings.map((s) => [String(s._id), s.order]))
    );
    if (ops.length) await Model.bulkWrite(ops);
  }

  /**
   * Put `doc` at the position its `order` asks for, shifting the rest.
   *
   * Called after a create or an update, so the saved document is already in the
   * collection and its new scope is known. Reads the list it belongs to, works
   * out the new sequence, and writes back a dense 0..n-1 renumbering.
   *
   * Only rows whose order actually changes are written, so saving a row that is
   * already in the right place costs one read and no writes.
   */
  async function reposition(doc, requestedOrder) {
    const filter = scopeFilter(doc, scopeFields);

    const siblings = await Model.find(filter)
      .select('_id order')
      .sort(sort)
      .limit(2000)
      .lean();

    const currentOrders = new Map(siblings.map((s) => [String(s._id), s.order]));
    const currentIds = siblings.map((s) => String(s._id));

    // An update that did not mention order leaves the row where it is.
    const target = requestedOrder === undefined
      ? currentIds.indexOf(String(doc._id))
      : requestedOrder;

    const ids = placeAt(currentIds, String(doc._id), target);
    const ops = renumberOps(ids, currentOrders);

    if (ops.length) await Model.bulkWrite(ops);

    // Hand back the saved document with the order it ended up with, so the
    // editor shows the real position rather than what was typed.
    const finalOrder = ids.indexOf(String(doc._id));
    if (doc.order !== finalOrder) {
      doc.order = finalOrder;
      if (typeof doc.save === 'function') await doc.save();
    }
    return doc;
  }

  function pick(body) {
    const out = {};
    if (!body || typeof body !== 'object') return out;
    for (const key of fields) {
      if (Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
    }
    return out;
  }

  function isAdminRequest(req) {
    return Boolean(req.admin);
  }

  router.get('/', attachAdmin, async (req, res, next) => {
    try {
      const filter = {};

      // Visitors never see hidden rows; the admin editor needs them.
      if (!isAdminRequest(req)) filter.visible = { $ne: false };

      if (req.query.kind) filter.kind = String(req.query.kind);
      if (req.query.group) filter.group = String(req.query.group);

      const docs = await Model.find(filter).sort(sort).limit(2000);
      res.json(docs);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ error: 'Not a valid id.' });
      }
      const doc = await Model.findById(req.params.id);
      if (!doc) return res.status(404).json({ error: 'Not found.' });
      res.json(doc);
    } catch (err) {
      next(err);
    }
  });

  router.post('/', requireAdmin, async (req, res, next) => {
    try {
      const body = pick(req.body);

      // A new row with no position goes to the end of its list, which is what
      // "add" means. One typed in goes exactly there, pushing the rest down.
      const requested = Object.prototype.hasOwnProperty.call(body, 'order')
        ? Number(body.order)
        : Number.POSITIVE_INFINITY;

      const doc = await Model.create(body);
      await reposition(doc, requested);
      res.status(201).json(doc);
    } catch (err) {
      next(err);
    }
  });

  router.put('/:id', requireAdmin, async (req, res, next) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ error: 'Not a valid id.' });
      }

      const body = pick(req.body);
      const requested = Object.prototype.hasOwnProperty.call(body, 'order')
        ? Number(body.order)
        : undefined;

      // Which list this row is in BEFORE the update. If it moves to another
      // cohort or kind, the one it leaves needs its gap closed — repositioning
      // only renumbers the list the row arrives in.
      const before = scopeFields.length
        ? await Model.findById(req.params.id).select(scopeFields.join(' ')).lean()
        : null;
      const previousFilter = before ? scopeFilter(before, scopeFields) : null;

      const doc = await Model.findByIdAndUpdate(
        req.params.id,
        { $set: body },
        { new: true, runValidators: true }
      );
      if (!doc) return res.status(404).json({ error: 'Not found.' });

      // Reposition after the update, so a row that moved to another group is
      // placed in its NEW list rather than its old one.
      await reposition(doc, requested);

      const nowFilter = scopeFilter(doc, scopeFields);
      if (previousFilter && JSON.stringify(previousFilter) !== JSON.stringify(nowFilter)) {
        await compact(previousFilter);
      }

      res.json(doc);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', requireAdmin, async (req, res, next) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ error: 'Not a valid id.' });
      }
      const doc = await Model.findByIdAndDelete(req.params.id);
      if (!doc) return res.status(404).json({ error: 'Not found.' });

      // Close the gap the deletion left, so positions stay 0..n-1.
      await compact(scopeFilter(doc, scopeFields));

      res.json({ ok: true, deleted: doc._id });
    } catch (err) {
      next(err);
    }
  });

  router.post('/reorder', requireAdmin, async (req, res, next) => {
    try {
      const items = Array.isArray(req.body && req.body.items) ? req.body.items : null;
      if (!items) {
        return res.status(400).json({ error: 'Send { items: [{ id, order }, ...] }.' });
      }
      const ops = items
        .filter((i) => i && mongoose.isValidObjectId(i.id) && Number.isFinite(Number(i.order)))
        .map((i) => ({
          updateOne: {
            filter: { _id: i.id },
            update: { $set: { order: Number(i.order) } },
          },
        }));
      if (ops.length === 0) return res.json({ ok: true, updated: 0 });
      const result = await Model.bulkWrite(ops);
      res.json({ ok: true, updated: result.modifiedCount });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { crudRouter };
