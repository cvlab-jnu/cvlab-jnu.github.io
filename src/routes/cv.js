'use strict';

const express = require('express');
const Member = require('../models/Member');
const ResearchItem = require('../models/ResearchItem');
const Course = require('../models/Course');
const Metrics = require('../models/Metrics');
const Profile = require('../models/Profile');
const { buildCv, CV_SECTIONS, resolveSections } = require('../lib/cv');
const { publicCors } = require('../middleware/cors');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

/** Everything the CV is built from, in the shape buildCv expects. */
async function gather() {
  const visible = { visible: { $ne: false } };

  const [profile, members, research, courses, metrics] = await Promise.all([
    Profile.findById('current').lean(),
    Member.find(visible).sort({ order: 1, name: 1 }).lean(),
    ResearchItem.find(visible).sort({ order: 1, year: -1, _id: 1 }).lean(),
    Course.find(visible).sort({ order: 1, title: 1 }).lean(),
    Metrics.findById('current').lean(),
  ]);

  const by = (rows, key) => {
    const out = {};
    for (const r of rows) (out[r[key]] = out[r[key]] || []).push(r);
    return out;
  };

  const grouped = by(members, 'group');
  delete grouped.pi;                 // the lab in-charge is the subject, not a supervisee

  return {
    profile: profile || {},
    members: grouped,
    research: by(research, 'kind'),
    courses,
    metrics: metrics || {},
  };
}

/**
 * GET /api/cv  (public)
 *
 * Generates the PDF on each request rather than storing one. The CV is derived
 * data — the moment a publication is added it is out of date — so a cached copy
 * would be one more thing to remember to refresh. Generation takes well under a
 * second, and the static snapshot takes its own copy at publish time, so the
 * public site is not asking for this on every visit.
 */
router.get('/', publicCors, async (req, res, next) => {
  try {
    const data = await gather();

    // A ?sections= list formats this one download without changing anything.
    // Without it, the saved default applies; without that, everything.
    const sections = req.query.sections
      ? resolveSections(req.query.sections)
      : resolveSections((data.profile.cvSections || []).length ? data.profile.cvSections : null);

    const name = String(data.profile.name || 'Curriculum Vitae')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'Curriculum_Vitae';
    const filename = name + '_CV.pdf';

    res.set({
      'Content-Type': 'application/pdf',
      // inline so a click opens it in the browser's viewer; the filename is
      // still what a "save as" offers.
      'Content-Disposition': 'inline; filename="' + filename + '"',
      'X-Content-Type-Options': 'nosniff',
      // Derived from data that changes, so only a short cache.
      'Cache-Control': 'public, max-age=300',
      Vary: 'Origin',
    });

    const doc = buildCv(data, { sections });
    doc.pipe(res);
    doc.end();
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/cv/data  (admin)
 *
 * What the generator will read, without generating. Useful for checking a
 * section is empty because the data is missing rather than because the layout
 * dropped it.
 */
router.get('/data', requireAdmin, async (req, res, next) => {
  try {
    const data = await gather();
    res.json({
      profile: data.profile,
      counts: {
        appointments: (data.profile.appointments || []).length,
        education: (data.profile.education || []).length,
        qualifications: (data.profile.qualifications || []).length,
        service: (data.profile.service || []).length,
        awards: (data.profile.awards || []).length,
        training: (data.profile.training || []).length,
        courses: data.courses.length,
        research: Object.fromEntries(
          Object.entries(data.research).map(([k, v]) => [k, v.length])
        ),
        members: Object.fromEntries(
          Object.entries(data.members).map(([k, v]) => [k, v.length])
        ),
      },
    });
  } catch (err) {
    next(err);
  }
});

/** GET /api/cv/sections (admin) — the catalogue the picker is built from. */
router.get('/sections', requireAdmin, async (req, res, next) => {
  try {
    const profile = await Profile.findById('current').lean();
    res.json({
      sections: CV_SECTIONS,
      selected: (profile && profile.cvSections) || [],
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.gather = gather;
