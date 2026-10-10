'use strict';

const { Schema, model } = require('mongoose');

/**
 * The parts of a CV that are not already in the database.
 *
 * Publications, supervision, teaching and the citation metrics all live in
 * their own collections, and the generated CV reads them from there. Education,
 * past appointments, administrative service, awards and training have until now
 * existed only as hand-written markup on the Lab In-charge page, so there was
 * nothing for a generated CV to read. This holds them.
 *
 * A single pinned document, like Metrics — there is one lab in-charge, so a
 * collection of profiles would be a collection of one.
 */

/** "Ph.D. in Computer Science and Engineering — IIT (BHU) Varanasi, 2017–2021" */
const EntrySchema = new Schema(
  {
    _id: false,
    // The bold line: a degree, a job title, an award.
    title: { type: String, trim: true, default: '', maxlength: 200 },
    // The institution or employer beneath it.
    org: { type: String, trim: true, default: '', maxlength: 200 },
    // Right-aligned on its row: "2017 – 2021", "March 2023 – Present".
    period: { type: String, trim: true, default: '', maxlength: 80 },
    // A third line, for a grade, a defence date, an application number.
    detail: { type: String, trim: true, default: '', maxlength: 300 },
    order: { type: Number, default: 0 },
  },
  { _id: false }
);

/** A plain bullet, optionally with a bold lead-in before the dash. */
const BulletSchema = new Schema(
  {
    _id: false,
    label: { type: String, trim: true, default: '', maxlength: 200 },
    text: { type: String, trim: true, default: '', maxlength: 600 },
    order: { type: Number, default: 0 },
  },
  { _id: false }
);

const ProfileSchema = new Schema(
  {
    _id: { type: String, default: 'current' },

    // ---- header -------------------------------------------------------
    name: { type: String, trim: true, default: '', maxlength: 160 },
    title: { type: String, trim: true, default: '', maxlength: 200 },
    affiliation: { type: String, trim: true, default: '', maxlength: 300 },

    // Shown on the CV only. The public pages deliberately omit a personal
    // mobile number and private address; putting one here puts it in a
    // document anyone can download, so leave it empty unless that is intended.
    email: { type: String, trim: true, default: '', maxlength: 160 },
    // A personal address alongside the institutional one. Separate fields
    // rather than one comma-joined string, so either can be removed on its own.
    email2: { type: String, trim: true, default: '', maxlength: 160 },
    phone: { type: String, trim: true, default: '', maxlength: 60 },
    scholarUrl: { type: String, trim: true, default: '', maxlength: 400 },
    orcid: { type: String, trim: true, default: '', maxlength: 120 },
    linkedin: { type: String, trim: true, default: '', maxlength: 200 },
    webpage: { type: String, trim: true, default: '', maxlength: 400 },

    researchInterests: { type: String, trim: true, default: '', maxlength: 1200 },

    // ---- sections -----------------------------------------------------
    appointments: [EntrySchema],
    education: [EntrySchema],
    qualifications: [BulletSchema],
    service: [BulletSchema],

    // "NPTEL Elite — Deep Learning, IIT Madras, 2021"
    certifications: [EntrySchema],

    // Prizes, best-paper awards, fellowships, recognitions.
    awards: [EntrySchema],

    training: [BulletSchema],

    // Free text, comma separated, rendered as one paragraph.
    skills: { type: String, trim: true, default: '', maxlength: 1200 },

    // Which sections the download button produces, in order. Empty means
    // every section in its default order, so an untouched site behaves as it
    // did before this existed.
    cvSections: [{ type: String, trim: true, maxlength: 40 }],
  },
  { timestamps: true, _id: false }
);

module.exports = model('Profile', ProfileSchema);
