'use strict';

const express = require('express');
const Profile = require('../models/Profile');
const { DEFAULT_ORDER } = require('../lib/cv');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Fields the editor may set. An allow-list, for the same reason the CRUD
// router has one: a crafted request must not be able to reach _id, timestamps,
// or whatever the schema gains later.
const TEXT = [
  'name', 'title', 'affiliation', 'email', 'email2', 'phone',
  'scholarUrl', 'orcid', 'linkedin', 'webpage',
  'researchInterests', 'skills',
];
const ENTRY_LISTS = ['appointments', 'education', 'certifications', 'awards'];
const BULLET_LISTS = ['qualifications', 'service', 'training'];

/** Keep only keys the generator knows, in the order given, without duplicates. */
function resolveSectionKeys(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const key = String(raw || '').trim();
    if (!key || seen.has(key) || !DEFAULT_ORDER.includes(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function cleanEntry(row, index) {
  return {
    title: String((row && row.title) || '').trim().slice(0, 200),
    org: String((row && row.org) || '').trim().slice(0, 200),
    period: String((row && row.period) || '').trim().slice(0, 80),
    detail: String((row && row.detail) || '').trim().slice(0, 300),
    order: Number.isFinite(Number(row && row.order)) ? Number(row.order) : index,
  };
}

function cleanBullet(row, index) {
  return {
    label: String((row && row.label) || '').trim().slice(0, 200),
    text: String((row && row.text) || '').trim().slice(0, 600),
    order: Number.isFinite(Number(row && row.order)) ? Number(row.order) : index,
  };
}

function normalise(body) {
  const out = {};
  if (!body || typeof body !== 'object') return out;

  for (const key of TEXT) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    out[key] = String(body[key] == null ? '' : body[key]).trim();
  }

  for (const key of ENTRY_LISTS) {
    if (!Array.isArray(body[key])) continue;
    // A row with nothing in it is a row the editor left blank, not data.
    out[key] = body[key].map(cleanEntry).filter((r) => r.title || r.org || r.detail);
  }

  for (const key of BULLET_LISTS) {
    if (!Array.isArray(body[key])) continue;
    out[key] = body[key].map(cleanBullet).filter((r) => r.label || r.text);
  }

  // Validated against the generator's own catalogue, so a typo cannot store a
  // section that will never render.
  if (Array.isArray(body.cvSections)) {
    out.cvSections = resolveSectionKeys(body.cvSections);
  }

  return out;
}

/** GET /api/profile — admin only: this carries a phone number the site omits. */
router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const doc = await Profile.findById('current').lean();
    res.json(doc || { _id: 'current' });
  } catch (err) {
    next(err);
  }
});

/** PUT /api/profile — upsert the single document. */
router.put('/', requireAdmin, async (req, res, next) => {
  try {
    const doc = await Profile.findByIdAndUpdate(
      'current',
      { $set: normalise(req.body) },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    ).lean();
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.normalise = normalise;
