'use strict';

/**
 * Build the curriculum vitae as a PDF, from the database.
 *
 * TYPOGRAPHY
 * ----------
 * The fonts are the real Computer Modern Unicode serif faces — the same
 * typeface LaTeX sets by default — so the result reads as a LaTeX document
 * rather than as a word processor imitating one.
 *
 * They are vendored in assets/fonts/ rather than pulled from npm: the package
 * that carries them ships every CMU variant in two formats, nineteen megabytes
 * to use four files. These four are two megabytes, they are under the SIL Open
 * Font License (assets/fonts/OFL.txt), and vendoring means the deploy cannot
 * break because a package was unpublished.
 *
 * pdfkit subsets them, so the generated PDF carries only the glyphs it uses —
 * a six-page CV comes out around 50 kB, fonts included.
 *
 * The layout follows the conventions of the article class: a centred title
 * block, section headings in small caps weight above a rule, ragged-right body
 * text, and a running footer with "Page n of m".
 *
 * WHERE THE CONTENT COMES FROM
 * ----------------------------
 * Publications, supervision, teaching and the citation figures are read from
 * the collections that already hold them, so the CV cannot drift from the
 * website. Education, appointments, service, awards and training come from the
 * Profile document, which exists because those have no other home.
 */

const path = require('path');
const PDFDocument = require('pdfkit');

const FONT_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const FONTS = {
  roman: path.join(FONT_DIR, 'cmu-serif-500-roman.ttf'),
  bold: path.join(FONT_DIR, 'cmu-serif-700-roman.ttf'),
  italic: path.join(FONT_DIR, 'cmu-serif-500-italic.ttf'),
  boldItalic: path.join(FONT_DIR, 'cmu-serif-700-italic.ttf'),
};

// The blue LaTeX uses for section rules and hyperlinks in this style of CV.
const RULE = '#2a5d8f';
const LINK = '#2a5d8f';
const INK = '#000000';

const MARGIN = 56;          // ~20mm, close to the article class default
const SIZE = { body: 10, head: 12, name: 19, small: 8.5 };


/**
 * Every section the CV can contain, in its default order.
 *
 * This list is the contract between the generator and the editor: the picker
 * is built from it, the renderer map is keyed by it, and the route validates
 * against it. Adding a section means adding it here once.
 *
 * `always` marks the sections that make a CV a CV. They can still be turned
 * off, but the editor warns rather than treating it as routine.
 */
const CV_SECTIONS = [
  { key: 'profile', label: 'Academic and Research Profile', always: true },
  { key: 'experience', label: 'Academic Experience', always: true },
  { key: 'education', label: 'Education', always: true },
  { key: 'courses', label: 'Courses Handling' },
  { key: 'publications', label: 'Research Publications', always: true },
  { key: 'talks', label: 'Invited Talks and Sessions Chaired' },
  { key: 'events', label: 'Events Organized' },
  { key: 'service', label: 'Administrative Responsibilities' },
  { key: 'certifications', label: 'Professional Certifications' },
  { key: 'awards', label: 'Awards and Achievements' },
  { key: 'training', label: 'Professional Training and Workshops' },
  { key: 'skills', label: 'Skills and Tools' },
];

const DEFAULT_ORDER = CV_SECTIONS.map((s) => s.key);

/**
 * Turn whatever the caller asked for into a clean list of section keys.
 *
 * Unknown keys are dropped rather than rejected: a stale bookmark with a
 * section that no longer exists should still produce a CV. Duplicates are
 * collapsed. An empty or absent request means everything, in default order.
 */
