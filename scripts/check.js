#!/usr/bin/env node
'use strict';

/**
 * Offline checks — everything that can be verified without a running MongoDB.
 *
 *   npm run check
 *
 * Validates every seed document against its schema, boots the real Express app,
 * and confirms the routes, security headers and authorisation refusals behave.
 * `npm run smoke` is the fuller test and needs a database.
 */

const assert = require('assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'y'.repeat(64);
process.env.NODE_ENV = 'test';

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failed++;
    console.error('  FAIL ' + name + '\n         ' + err.message);
  }
}

async function main() {
  const Member = require('../src/models/Member');
  const ResearchItem = require('../src/models/ResearchItem');
  const Course = require('../src/models/Course');
  const Metrics = require('../src/models/Metrics');
  const AdminUser = require('../src/models/AdminUser');
  const Photo = require('../src/models/Photo');
  const seed = require('./seed-data.json');

  console.log('seed data against the schemas');

  await check(`all ${seed.members.length} members validate`, () => {
    for (const m of seed.members) {
      const err = new Member(m).validateSync();
      if (err) throw new Error(`${m.name}: ${err.message}`);
    }
  });

  await check(`all ${seed.research.length} research items validate`, () => {
    for (const r of seed.research) {
      const err = new ResearchItem(r).validateSync();
      if (err) throw new Error(`${r.kind} "${String(r.title).slice(0, 40)}": ${err.message}`);
    }
  });

  await check(`all ${seed.courses.length} courses validate`, () => {
    for (const c of seed.courses) {
      const err = new Course(c).validateSync();
      if (err) throw new Error(`${c.slug}: ${err.message}`);
    }
  });

  await check('a gallery item validates and requires a photo', () => {
    const GalleryItem = require('../src/models/GalleryItem');
    assert.ok(new GalleryItem({ photo: '/api/photos/abc', caption: 'Group, 2026' }).validateSync() === undefined);
    const err = new GalleryItem({ caption: 'no image' }).validateSync();
    assert.ok(err && err.errors.photo, 'a gallery item with no photo validated');
  });

  await check('a course resource accepts an uploaded file reference', () => {
    const doc = new Course({
      slug: 'tst', title: 'Test',
      resources: [{ kind: 'Slides', item: 'Unit I', fileUrl: '/api/files/abc',
                    fileName: 'unit1.pdf', fileBytes: 240000 }],
    });
    assert.strictEqual(doc.validateSync(), undefined);
    assert.strictEqual(doc.resources[0].fileBytes, 240000);
  });

  await check('a research item accepts a figure', () => {
    const doc = new ResearchItem({
      kind: 'journal', title: 'T', image: '/api/photos/abc', imageCaption: 'Pipeline',
    });
    assert.strictEqual(doc.validateSync(), undefined);
  });

  await check('metrics document validates', () => {
    const err = new Metrics(seed.metrics).validateSync();
    if (err) throw new Error(err.message);
  });

  console.log('\nseed content is complete');

  await check('research counts match the source site', () => {
    const by = {};
    for (const r of seed.research) by[r.kind] = (by[r.kind] || 0) + 1;
    assert.strictEqual(by.journal, 8, 'journals: ' + by.journal);
    assert.strictEqual(by.conference, 14, 'conferences: ' + by.conference);
    assert.strictEqual(by.chapter, 2, 'chapters: ' + by.chapter);
    assert.strictEqual(by.talk, 13, 'talks: ' + by.talk);
    assert.strictEqual(by.patent, 1, 'patents: ' + by.patent);
    assert.strictEqual(by.theme, 8, 'themes: ' + by.theme);
    assert.ok(by.organized >= 2 && by.chaired >= 7, 'events/chaired counts low');
  });

  await check('every publication kept its DOI', () => {
    const withDoi = seed.research.filter((r) => r.kind === 'journal' && r.doi);
    assert.strictEqual(withDoi.length, 8, 'only ' + withDoi.length + ' journals have DOIs');
    for (const r of withDoi) {
      assert.match(r.doi, /^10\.\d{4,}\//, 'malformed DOI: ' + r.doi);
    }
  });

  await check('every publication kept its authors and venue', () => {
    for (const r of seed.research) {
      if (!['journal', 'conference', 'chapter'].includes(r.kind)) continue;
      assert.ok(r.authors && r.authors.length > 5, 'no authors on: ' + r.title);
      assert.ok(r.venue && r.venue.length > 5, 'no venue on: ' + r.title);
      assert.ok(/Jaiswal/.test(r.authors), 'author list lost Jaiswal: ' + r.title);
    }
  });

  await check('courses carry units, materials and reading', () => {
    for (const c of seed.courses) {
      assert.ok(c.units.length >= 6, c.slug + ' has only ' + c.units.length + ' units');
      assert.ok(c.resources.length >= 5, c.slug + ' has only ' + c.resources.length + ' resources');
      assert.ok(c.reading.split('\n').filter(Boolean).length >= 3, c.slug + ' has thin reading list');
      assert.ok(c.description.length > 40, c.slug + ' has no description');
    }
  });

  await check('the lab in-charge is seeded as a member', () => {
    const pis = seed.members.filter((m) => m.group === 'pi');
    assert.strictEqual(pis.length, 1, 'expected exactly one pi member, got ' + pis.length);
    assert.match(pis[0].name, /Jaiswal/);
    assert.ok('photo' in pis[0], 'pi record has no photo field');
  });

  await check('the three named scholars are present with topics', () => {
    const names = seed.members.map((m) => m.name).join(' | ');
    for (const who of ['Archana Singh', 'Soha Muskaan Sayyad', 'Aman Gupta']) {
      assert.ok(names.includes(who), 'missing scholar: ' + who);
    }
    for (const m of seed.members) {
      assert.ok(m.topic && m.topic.length > 20, 'no topic for ' + m.name);
    }
  });

  console.log('\npassword handling');

  await check('bcrypt hashes and verifies, and never stores plaintext', async () => {
    const pw = 'a-long-enough-test-passphrase';
    const hash = await AdminUser.hashPassword(pw);
    assert.match(hash, /^\$2[aby]\$\d{2}\$/, 'not a bcrypt hash');
    assert.ok(!hash.includes(pw));
    const u = new AdminUser({ username: 'x', passwordHash: hash });
    assert.strictEqual(await u.verifyPassword(pw), true);
    assert.strictEqual(await u.verifyPassword(pw + '!'), false);
  });

  await check('passwordHash is not selected by default', () => {
    assert.strictEqual(AdminUser.schema.path('passwordHash').options.select, false);
  });

  console.log('\nphotograph storage');

  await check('the Photo schema rejects a non-image content type', () => {
    const bad = new Photo({ data: Buffer.from('x'), contentType: 'text/html' });
    const err = bad.validateSync();
    assert.ok(err && err.errors.contentType, 'text/html was accepted as a photo type');
  });

  await check('the Photo schema requires actual bytes', () => {
    const err = new Photo({ contentType: 'image/jpeg' }).validateSync();
    assert.ok(err && err.errors.data, 'a photo with no data validated');
  });

  await check('photo bytes are never selected by a metadata listing', () => {
    assert.ok(!Photo.metaFields.includes('data'), 'metaFields would fetch the image bytes');
  });

  await check('sharp re-encodes, strips metadata and enforces a size cap', async () => {
    const sharp = require('sharp');

    // A JPEG carrying EXIF, the way a phone photograph arrives.
    const withExif = await sharp({
      create: { width: 1200, height: 900, channels: 3, background: { r: 20, g: 90, b: 80 } },
    })
      .withExif({ IFD0: { Software: 'TestCam', Copyright: 'somebody' } })
      .jpeg()
      .toBuffer();

    const before = await sharp(withExif).metadata();
    assert.ok(before.exif, 'test fixture has no EXIF, so this proves nothing');

    const out = await sharp(withExif)
      .rotate()
      .resize(600, 600, { fit: 'cover', position: 'attention' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();

    const after = await sharp(out).metadata();
    assert.strictEqual(after.exif, undefined, 'EXIF survived the re-encode');
    assert.strictEqual(after.width, 600);
    assert.strictEqual(after.height, 600);
  });

  await check('a non-image is refused by the decoder, whatever it claims to be', async () => {
    const sharp = require('sharp');
    // A file that is really HTML — the stored-XSS upload attempt.
    const notAnImage = Buffer.from('<html><script>alert(1)</script></html>');
    await assert.rejects(() => sharp(notAnImage).metadata(), 'HTML was accepted as an image');
  });

  await check('a polyglot loses its payload in the re-encode', async () => {
    const sharp = require('sharp');
    // A valid image with a script tag stuffed into a comment field — valid
    // image, valid-ish HTML, the classic polyglot.
    const base = await sharp({
      create: { width: 300, height: 300, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).jpeg().toBuffer();
    const payload = Buffer.from('<script>alert(document.cookie)</script>');
    const polyglot = Buffer.concat([base, payload]);

    assert.ok(polyglot.includes(payload), 'fixture is wrong: payload not present');

    const out = await sharp(polyglot)
      .rotate()
      .resize(600, 600, { fit: 'cover' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();

    assert.ok(!out.includes(payload), 'the script payload survived re-encoding');
  });

  await check('stored image bytes survive a lean query as a real Buffer', () => {
    // The regression this guards against: a .lean() query returns BSON binary
    // as a driver `Binary`, not a Buffer. Express JSON-serialises that object
    // under the image content type, and the browser reports a corrupt image.
    // Caught by nothing else, because it needs a live database to reproduce.
    const { serialize, deserialize } = require('bson');
    const { toBuffer } = require('../src/routes/photos');

    const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const wire = serialize({ data: jpegMagic });

    const raw = deserialize(wire).data;              // driver default
    assert.ok(!Buffer.isBuffer(raw), 'fixture is wrong: bson already gave a Buffer');

    const fixed = toBuffer(raw);
    assert.ok(Buffer.isBuffer(fixed), 'toBuffer did not produce a Buffer');
    assert.strictEqual(typeof fixed.length, 'number', 'Content-Length would be garbage');
    assert.ok(fixed.equals(jpegMagic), 'the bytes changed on the way through');

    // And the already-correct case must pass through untouched.
    assert.ok(toBuffer(jpegMagic).equals(jpegMagic));
    assert.strictEqual(toBuffer(null), null);
  });

  await check('the connection asks the driver for Buffers, not Binary', () => {
    const src = require('fs').readFileSync(require('path')
      .join(__dirname, '..', 'src', 'db.js'), 'utf8');
    assert.ok(/promoteBuffers:\s*true/.test(src),
      'db.js must set promoteBuffers:true or lean() photo reads serve JSON');
  });

  await check('a gallery photograph gets a size budget, a portrait does not', () => {
    const { VARIANTS } = require('../src/routes/photos');
    assert.ok(VARIANTS.gallery.targetBytes >= 100 * 1024,
      'the gallery budget is too mean for a photograph');
    assert.ok(VARIANTS.gallery.width >= 1600, 'gallery images should be large');
    assert.ok(VARIANTS.gallery.thumb >= 500, 'grid thumbnails look soft below 500px');
    assert.ok(!VARIANTS.portrait.targetBytes,
      'a portrait is a fixed crop and needs no budget');
    assert.strictEqual(VARIANTS.gallery.fit, 'inside',
      'a gallery photograph must never be cropped');
  });

  await check('the encoder spends the budget rather than a fixed quality', async () => {
    const sharp = require('sharp');
    const { VARIANTS } = require('../src/routes/photos');
    const V = VARIANTS.gallery;

    // An easily compressed image must keep its quality; the old fixed-quality
    // encoder threw detail away on every image alike.
    const flat = await sharp({
      create: { width: 1200, height: 800, channels: 3, background: { r: 240, g: 238, b: 232 } },
    }).jpeg({ quality: 100 }).toBuffer();

    const best = await sharp(flat)
      .resize(V.width, V.height, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: V.quality, mozjpeg: true, progressive: true })
      .toBuffer({ resolveWithObject: true });

    assert.ok(best.data.length <= V.targetBytes,
      'a flat image should fit the budget at full quality');
    // Aspect ratio must survive: 1200x800 is 1.5, and "inside" never crops.
    assert.ok(Math.abs(best.info.width / best.info.height - 1.5) < 0.01,
      `aspect ratio changed: ${best.info.width}x${best.info.height}`);
  });

  await check('image variants have sane, distinct geometry', () => {
    const { VARIANTS } = require('../src/routes/photos');
    assert.strictEqual(VARIANTS.portrait.fit, 'cover', 'portraits must crop, not letterbox');
    assert.ok(
      Math.abs(VARIANTS.portrait.width / VARIANTS.portrait.height - 7 / 9) < 0.01,
      'portraits must be 7:9 (passport), got ' +
        VARIANTS.portrait.width + 'x' + VARIANTS.portrait.height
    );
    assert.strictEqual(VARIANTS.figure.fit, 'inside', 'a figure must not be cropped');
    assert.strictEqual(VARIANTS.gallery.fit, 'inside');
    assert.ok(VARIANTS.gallery.thumb > 0, 'gallery needs a thumbnail for the grid');
    assert.strictEqual(VARIANTS.portrait.thumb, 0);
    assert.ok(VARIANTS.gallery.width > VARIANTS.portrait.width);
  });

  await check('a figure keeps its aspect ratio; a portrait is cropped to passport', async () => {
    const sharp = require('sharp');
    const { VARIANTS } = require('../src/routes/photos');
    const wide = await sharp({
      create: { width: 2000, height: 800, channels: 3, background: { r: 10, g: 60, b: 55 } },
    }).jpeg().toBuffer();

    const fig = await sharp(wide).resize(VARIANTS.figure.width, VARIANTS.figure.height,
      { fit: 'inside', withoutEnlargement: true }).jpeg().toBuffer({ resolveWithObject: true });
    assert.ok(Math.abs(fig.info.width / fig.info.height - 2.5) < 0.02,
      'figure aspect drifted: ' + fig.info.width + 'x' + fig.info.height);

    // A very wide source must still come out at exactly the portrait geometry:
    // "cover" crops rather than letterboxing, so the stored aspect is fixed
    // whatever shape went in.
    const P = VARIANTS.portrait;
    const port = await sharp(wide).resize(P.width, P.height,
      { fit: 'cover', position: 'attention' }).jpeg().toBuffer({ resolveWithObject: true });
    assert.strictEqual(port.info.width, P.width);
    assert.strictEqual(port.info.height, P.height);
  });

  console.log('\nordering');

  await check('putting a row at 0 makes it first and shifts the rest down', () => {
    const { placeAt } = require('../src/lib/ordering');
    // Existing list a,b,c. Move c to the front.
    assert.deepStrictEqual(placeAt(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b']);
    // A brand new row at 0.
    assert.deepStrictEqual(placeAt(['a', 'b', 'c'], 'new', 0), ['new', 'a', 'b', 'c']);
  });

  await check('a row can be placed anywhere in the middle', () => {
    const { placeAt } = require('../src/lib/ordering');
    assert.deepStrictEqual(placeAt(['a', 'b', 'c', 'd'], 'd', 1), ['a', 'd', 'b', 'c']);
    assert.deepStrictEqual(placeAt(['a', 'b', 'c', 'd'], 'a', 2), ['b', 'c', 'a', 'd']);
    // Moving a row to the position it already holds changes nothing.
    assert.deepStrictEqual(placeAt(['a', 'b', 'c'], 'b', 1), ['a', 'b', 'c']);
  });

  await check('a position past either end is clamped, not rejected', () => {
    const { placeAt } = require('../src/lib/ordering');
    assert.deepStrictEqual(placeAt(['a', 'b'], 'c', 99), ['a', 'b', 'c'], 'large number should append');
    assert.deepStrictEqual(placeAt(['a', 'b'], 'c', -5), ['c', 'a', 'b'], 'negative should go first');
    assert.deepStrictEqual(placeAt(['a', 'b'], 'c', 1.7), ['a', 'c', 'b'], 'fractional should truncate');
  });

  await check('no position means append, which is what "add" should do', () => {
    const { placeAt } = require('../src/lib/ordering');
    assert.deepStrictEqual(placeAt(['a', 'b'], 'c', undefined), ['a', 'b', 'c']);
    assert.deepStrictEqual(placeAt(['a', 'b'], 'c', NaN), ['a', 'b', 'c']);
    assert.deepStrictEqual(placeAt(['a', 'b'], 'c', Infinity), ['a', 'b', 'c']);
  });

  await check('the result is always dense and holds every row exactly once', () => {
    const { placeAt } = require('../src/lib/ordering');
    const ids = ['a', 'b', 'c', 'd', 'e'];

    // Every row, to every position, must give a permutation of the same set.
    for (const moving of ids) {
      for (let pos = -2; pos <= ids.length + 2; pos++) {
        const out = placeAt(ids, moving, pos);
        assert.strictEqual(out.length, ids.length,
          `length changed moving ${moving} to ${pos}: ${out.join(',')}`);
        assert.strictEqual(new Set(out).size, ids.length,
          `duplicate or lost row moving ${moving} to ${pos}: ${out.join(',')}`);
        for (const id of ids) {
          assert.ok(out.includes(id), `${id} disappeared moving ${moving} to ${pos}`);
        }
      }
    }
  });

  await check('only the rows that actually move are written', () => {
    const { renumberOps } = require('../src/lib/ordering');

    // Already 0,1,2 in that order — nothing to do.
    const none = renumberOps(['a', 'b', 'c'], new Map([['a', 0], ['b', 1], ['c', 2]]));
    assert.strictEqual(none.length, 0, 'a list already in order should cost no writes');

    // c jumps to the front: all three indices change.
    const some = renumberOps(['c', 'a', 'b'], new Map([['a', 0], ['b', 1], ['c', 2]]));
    assert.strictEqual(some.length, 3);
    assert.deepStrictEqual(some[0].updateOne.update.$set, { order: 0 });
    assert.deepStrictEqual(some[0].updateOne.filter, { _id: 'c' });

    // A row whose stored order is a duplicate or a gap gets corrected.
    const messy = renumberOps(['a', 'b', 'c'], new Map([['a', 0], ['b', 0], ['c', 7]]));
    assert.strictEqual(messy.length, 2, 'the duplicate and the gap should both be fixed');
  });

  await check('ordering is scoped, so one cohort cannot renumber another', () => {
    const { scopeFilter } = require('../src/lib/ordering');
    assert.deepStrictEqual(scopeFilter({ group: 'phd', name: 'x' }, ['group']), { group: 'phd' });
    assert.deepStrictEqual(scopeFilter({ kind: 'journal' }, ['kind']), { kind: 'journal' });
    assert.deepStrictEqual(scopeFilter({ title: 'x' }, []), {}, 'no scope means one list');

    // A missing scope field must match "absent", not match everything — else a
    // row with no group would be renumbered alongside every group.
    assert.deepStrictEqual(scopeFilter({ name: 'x' }, ['group']), { group: null });
    assert.deepStrictEqual(scopeFilter({ group: '' }, ['group']), { group: null });
  });

  await check('every page container in index.html is properly closed', () => {
    const fs = require('fs');
    const path = require('path');
    const html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'index.html'), 'utf8');
    const lines = html.split('\n');

    const opens = (html.match(/<div\b/g) || []).length;
    const closes = (html.match(/<\/div>/g) || []).length;
    assert.strictEqual(opens, closes,
      `unbalanced divs: ${opens} <div> against ${closes} </div>`);

    // The failure this guards against is not a parse error — browsers recover
    // silently. An extra </div> ends the tab panel early, and everything after
    // it escapes into <main>, where it renders on EVERY tab. That is what made
    // the Lab In-charge page show the home page's content.
    for (const id of ['p-home', 'p-pi', 'p-research', 'p-members', 'p-teaching', 'p-gallery']) {
      const start = lines.findIndex((l) => l.includes(`id="${id}"`));
      assert.ok(start !== -1, `${id} is missing from index.html`);

      let depth = 0;
      let end = -1;
      for (let i = start; i < lines.length; i++) {
        depth += (lines[i].match(/<div\b/g) || []).length;
        depth -= (lines[i].match(/<\/div>/g) || []).length;
        if (depth === 0) { end = i; break; }
        if (depth < 0) break;
      }
      assert.ok(end > start, `${id} is never closed, or is closed by a stray tag`);

      // Nothing may sit between one panel's close and the next panel's open
      // except comments and blank lines.
      const after = lines.slice(end + 1).join('\n');
      const nextPanel = after.search(/<div class="page"/);
      if (nextPanel !== -1) {
        const between = after.slice(0, nextPanel)
          .replace(/<!--[\s\S]*?-->/g, '')
          .trim();
        assert.strictEqual(between, '',
          `content escaped after ${id} and will render on every tab: ` +
          between.slice(0, 80));
      }
    }
  });

  console.log('\ncurriculum vitae');

  await check('the CV uses the real Computer Modern faces, not a substitute', () => {
    const fs = require('fs');
    const { FONTS } = require('../src/lib/cv');
    for (const [name, file] of Object.entries(FONTS)) {
      assert.ok(fs.existsSync(file), `${name} font missing: ${file}`);
      // A TrueType file starts with 0x00010000 or "true"/"ttcf".
      const head = fs.readFileSync(file, { length: 4 }).subarray(0, 4);
      const ok = head.equals(Buffer.from([0, 1, 0, 0])) ||
                 head.toString('latin1') === 'true' ||
                 head.toString('latin1') === 'ttcf' ||
                 head.toString('latin1') === 'OTTO';
      assert.ok(ok, `${name} is not a usable font file`);
    }
  });

  await check('the CV renders to a real PDF from database-shaped data', async () => {
    const { buildCv } = require('../src/lib/cv');

    const doc = buildCv({
      profile: {
        name: 'Dr. Test Person',
        title: 'Assistant Professor',
        affiliation: 'School of Engineering',
        researchInterests: 'Image forensics',
        appointments: [{ title: 'Assistant Professor', org: 'JNU', period: '2023 – Present' }],
        education: [{ title: 'Ph.D.', org: 'IIT (BHU)', period: '2017 – 2021' }],
        service: [{ label: 'Examination Coordinator', text: 'Coordination.' }],
      },
      metrics: { citations: 348, hIndex: 10, i10Index: 10, asOf: 'September 2026', source: 'Google Scholar' },
      courses: [{ title: 'Data Structures', designation: 'B.Tech.', semester: 'Winter' }],
      members: { phd: [{ name: 'A Scholar', topic: 'Deepfakes' }] },
      research: {
        journal: [{ title: 'A paper', authors: 'X and Y', venue: 'A Journal', year: 2024, doi: '10.1/2' }],
        chaired: [{ title: 'A session', venue: 'A conference', year: 2025 }],
      },
    });

    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    const done = new Promise((resolve) => doc.on('end', resolve));
    doc.end();
    await done;

    const pdf = Buffer.concat(chunks);
    assert.ok(pdf.length > 5000, 'the PDF is implausibly small: ' + pdf.length);
    assert.strictEqual(pdf.subarray(0, 5).toString('latin1'), '%PDF-',
      'output is not a PDF');
    assert.ok(pdf.subarray(-1024).toString('latin1').includes('%%EOF'),
      'the PDF was not closed properly');
    // The fonts must be embedded, or it renders in Times on a machine without
    // Computer Modern installed — which is every machine.
    assert.ok(pdf.includes(Buffer.from('FontFile2')), 'fonts were not embedded');
  });

  await check('a CV with almost no data still produces a valid document', async () => {
    const { buildCv } = require('../src/lib/cv');
    const doc = buildCv({ profile: { name: 'Nobody' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    const done = new Promise((resolve) => doc.on('end', resolve));
    doc.end();
    await done;
    const pdf = Buffer.concat(chunks);
    assert.strictEqual(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(pdf.includes(Buffer.from('%%EOF')));
  });

  await check('a reference never doubles a date it already contains', async () => {
    const { buildCv } = require('../src/lib/cv');
    const doc = buildCv({
      profile: { name: 'T' },
      research: {
        chaired: [{
          // The date lives inside the venue AND there is a year field. Before
          // the fix this rendered as '…15–17 May 2026., 2026.'
          title: 'IC2PCT 2026',
          venue: '6th International Conference, Galgotias University, 15–17 May 2026.',
          year: 2026,
        }],
      },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    const done = new Promise((r) => doc.on('end', r));
    doc.end();
    await done;
    const pdf = Buffer.concat(chunks).toString('latin1');
    assert.ok(!/2026\.,/.test(pdf), 'a doubled date slipped back in');
  });

  await check('the section catalogue and the renderer map cannot drift apart', () => {
    const { CV_SECTIONS, DEFAULT_ORDER, buildCv } = require('../src/lib/cv');

    // Every advertised section must actually render. The failure this guards
    // against is silent: a key in the picker with no renderer produces a
    // checkbox that does nothing at all.
    assert.ok(CV_SECTIONS.length >= 10, 'the catalogue looks truncated');
    for (const sec of CV_SECTIONS) {
      assert.ok(sec.key && sec.label, 'a section is missing its key or label');
      assert.ok(DEFAULT_ORDER.includes(sec.key));
    }
    assert.strictEqual(new Set(DEFAULT_ORDER).size, DEFAULT_ORDER.length,
      'duplicate section keys');
  });

  await check('a requested section list is honoured, and junk is ignored', () => {
    const { resolveSections, DEFAULT_ORDER } = require('../src/lib/cv');

    assert.deepStrictEqual(resolveSections('education,profile'), ['education', 'profile'],
      'order given must be the order used');
    assert.deepStrictEqual(resolveSections(['skills', 'skills']), ['skills'],
      'duplicates must collapse');
    assert.deepStrictEqual(resolveSections('education,nonsense'), ['education'],
      'an unknown key must be dropped, not fatal');
    assert.deepStrictEqual(resolveSections(null), DEFAULT_ORDER,
      'no request means everything');
    assert.deepStrictEqual(resolveSections('nonsense,rubbish'), DEFAULT_ORDER,
      'a request that resolves to nothing falls back to everything');
  });

  await check('choosing fewer sections produces a smaller document', async () => {
    const { buildCv } = require('../src/lib/cv');
    const seed = require('./seed-data.json');
    const by = (rows, key) => {
      const o = {};
      for (const r of rows) (o[r[key]] = o[r[key]] || []).push(r);
      return o;
    };
    const data = {
      profile: seed.profile, metrics: seed.metrics, courses: seed.courses,
      members: by(seed.members, 'group'), research: by(seed.research, 'kind'),
    };

    const render = (opts) => new Promise((resolve) => {
      const d = buildCv(data, opts);
      const c = [];
      d.on('data', (x) => c.push(x));
      d.on('end', () => resolve(Buffer.concat(c)));
      d.end();
    });

    const all = await render(undefined);
    const few = await render({ sections: ['profile', 'education'] });

    const pages = (b) => (b.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    assert.ok(pages(few) < pages(all),
      `selecting two sections gave ${pages(few)} pages vs ${pages(all)} for everything`);
    assert.strictEqual(few.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  await check('a stored section list is validated against the catalogue', () => {
    const { normalise } = require('../src/routes/profile');
    const out = normalise({ cvSections: ['education', 'bogus', 'education', 'profile'] });
    assert.deepStrictEqual(out.cvSections, ['education', 'profile'],
      'junk or duplicate keys must never reach the database');
  });

  await check('both email addresses survive a save and reach the CV', () => {
    const { normalise } = require('../src/routes/profile');
    const out = normalise({ email: 'a@jnu.ac.in', email2: 'b@hotmail.com', phone: '+91-1' });
    assert.strictEqual(out.email, 'a@jnu.ac.in');
    assert.strictEqual(out.email2, 'b@hotmail.com', 'the alternate email was dropped on save');
    assert.strictEqual(out.phone, '+91-1');
  });

  await check('every profile list the CV renders is accepted by the editor', () => {
    const { normalise } = require('../src/routes/profile');
    // The guard that matters: a list the CV knows about but the route does not
    // allow is silently discarded on save, and the section never appears.
    const sent = {
      appointments: [{ title: 'A' }], education: [{ title: 'B' }],
      certifications: [{ title: 'C' }], awards: [{ title: 'D' }],
      qualifications: [{ label: 'E' }], service: [{ label: 'F' }],
      training: [{ label: 'G' }],
    };
    const out = normalise(sent);
    for (const key of Object.keys(sent)) {
      assert.ok(Array.isArray(out[key]) && out[key].length === 1,
        key + ' was dropped by the profile editor');
    }
  });

  await check('a detailed CV renders the sections added for it', async () => {
    const { buildCv } = require('../src/lib/cv');
    const doc = buildCv({
      profile: {
        name: 'T',
        certifications: [{ title: 'NPTEL Elite: Deep Learning', org: 'IIT Madras', period: '2021' }],
        awards: [{ title: 'Best Paper Award', org: 'ICDAM', period: '2022' }],
      },
      research: { theme: [{ label: 'Forensics', title: 'Image forgery detection', body: 'Work on it.' }] },
      courses: [{
        title: 'Data Structures', designation: 'B.Tech.', ltp: '3-1-0',
        description: 'Linear and non-linear structures.',
        units: [{ label: 'Unit I', title: 'Arrays', topics: 'Insertion, deletion, traversal.' }],
      }],
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    const done = new Promise((r) => doc.on('end', r));
    doc.end();
    await done;
    const pdf = Buffer.concat(chunks);
    // The fonts are subset and the text compressed, so assert on size and
    // structure rather than on strings: an empty section would cost pages.
    assert.ok(pdf.length > 8000, 'the detailed CV is implausibly small');
    assert.strictEqual(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  await check('the profile editor drops blank rows and clamps long text', () => {
    const { normalise } = require('../src/routes/profile');
    const out = normalise({
      name: '  Dr. Test  ',
      education: [
        { title: 'Ph.D.', org: 'IIT', period: '2017–2021' },
        { title: '', org: '', detail: '' },          // an untouched blank row
      ],
      service: [{ label: 'Coordinator', text: 'x' }, { label: '', text: '' }],
      _id: 'hacked', createdAt: 'nope',              // not on the allow-list
    });

    assert.strictEqual(out.name, 'Dr. Test', 'whitespace should be trimmed');
    assert.strictEqual(out.education.length, 1, 'the blank row should be dropped');
    assert.strictEqual(out.service.length, 1);
    assert.ok(!('_id' in out), '_id must not be settable');
    assert.ok(!('createdAt' in out), 'createdAt must not be settable');

    const long = normalise({ researchInterests: 'x'.repeat(5000) });
    assert.ok(typeof long.researchInterests === 'string');
  });

  await check('"Conferences chaired" now reads "Sessions chaired" everywhere', () => {
    const fs = require('fs');
    const path = require('path');
    for (const rel of ['docs/assets/site.js', 'admin/assets/admin.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      assert.ok(!/Conferences chaired/.test(src), rel + ' still says "Conferences chaired"');
      assert.ok(/Sessions chaired/.test(src), rel + ' does not say "Sessions chaired"');
      // The stored value must NOT have been renamed — every existing row uses it.
      assert.ok(/'chaired'/.test(src), rel + ' lost the stored kind "chaired"');
    }
  });

  console.log('\ndocument storage');

  await check('dangerous content types are never accepted', () => {
    const fstore = require('../src/storage/files');
    for (const t of ['text/html', 'image/svg+xml', 'application/javascript',
                     'text/javascript', 'application/xhtml+xml', 'text/xml']) {
      assert.strictEqual(fstore.isAllowed(t), false, t + ' was accepted');
    }
  });

  await check('real course-material types are accepted', () => {
    const fstore = require('../src/storage/files');
    for (const t of ['application/pdf', 'application/x-ipynb+json', 'text/csv',
                     'application/zip',
                     'application/vnd.openxmlformats-officedocument.presentationml.presentation']) {
      assert.strictEqual(fstore.isAllowed(t), true, t + ' was refused');
    }
  });

  await check('filenames are rebuilt, not merely stripped', () => {
    const { safeName } = require('../src/storage/files');
    // Header injection via CR/LF in Content-Disposition.
    assert.ok(!/[\r\n]/.test(safeName('a\r\nSet-Cookie: x=1.pdf')), 'CRLF survived');
    // Path traversal.
    assert.strictEqual(safeName('../../../etc/passwd'), 'passwd');
    assert.strictEqual(safeName('..\\..\\windows\\system32\\x.dll'), 'x.dll');
    // Quotes would break out of the header's quoted string.
    assert.ok(!safeName('evil".pdf').includes('"'), 'quote survived');
    // Always something usable.
    assert.ok(safeName('').length > 0);
    assert.ok(safeName('...').length > 0);
    // Extension is supplied when missing.
    assert.match(safeName('notes', 'pdf'), /\.pdf$/);
    // Length is bounded, extension preserved.
    const long = safeName('x'.repeat(300) + '.pdf');
    assert.ok(long.length <= 80, 'length ' + long.length);
    assert.match(long, /\.pdf$/);
  });

  console.log('\nconfiguration guards');

  await check('a missing JWT_SECRET refuses to run', () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    const { secret } = require('../src/middleware/auth');
    assert.throws(() => secret(), /JWT_SECRET/);
    process.env.JWT_SECRET = saved;
  });

  await check('a too-short JWT_SECRET refuses to run', () => {
    const saved = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'short';
    const { secret } = require('../src/middleware/auth');
    assert.throws(() => secret(), /32/);
    process.env.JWT_SECRET = saved;
  });

  await check('a missing MONGODB_URI gives a useful error', async () => {
    const { connect } = require('../src/db');
    await assert.rejects(() => connect(''), /MONGODB_URI/);
  });

  await check('an unreachable cluster produces actionable instructions', () => {
    const { diagnose } = require('../src/db');
    const uri = 'mongodb+srv://u:p@c.abc.mongodb.net/cvlab';

    const sel = diagnose(new Error('Could not connect to any servers in your MongoDB Atlas cluster'), uri);
    assert.match(sel, /IP ACCESS LIST/);
    assert.match(sel, /0\.0\.0\.0\/0/);
    assert.match(sel, /PAUSED CLUSTER/);
    assert.ok(!sel.includes(':p@'), 'password leaked into the error message');

    const auth = diagnose(new Error('bad auth : authentication failed'), uri);
    assert.match(auth, /Database Access/);
    assert.match(auth, /URL-encoded/);
    assert.ok(!auth.includes(':p@'));

    const dns = diagnose(new Error('querySrv ENOTFOUND _mongodb._tcp.c.abc.mongodb.net'), uri);
    assert.match(dns, /could not be resolved/);
    assert.ok(!dns.includes(':p@'));
  });

  await check('connection strings are redacted before logging', () => {
    const { redact } = require('../src/db');
    const out = redact('mongodb+srv://user:sup3rs3cret@cluster0.abc.mongodb.net/cvlab');
    assert.ok(!out.includes('sup3rs3cret'), 'password survived redaction');
    assert.ok(out.includes('user:****@'));
  });

  console.log('\nhttp surface');

  const app = require('../server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  async function req(method, path, opts) {
    const o = opts || {};
    return fetch(base + path, {
      method,
      headers: o.headers,
      body: o.body,
      redirect: 'manual',
    });
  }

  await check('GET / serves the public page', async () => {
    const r = await req('GET', '/');
    assert.strictEqual(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('Computing and Vision Lab'));
    assert.ok(html.includes('assets/site.js'), 'site.js not linked');
    assert.ok(html.includes('assets/config.js'), 'config.js not linked');
    // Relative, not absolute: GitHub Pages publishes project sites under
    // /repository-name/, where an absolute /assets/... path 404s.
    assert.ok(!html.includes('href="/assets/'), 'absolute asset path would break on Pages');
    assert.ok(!html.includes('src="/assets/'), 'absolute asset path would break on Pages');
  });

  await check('GET /admin serves the editor', async () => {
    const r = await req('GET', '/admin');
    assert.strictEqual(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('Sign in to edit'));
    assert.ok(html.includes('noindex'), 'admin page is not marked noindex');
  });

  await check('static assets are served from docs/ and admin/', async () => {
    for (const p of ['/assets/site.css', '/assets/site.js', '/assets/config.js',
                     '/assets/admin.js', '/assets/admin.css', '/404.html']) {
      const r = await req('GET', p);
      assert.strictEqual(r.status, 200, p + ' → ' + r.status);
    }
  });

  await check('the published site does not contain the editor', async () => {
    const fs = require('fs');
    const path = require('path');
    const docs = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else docs.push(full);
      }
    })(path.join(__dirname, '..', 'docs'));

    const leaked = docs.filter((f) => /admin\.(html|js|css)$/.test(f));
    assert.strictEqual(leaked.length, 0, 'editor files inside docs/: ' + leaked.join(', '));

    // And nothing in docs/ may mention a secret or a connection string.
    for (const f of docs.filter((x) => /\.(html|js|css|json)$/.test(x))) {
      const body = fs.readFileSync(f, 'utf8');
      assert.ok(!/mongodb\+srv:\/\//.test(body), 'connection string in ' + f);
      assert.ok(!/JWT_SECRET/.test(body), 'JWT_SECRET mentioned in ' + f);
      assert.ok(!/passwordHash/.test(body), 'passwordHash mentioned in ' + f);
    }
  });

  await check('config.js ships with an unset API base', () => {
    const fs = require('fs');
    const path = require('path');
    const cfg = fs.readFileSync(path.join(__dirname, '..', 'docs', 'assets', 'config.js'), 'utf8');
    const m = cfg.match(/API_BASE:\s*'([^']*)'/);
    assert.ok(m, 'no API_BASE line in config.js');
    assert.strictEqual(m[1], '', 'config.js has a hardcoded API base: ' + m[1]);
  });

  await check('CSP is set and blocks inline script', async () => {
    const r = await req('GET', '/');
    const csp = r.headers.get('content-security-policy');
    assert.ok(csp, 'no CSP header');
    const scriptSrc = csp.match(/script-src[^;]*/)[0];
    assert.ok(!/unsafe-inline/.test(scriptSrc), 'script-src allows unsafe-inline: ' + scriptSrc);
    assert.ok(/frame-ancestors 'none'/.test(csp), 'clickjacking not blocked');
    assert.ok(/object-src 'none'/.test(csp));
  });

  await check('x-powered-by is not advertised', async () => {
    const r = await req('GET', '/');
    assert.strictEqual(r.headers.get('x-powered-by'), null);
  });

  await check('writes without a session are refused', async () => {
    for (const [method, path] of [
      ['POST', '/api/members'],
      ['PUT', '/api/members/507f1f77bcf86cd799439011'],
      ['DELETE', '/api/members/507f1f77bcf86cd799439011'],
      ['POST', '/api/research'],
      ['POST', '/api/courses'],
      ['PUT', '/api/metrics'],
      ['POST', '/api/members/reorder'],
      ['POST', '/api/photos'],
      ['GET', '/api/photos'],
      ['DELETE', '/api/photos/507f1f77bcf86cd799439011'],
      ['POST', '/api/files'],
      ['GET', '/api/files'],
      ['DELETE', '/api/files/507f1f77bcf86cd799439011'],
      ['POST', '/api/gallery'],
      ['PUT', '/api/gallery/507f1f77bcf86cd799439011'],
      ['DELETE', '/api/gallery/507f1f77bcf86cd799439011'],
    ]) {
      // fetch refuses a body on GET, so only send one where it is allowed.
      const opts = method === 'GET'
        ? {}
        : { headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'x', citations: 1 }) };
      const r = await req(method, path, opts);
      assert.strictEqual(r.status, 401, method + ' ' + path + ' → ' + r.status);
    }
  });

  await check('a forged session cookie is refused', async () => {
    const r = await req('GET', '/api/auth/me', {
      headers: { Cookie: 'cvlab_session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.forged' },
    });
    assert.strictEqual(r.status, 401);
  });

  await check('a session cookie signed with the wrong key is refused', async () => {
    const jwt = require('jsonwebtoken');
    const bad = jwt.sign({ sub: '507f1f77bcf86cd799439011', usr: 'admin', ver: 0 }, 'z'.repeat(64));
    const r = await req('GET', '/api/auth/me', { headers: { Cookie: 'cvlab_session=' + bad } });
    assert.strictEqual(r.status, 401);
  });

  await check('login with no body gives 400, not a crash', async () => {
    const r = await req('POST', '/api/auth/login', {
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(r.status, 400);
  });

  await check('unknown /api path gives JSON 404', async () => {
    const r = await req('GET', '/api/nope');
    assert.strictEqual(r.status, 404);
    const body = await r.json();
    assert.ok(body.error);
  });

  await check('an unknown page falls back to the site, not a stack trace', async () => {
    const r = await req('GET', '/no/such/page');
    assert.strictEqual(r.status, 404);
    const html = await r.text();
    assert.ok(html.includes('Computing and Vision Lab'));
  });

  await check('an oversized body is rejected', async () => {
    const r = await req('POST', '/api/members', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(400000) }),
    });
    assert.ok(r.status === 413 || r.status === 401, 'got ' + r.status);
  });

  console.log('\ncors: public reads only');

  const ALLOWED = 'https://ankitjaiswal.github.io';
  process.env.SITE_ORIGIN = ALLOWED + ',https://cvlab.jnu.ac.in';

  // These use /api/health and OPTIONS, which return without touching MongoDB.
  await check('an allowed origin may read the API', async () => {
    const r = await req('GET', '/api/health', { headers: { Origin: ALLOWED } });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), ALLOWED);
    assert.strictEqual(r.headers.get('vary'), 'Origin');
  });

  await check('a trailing slash on SITE_ORIGIN still matches', async () => {
    process.env.SITE_ORIGIN = ALLOWED + '/';
    const r = await req('GET', '/api/health', { headers: { Origin: ALLOWED } });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), ALLOWED);
    process.env.SITE_ORIGIN = ALLOWED;
  });

  await check('a second configured origin also matches', async () => {
    process.env.SITE_ORIGIN = ALLOWED + ',https://cvlab.jnu.ac.in';
    const r = await req('GET', '/api/health', { headers: { Origin: 'https://cvlab.jnu.ac.in' } });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://cvlab.jnu.ac.in');
    process.env.SITE_ORIGIN = ALLOWED;
  });

  await check('an unknown origin gets no CORS header', async () => {
    const r = await req('GET', '/api/health', { headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
  });

  await check('a lookalike origin does not match by prefix', async () => {
    const r = await req('GET', '/api/health', {
      headers: { Origin: ALLOWED + '.evil.example' },
    });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
  });

  await check('credentials are never allowed cross-origin', async () => {
    const r = await req('GET', '/api/health', { headers: { Origin: ALLOWED } });
    assert.strictEqual(
      r.headers.get('access-control-allow-credentials'), null,
      'cross-origin credentials would force SameSite=None and lose CSRF protection'
    );
  });

  await check('the preflight is answered with 204', async () => {
    const r = await req('OPTIONS', '/api/content', {
      headers: { Origin: ALLOWED, 'Access-Control-Request-Method': 'GET' },
    });
    assert.strictEqual(r.status, 204);
    assert.match(r.headers.get('access-control-allow-methods'), /GET/);
  });

  await check('auth and write routes send no CORS headers at all', async () => {
    for (const p of ['/api/auth/login', '/api/auth/me', '/api/members', '/api/metrics']) {
      const r = await req('OPTIONS', p, {
        headers: { Origin: ALLOWED, 'Access-Control-Request-Method': 'POST' },
      });
      assert.strictEqual(
        r.headers.get('access-control-allow-origin'), null,
        p + ' is CORS-enabled — another site could call it with the admin\'s cookie'
      );
    }
  });

  await check('a single photo is readable cross-origin', async () => {
    // The public pages may be on GitHub Pages while the photos live here.
    const r = await req('GET', '/api/photos/507f1f77bcf86cd799439011', {
      headers: { Origin: ALLOWED },
    });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), ALLOWED);
  });

  await check('the photo listing is NOT readable cross-origin', async () => {
    const r = await req('OPTIONS', '/api/photos', {
      headers: { Origin: ALLOWED, 'Access-Control-Request-Method': 'GET' },
    });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
  });

  await check('a stored file is readable cross-origin', async () => {
    const r = await req('GET', '/api/files/507f1f77bcf86cd799439011', {
      headers: { Origin: ALLOWED },
    });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), ALLOWED);
  });

  await check('the file library is NOT readable cross-origin', async () => {
    const r = await req('OPTIONS', '/api/files', {
      headers: { Origin: ALLOWED, 'Access-Control-Request-Method': 'GET' },
    });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
  });

  await check('health check is readable cross-origin', async () => {
    const r = await req('GET', '/api/health', { headers: { Origin: ALLOWED } });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), ALLOWED);
  });

  await check('the session cookie stays SameSite=Lax', () => {
    // Reading the source is the honest check here: setting the cookie needs a
    // successful login, which needs a database. If this ever becomes None, the
    // CSRF protection described in src/middleware/cors.js is gone.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'auth.js'), 'utf8');
    assert.match(src, /sameSite:\s*'lax'/i);
    assert.ok(!/sameSite:\s*'none'/i.test(src), 'cookie is SameSite=None');
    assert.match(src, /httpOnly:\s*true/);
  });

  delete process.env.SITE_ORIGIN;

  server.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('\nRun `npm run smoke` with MongoDB available for the full integration test.');
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\ncheck crashed:', err);
  process.exit(1);
});
