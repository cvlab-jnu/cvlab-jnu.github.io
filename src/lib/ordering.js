'use strict';

/**
 * Insert-and-shift ordering.
 *
 * THE PROBLEM
 * -----------
 * `order` used to be a plain number that the editor wrote straight through. Set
 * a new scholar to 0 and you did not get "first" — you got a tie with whoever
 * was already 0, broken by name or by year. Putting someone third meant
 * renumbering everyone below them by hand, and any gap or duplicate left the
 * list in an order nobody chose.
 *
 * WHAT HAPPENS INSTEAD
 * --------------------
 * Saving a row with order N means "put this one at position N". Everything from
 * N down shifts one place to make room, and the whole list is then renumbered
 * 0, 1, 2, … with no gaps and no duplicates. The number you type is a position,
 * not a label.
 *
 * SCOPE
 * -----
 * Positions are per list, not per collection: members are ordered within their
 * group, research within its kind. Moving a Ph.D. scholar must not renumber the
 * M.Tech. students. server.js gives each model the fields that define its list.
 */

/**
 * Work out the new sequence of ids after placing `movingId` at `requested`.
 *
 * Pure: takes ids, returns ids. All the reasoning that is easy to get wrong
 * lives here, where it can be tested without a database.
 *
 * @param {string[]} currentIds  ids in their present order, EXCLUDING the moving one
 * @param {string}   movingId    the row being saved
 * @param {number}   requested   desired position; clamped into range
 * @returns {string[]} the full list in its new order
 */
function placeAt(currentIds, movingId, requested) {
  const rest = currentIds.filter((id) => String(id) !== String(movingId));

  let pos = Number(requested);
  if (!Number.isFinite(pos)) pos = rest.length;   // no position given: append
  pos = Math.trunc(pos);

  // A position past either end is a reasonable thing to ask for — "put this
  // first" and "put this last" are what 0 and a big number mean — so clamp
  // rather than reject.
  if (pos < 0) pos = 0;
  if (pos > rest.length) pos = rest.length;

  const out = rest.slice();
  out.splice(pos, 0, String(movingId));
  return out;
}

/**
 * The $set operations needed to turn `ids` into a dense 0..n-1 sequence,
 * skipping documents whose order is already correct.
 *
 * @param {string[]} ids      the desired order
 * @param {Map|Object} currentOrders  id -> its order now, for skipping no-ops
 * @returns {Array} bulkWrite operations
 */
function renumberOps(ids, currentOrders) {
  const get = (id) =>
    currentOrders instanceof Map ? currentOrders.get(String(id)) : (currentOrders || {})[String(id)];

  const ops = [];
  ids.forEach((id, index) => {
    if (get(id) === index) return;              // already right, leave it alone
    ops.push({
      updateOne: {
        filter: { _id: id },
        update: { $set: { order: index } },
      },
    });
  });
  return ops;
}

/**
 * Build the filter that identifies the list a document belongs to.
 *
 * `scopeFields` is the list of fields that partition the collection — ['group']
 * for members, ['kind'] for research, [] for a collection that is one list.
 * A field missing from the document is matched as absent rather than skipped,
 * so a row with no group does not silently join every group's list.
 */
function scopeFilter(doc, scopeFields) {
  const filter = {};
  for (const field of scopeFields || []) {
    const value = doc && doc[field];
    filter[field] = value === undefined || value === null || value === '' ? null : value;
  }
  return filter;
}

module.exports = { placeAt, renumberOps, scopeFilter };