function resolveSections(requested) {
  if (!requested) return DEFAULT_ORDER.slice();

  const asked = Array.isArray(requested)
    ? requested
    : String(requested).split(',');

  const seen = new Set();
  const out = [];
  for (const raw of asked) {
    const key = String(raw || '').trim();
    if (!key || seen.has(key) || !DEFAULT_ORDER.includes(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out.length ? out : DEFAULT_ORDER.slice();
}

/**
 * @param {object} data  { profile, members, research, courses, metrics }
 * @returns {PDFDocument} a streaming document; the caller pipes and ends it
 */
function buildCv(data, options) {
  const opts = options || {};
  const chosen = resolveSections(opts.sections);

  const profile = data.profile || {};
  const metrics = data.metrics || {};
  const research = data.research || {};
  const members = data.members || {};
  const courses = data.courses || [];

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: MARGIN, bottom: MARGIN + 14, left: MARGIN, right: MARGIN },
    bufferPages: true,            // needed to number pages once the total is known
    info: {
      Title: (profile.name || 'Curriculum Vitae') + ' — Curriculum Vitae',
      Author: profile.name || '',
      Subject: 'Curriculum Vitae',
      Creator: 'Computing and Vision Lab, JNU',
    },
  });

  doc.registerFont('cm', FONTS.roman);
  doc.registerFont('cm-b', FONTS.bold);
  doc.registerFont('cm-i', FONTS.italic);
  doc.registerFont('cm-bi', FONTS.boldItalic);
  doc.font('cm').fontSize(SIZE.body).fillColor(INK);

  const W = doc.page.width - MARGIN * 2;

  // ---------------------------------------------------------------- helpers

  /** A section heading: blue, bold, with a rule beneath — the LaTeX look. */
  function section(title) {
    // Reserve enough for the heading, its rule AND the first couple of lines
    // under it. A heading stranded at the foot of a page, with its content
    // starting on the next, reads as a mistake — and with the fuller course
    // entries the old reserve was no longer enough.
    const limit = doc.page.height - doc.page.margins.bottom;
    if (doc.y + 95 > limit) doc.addPage();
    doc.moveDown(0.6);
    doc.font('cm-b').fontSize(SIZE.head).fillColor(RULE).text(title, MARGIN, doc.y);
    const y = doc.y + 1.5;
    doc.moveTo(MARGIN, y).lineTo(MARGIN + W, y).lineWidth(0.7).strokeColor(RULE).stroke();
    doc.moveDown(0.45);
    doc.font('cm').fontSize(SIZE.body).fillColor(INK);
  }

  /** A row with text on the left and a period right-aligned on the same line. */
  function titleRow(left, right) {
    doc.font('cm-b').fontSize(SIZE.body);
    // Keep the title, its organisation and its detail line together: a degree
    // split across a page break reads as two incomplete entries.
    ensureSpace(doc.heightOfString(left, { width: W * 0.68 }) + 34);

    const startY = doc.y;
    doc.font('cm-b').fontSize(SIZE.body).fillColor(INK);
    if (right) {
      doc.text(right, MARGIN, startY, { width: W, align: 'right' });
      doc.y = startY;
    }
    doc.text(left, MARGIN, startY, { width: W * 0.68 });
    doc.y = Math.max(doc.y, startY + doc.currentLineHeight());
  }

  function line(text, opts) {
    if (!text) return;
    const o = opts || {};
    doc.font(o.font || 'cm').fontSize(o.size || SIZE.body).fillColor(o.color || INK)
      .text(text, MARGIN + (o.indent || 0), doc.y, {
        width: W - (o.indent || 0),
        align: o.align || 'left',
      });
  }

  /**
   * Is there room for `need` points of content before the bottom margin?
   * If not, start a page.
   *
   * Anything that draws a marker and its text as two calls has to ask this
   * first. pdfkit breaks pages between calls, not between logical items, so
   * without it a bullet can land at the foot of one page and its text at the
   * top of the next — or, when the marker alone triggers the break, the text
   * is written off the page entirely and silently lost.
   */
  function ensureSpace(need) {
    const limit = doc.page.height - doc.page.margins.bottom;
    if (doc.y + need > limit) doc.addPage();
  }

  /** A bulleted item, with an optional bold lead-in before an en dash. */
  function bullet(label, text) {
    const x = MARGIN + 12;
    const width = W - 12;

    doc.font('cm').fontSize(SIZE.body);
    const probe = (label ? label + ' \u2014 ' : '') + (text || '');
    ensureSpace(doc.heightOfString(probe, { width }) + 4);

    const y = doc.y;

    doc.font('cm').fontSize(SIZE.body).fillColor(INK).text('•', MARGIN + 2, y, { width: 10 });
    doc.y = y;

    if (label) {
      doc.font('cm-b').text(label, x, y, { width, continued: Boolean(text) });
      if (text) doc.font('cm').text(' — ' + text, { width });
    } else {
      doc.font('cm').text(text || '', x, y, { width });
    }
    doc.moveDown(0.15);
  }

  /** Entries sorted by their order field, with blanks dropped. */
  function rows(list) {
    return (Array.isArray(list) ? list : [])
      .filter((r) => r && (r.title || r.text || r.label))
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  // ----------------------------------------------------------------- header

  doc.font('cm-b').fontSize(SIZE.name).fillColor('#1b3a5c')
    .text(profile.name || 'Curriculum Vitae', MARGIN, MARGIN, { width: W, align: 'center' });
  doc.moveDown(0.25);

  if (profile.title) {
    doc.font('cm-b').fontSize(SIZE.body + 1).fillColor(INK)
      .text(profile.title, { width: W, align: 'center' });
  }
  if (profile.affiliation) {
    doc.font('cm').fontSize(SIZE.body).fillColor(INK)
      .text(profile.affiliation, { width: W, align: 'center' });
  }

  // Contact line. Only what is actually set — an empty separator is worse than
  // a missing field.
  const contact = [profile.email, profile.email2, profile.phone].filter(Boolean);
  if (contact.length) {
    doc.moveDown(0.2);
    doc.font('cm').fontSize(SIZE.small).fillColor(LINK)
      .text(contact.join('    |    '), { width: W, align: 'center' });
  }

  const links = [];
  if (profile.linkedin) links.push('LinkedIn: ' + profile.linkedin);
  if (profile.webpage) links.push('Webpage: ' + profile.webpage);
  if (profile.orcid) links.push('ORCID: ' + profile.orcid);
  if (links.length) {
    doc.font('cm').fontSize(SIZE.small).fillColor(LINK)
      .text(links.join('    |    '), { width: W, align: 'center' });
  }
  doc.fillColor(INK);
  doc.moveDown(0.5);

  // ------------------------------------------------------- shared helpers

  /** A labelled row: bold label in the left column, value in the right. */
  function labelled(label, value) {
    if (!value) return;
    const y = doc.y;
    doc.font('cm-b').fontSize(SIZE.body).fillColor(INK).text(label, MARGIN, y, { width: 130 });
    doc.y = y;
    doc.font('cm').text(value, MARGIN + 140, y, { width: W - 140, align: 'justify' });
    doc.moveDown(0.15);
  }

  /** "03" rather than "3" — supervision counts read as records, not arithmetic. */
  function pad2(n) {
    const v = Number(n);
    return Number.isFinite(v) ? (v < 10 ? '0' + v : String(v)) : null;
  }

  /** A bold sub-label inside a section, used for its internal divisions. */
  function subhead(text) {
    const limit = doc.page.height - doc.page.margins.bottom;
    if (doc.y + 70 > limit) doc.addPage();
    doc.moveDown(0.25);
    doc.font('cm-b').fontSize(SIZE.body + 0.5).fillColor(INK)
      .text(text, MARGIN, doc.y, { width: W });
    doc.moveDown(0.2);
    doc.font('cm').fontSize(SIZE.body);
  }

  // ----------------------------------------------------------- publications

  /**
   * Render one list of research entries under a bold sub-label.
   *
   * Every item in the collection is rendered — the CV is a complete record, so
   * nothing is truncated and no "and N more" is appended. A long list simply
   * runs onto the next page.
   */
  function entryList(kind, label, style) {
    const list = (research[kind] || []).filter((r) => r && r.title);
    if (!list.length) return 0;

    // A section with exactly one list needs no sub-label repeating its heading.
    if (label) subhead(label);

    list.forEach((item, i) => {
      const x = MARGIN + 16;
      const width = W - 16;

      doc.font('cm').fontSize(SIZE.body);
      const probe = [item.authors, item.title, item.venue, item.detail, item.doi]
        .filter(Boolean).join(', ');
      ensureSpace(doc.heightOfString(probe, { width }) + 6);

      const y = doc.y;

      doc.font('cm').fontSize(SIZE.body).fillColor(INK);
      doc.text(style === 'numbered' ? (i + 1) + '.' : '\u2022', MARGIN + 2, y, { width: 14 });
      doc.y = y;

      // Assemble the reference as segments first, so the punctuation between
      // them can be decided once. Emitting as we go is what produced
      // "\u2026202211038984, ." \u2014 a separator printed after the last piece.
      const isPaper = kind === 'journal' || kind === 'chapter' ||
                      kind === 'conference' || kind === 'patent';

      // Strip punctuation an author already typed at the end of a field.
      // Several entries carry the date inside the venue, ending with a full
      // stop; appending ", 2026." to that gave "15\u201317 May 2026., 2026."
      const tidy = (v) => String(v == null ? '' : v).trim().replace(/[.,;\s]+$/, '');

      const segs = [];
      if (item.authors) segs.push({ t: tidy(item.authors), f: 'cm' });

      // A paper's title is quoted with the comma inside the quotes, as in any
      // bibliography. A talk or a chaired session is not a paper, so quoting it
      // would misrepresent what it is.
      segs.push(isPaper
        ? { t: '\u201C' + tidy(item.title) + ',\u201D', f: 'cm', ownComma: true }
        : { t: tidy(item.title), f: 'cm' });

      if (item.venue) segs.push({ t: tidy(item.venue), f: 'cm-i' });
      if (item.detail) segs.push({ t: tidy(item.detail), f: 'cm' });

      // Skip a bare year that the text already ends with \u2014 a venue reading
      // "\u2026 Galgotias University, 15\u201317 May 2026" needs no ", 2026" after it.
      const when = tidy(item.date) || (item.year ? String(item.year) : '');
      const soFar = segs.map((x) => x.t).join(' ');
      if (when && !new RegExp('\\b' + when.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$').test(soFar)) {
        segs.push({ t: when, f: 'cm' });
      }
      if (item.doi) segs.push({ t: tidy(item.doi).replace(/^/, 'DOI: '), f: 'cm' });

      segs.forEach((seg, n) => {
        const last = n === segs.length - 1;
        // The separator belongs to the gap BEFORE the next segment, and the
        // comma is skipped when the previous segment already carried one.
        const tail = last ? '.' : (seg.ownComma ? ' ' : ', ');

        // The separator goes in the SAME call as the text it follows. Emitted
        // as its own run it can wrap alone, leaving a comma stranded at the
        // start of a line \u2014 which looks worse than an italic comma does.
        doc.font(seg.f);
        if (n === 0) doc.text(seg.t + tail, x, y, { width, continued: !last });
        else doc.text(seg.t + tail, { width, continued: !last });
      });

      doc.moveDown(0.2);
    });

    return list.length;
  }
  const count = (kind) => (research[kind] || []).filter((r) => r && r.title).length;

  // ------------------------------------------------------------- sections
  //
  // One renderer per section, keyed by the same identifiers CV_SECTIONS
  // uses. The picker in the editor is built from that list, so a section
  // cannot appear in the interface without a renderer behind it, or be
  // rendered without appearing in the interface.
  const renderers = {
    profile() {
    const hasMetrics = metrics && (metrics.citations != null || metrics.hIndex != null);
    const hasSupervision = metrics &&
      (metrics.phdScholars != null || metrics.mtechSupervised != null);

    if (profile.researchInterests || hasMetrics || hasSupervision) {
      section('Academic and Research Profile');

      if (profile.title || profile.affiliation) {
        labelled('Current Position', [profile.title, profile.affiliation].filter(Boolean).join(', '));
      }

      labelled('Research Interests', profile.researchInterests);

      if (hasMetrics) {
        const bits = [];
        if (metrics.hIndex != null) bits.push('h-index: ' + metrics.hIndex);
        if (metrics.i10Index != null) bits.push('i10-index: ' + metrics.i10Index);
        if (metrics.citations != null) bits.push('Citations: ' + metrics.citations);
        const asOf = metrics.asOf
          ? '    (' + (metrics.source || 'Source') + ', as of ' + metrics.asOf + ')'
          : '';
        labelled('Scholar Metrics', bits.join('    |    ') + asOf);
      }

      // Supervision is a count here rather than a list of names: the scholars are
      // on the website, and a CV reader wants the scale, not the roster.
      const phd = pad2(metrics.phdScholars);
      if (phd) labelled('Ph.D. Supervision', phd + ' scholars currently supervising');

      const mtech = pad2(metrics.mtechSupervised);
      if (mtech) labelled('M.Tech. Supervision', mtech + ' students supervised');

      if (profile.patentsNote) labelled('Patents', profile.patentsNote);
    }
    },

    experience() {
    const appts = rows(profile.appointments);
    if (appts.length) {
      section('Academic Experience');
      for (const a of appts) {
        titleRow(a.title, a.period);
        if (a.org) line(a.org);
        if (a.detail) line(a.detail, { font: 'cm-i', size: SIZE.small });
        doc.moveDown(0.25);
      }
    }
    },

    education() {
    // Degrees and the national qualifications sit under one heading: they answer
    // the same question, and two headings for five lines was heading-heavy.
    const edu = rows(profile.education);
    const quals = rows(profile.qualifications);

    if (edu.length || quals.length) {
      section('Education');

      for (const e of edu) {
        titleRow(e.title, e.period);
        if (e.org) line(e.org);
        if (e.detail) line(e.detail, { font: 'cm-i', size: SIZE.small });
        doc.moveDown(0.25);
      }

      if (quals.length) {
        subhead('National Level Qualifications');
        for (const q of quals) bullet(q.label, q.text);
      }
    }
    },

    courses() {
    const teaching = (courses || []).filter((c) => c && c.title);
    if (teaching.length) {
      section('Courses Handling');
      // Name and programme only. The unit outlines live on the website, where
      // they can be kept current; repeating them here made the CV a syllabus.
      for (const c of teaching) {
        bullet(c.title, [c.designation, c.level].filter(Boolean).join(', '));
      }
    }
    },

    publications() {
    const PUBS = [
      ['patent', 'Granted Patents', 'bullet'],
      ['journal', 'Peer-Reviewed Journals', 'numbered'],
      ['chapter', 'Book Chapters', 'numbered'],
      ['conference', 'Conference Publications', 'numbered'],
    ];

    if (PUBS.some(([k]) => count(k))) {
      section('Research Publications');
      for (const [kind, label, style] of PUBS) entryList(kind, label, style);
    }
    },

    talks() {
    // Talks and chaired sessions are participation rather than publication, so
    // they share a heading of their own with a sub-label each.
    if (count('talk') || count('chaired')) {
      section('Invited Talks and Sessions Chaired');
      entryList('talk', 'Invited Talks', 'numbered');
      entryList('chaired', 'Sessions Chaired', 'numbered');
    }
    },

    events() {
    if (count('organized')) {
      section('Events Organized');
      entryList('organized', null, 'numbered');
    }
    },

    service() {
    const service = rows(profile.service);
    if (service.length) {
      section('Administrative Responsibilities');
      for (const s of service) bullet(s.label, s.text);
    }
    },

    certifications() {
    const certs = rows(profile.certifications);
    if (certs.length) {
      section('Professional Certifications');
      for (const c of certs) {
        titleRow(c.title, c.period);
        if (c.org) line(c.org);
        if (c.detail) line(c.detail, { font: 'cm-i', size: SIZE.small });
        doc.moveDown(0.2);
      }
    }
    },

    awards() {
    const awards = rows(profile.awards);
    if (awards.length) {
      section('Awards and Achievements');
      for (const a of awards) {
        titleRow(a.title, a.period);
        if (a.org) line(a.org);
        if (a.detail) line(a.detail, { font: 'cm-i', size: SIZE.small });
        doc.moveDown(0.2);
      }
    }
    },

    training() {
    const training = rows(profile.training);
    if (training.length) {
      section('Professional Training and Workshops');
      for (const t of training) bullet(t.label, t.text);
    }
    },

    skills() {
    if (profile.skills) {
      section('Skills and Tools');
      doc.font('cm').fontSize(SIZE.body).text(profile.skills, MARGIN, doc.y, {
        width: W, align: 'justify',
      });
    }
    },

  };

  // Render the chosen sections, in the chosen order. A section whose data is
  // empty draws nothing, so an unused one costs no blank heading.
  for (const key of chosen) {
    const fn = renderers[key];
    if (fn) fn();
  }

  // ---------------------------------------------------------------- footers

  // bufferPages lets this run after the content is laid out, which is the only
  // point at which the page total is known.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);

    // The footer sits BELOW the bottom margin, which is the one place pdfkit
    // will not write into — text placed there is clipped, or worse, triggers a
    // new page. Dropping the margin for the duration is what lets it print.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const y = doc.page.height - MARGIN + 6;
    doc.moveTo(MARGIN, y - 8).lineTo(doc.page.width - MARGIN, y - 8)
      .lineWidth(0.4).strokeColor('#999999').stroke();

    doc.font('cm').fontSize(SIZE.small).fillColor('#444444');
    doc.text(profile.name || '', MARGIN, y, { width: W * 0.6, lineBreak: false });
    doc.text('Page ' + (i + 1) + ' of ' + range.count, MARGIN, y, {
      width: W, align: 'right', lineBreak: false,
    });

    doc.page.margins.bottom = savedBottom;
  }

  doc.flushPages();
  return doc;
}

module.exports = { buildCv, FONTS, CV_SECTIONS, DEFAULT_ORDER, resolveSections };
