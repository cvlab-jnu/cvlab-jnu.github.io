#!/usr/bin/env node
'use strict';

/**
 * Build a fully static copy of the public site.
 *
 *   npm run snapshot -- --api https://cvlab-jnu.onrender.com
 *   npm run snapshot -- --api https://… --out dist
 *
 * WHAT THIS IS FOR
 * ----------------
 * The public pages are already a static shell that fills itself from one
 * request to GET /api/content, plus images at /api/photos/<id>. Nothing on
 * those pages needs a server at the moment a visitor arrives — the server is
 * only needed to answer that one request.
 *
 * So: ask it once, here, and write the answer to a file. Download every
 * photograph and document it refers to. Rewrite the references to point at the
 * local copies. What comes out is a directory of plain files that can be
 * published to GitHub Pages, which is free, never sleeps, and serves from a
 * CDN — no Node, no MongoDB, no cold start, nothing to keep awake.
 *
 * WHAT YOU GIVE UP
 * ----------------
 * The snapshot is a photograph, not a window. It shows what the database held
 * when you ran this. Editing still happens in /admin on the live API host, and
 * the published site only changes when you run this again and push.
 *
 * The admin portal itself is NOT copied — it needs a server and a database by
 * definition. The generated config points the site's "Editor" link at the live
 * API host, so signing in still works from the static site.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');

// Only these get localised. Anything else — a DOI, a Scholar profile, someone's
// LinkedIn — is left exactly as it is.
const MEDIA_RE = /^\/api\/(photos|files)\/([a-f0-9]{24})$/i;

const EXT_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'text/csv': '.csv',
  'text/plain': '.txt',
  'application/json': '.json',
};

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const API = String(arg('api', process.env.SNAPSHOT_API || '')).replace(/\/+$/, '');
const OUT = path.resolve(ROOT, arg('out', 'dist'));

/** Render's free tier sleeps; the first request after that takes ~50 seconds. */
async function getJson(url, tries = 6) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.ok) return await res.json();
      if (res.status < 502) throw new Error('HTTP ' + res.status + ' from ' + url);
      console.log(`  waking the server… (${i}/${tries}, HTTP ${res.status})`);
    } catch (err) {
      if (i === tries) throw err;
      console.log(`  waking the server… (${i}/${tries}, ${err.message})`);
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
  throw new Error('The API never answered. Is ' + API + ' correct, and awake?');
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  const body = Buffer.from(await res.arrayBuffer());
  return { body, type };
}

/** Strip anything that could escape the media directory or confuse a web server. */
function safeName(s) {
  return String(s || '')
    .replace(/[\\/]/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^[.\-_]+/, '')
    .slice(0, 80);
}

async function copyDir(from, to) {
  await fsp.mkdir(to, { recursive: true });
  for (const entry of await fsp.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(src, dst);
    else await fsp.copyFile(src, dst);
  }
}

/**
 * Walk every string in the payload, replacing media references with the path
 * to a downloaded copy. Walking rather than naming the fields means a field
 * added later is picked up without editing this script.
 */
async function localise(node, ctx) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = await localise(node[i], ctx);
    return node;
  }
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) node[k] = await localise(node[k], ctx);
    return node;
  }
  if (typeof node !== 'string') return node;

  const m = node.match(MEDIA_RE);
  if (!m) return node;

  if (ctx.seen.has(node)) return ctx.seen.get(node);

  const [, kind, id] = m;
  try {
    const { body, type } = await download(API + node);
    const ext = EXT_BY_TYPE[type] || '.bin';

    const label = ctx.fileNames.get(node);
    const base = kind.toLowerCase() === 'files' && label
      ? id + '-' + safeName(label).replace(/\.[^.]*$/, '') + ext
      : id + ext;

    const rel = 'media/' + kind.toLowerCase() + '/' + base;
    await fsp.mkdir(path.join(OUT, path.dirname(rel)), { recursive: true });
    await fsp.writeFile(path.join(OUT, rel), body);
    ctx.bytes += body.length;
    console.log(`  ${rel}  (${Math.round(body.length / 1024)} kB)`);

    // The gallery grid asks for a small version. On a static host a query
    // string is ignored, so the snapshot writes a sibling "-thumb" file and
    // site.js points at that when it is reading a snapshot. The API falls back
    // to the full image where a variant carries no thumbnail, so this is always
    // safe to request.
    if (kind.toLowerCase() === 'photos') {
      try {
        const t = await download(API + node + '?size=thumb');
        const tExt = EXT_BY_TYPE[t.type] || ext;
        const tRel = rel.replace(/(\.[^.]+)$/, '-thumb' + tExt);
        await fsp.writeFile(path.join(OUT, tRel), t.body);
        ctx.bytes += t.body.length;
        console.log(`  ${tRel}  (${Math.round(t.body.length / 1024)} kB)`);
      } catch (err) {
        console.warn(`  ! no thumbnail for ${id}: ${err.message}`);
      }
    }

    ctx.seen.set(node, rel);
    ctx.count++;
    return rel;
  } catch (err) {
    // A missing photo must not abort the whole build. Leave the original path:
    // API_BASE is set in the generated config, so the live host still serves it.
    console.warn(`  ! ${node} could not be fetched (${err.message}) — left pointing at the API`);
    ctx.seen.set(node, node);
    return node;
  }
}

/** Course resources carry a human filename; use it so downloads are named sensibly. */
function collectFileNames(data) {
  const map = new Map();
  for (const c of data.courses || []) {
    for (const r of c.resources || []) {
      if (r && r.fileUrl && r.fileName) map.set(r.fileUrl, r.fileName);
    }
  }
  return map;
}

async function main() {
  if (!API) {
    throw new Error(
      'Give the API to snapshot:\n' +
      '  npm run snapshot -- --api https://cvlab-jnu.onrender.com'
    );
  }

  console.log('[snapshot] reading ' + API + '/api/content');
  const data = await getJson(API + '/api/content');

  console.log('[snapshot] writing to ' + path.relative(ROOT, OUT) + '/');
  await fsp.rm(OUT, { recursive: true, force: true });
  await copyDir(DOCS, OUT);

  const ctx = { seen: new Map(), fileNames: collectFileNames(data), count: 0, bytes: 0 };
  console.log('[snapshot] downloading media');
  const localised = await localise(data, ctx);

  // The CV is generated by the API, so it is not referenced anywhere in
  // content.json for the walker to find — it has to be fetched by name. The
  // published page links to this copy instead of to the API.
  try {
    const cv = await download(API + '/api/cv');
    await fsp.mkdir(path.join(OUT, 'media'), { recursive: true });
    await fsp.writeFile(path.join(OUT, 'media', 'cv.pdf'), cv.body);
    ctx.bytes += cv.body.length;
    ctx.count++;
    console.log(`  media/cv.pdf  (${Math.round(cv.body.length / 1024)} kB)`);
  } catch (err) {
    console.warn(`  ! the CV could not be generated (${err.message}) — the ` +
                 'download button will be missing from the published site');
  }

  localised.snapshotAt = new Date().toISOString();
  await fsp.writeFile(path.join(OUT, 'content.json'), JSON.stringify(localised, null, 1));

  // The generated config is what turns the copied pages into a static site.
  // API_BASE still points at the live host so the Editor link works and any
  // media that failed to download degrades to the API rather than to a 404.
  await fsp.writeFile(
    path.join(OUT, 'assets', 'config.js'),
    '/* GENERATED by scripts/snapshot.js — do not edit, and do not commit this\n' +
    ' * over docs/assets/config.js. CONTENT_URL is what makes the page read the\n' +
    ' * bundled snapshot instead of a live API. */\n' +
    'window.CVLAB_CONFIG = {\n' +
    '  API_BASE: ' + JSON.stringify(API) + ',\n' +
    '  CONTENT_URL: "content.json",\n' +
    '  COLD_START_RETRIES: 0,\n' +
    '  COLD_START_DELAY_MS: 0,\n' +
    '};\n'
  );

  // Without this, GitHub Pages runs the files through Jekyll, which silently
  // drops anything whose name begins with an underscore.
  await fsp.writeFile(path.join(OUT, '.nojekyll'), '');

  const counts = {
    members: Object.values(localised.members || {}).reduce((n, a) => n + a.length, 0),
    research: Object.values(localised.research || {}).reduce((n, a) => n + a.length, 0),
    courses: (localised.courses || []).length,
    gallery: (localised.gallery || []).length,
  };

  // Verify before declaring success. A snapshot that references a file it did
  // not write looks fine here and shows a broken image to every visitor, so
  // check each path against the disk — including the "-thumb" siblings the
  // gallery asks for, which nothing in content.json names directly.
  const missing = [];
  const leftOnApi = [];

  (function verify(node) {
    if (Array.isArray(node)) return node.forEach(verify);
    if (node && typeof node === 'object') return Object.values(node).forEach(verify);
    if (typeof node !== 'string') return;

    if (/^\/api\/(photos|files)\//.test(node)) { leftOnApi.push(node); return; }
    if (!/^media\//.test(node)) return;

    if (!fs.existsSync(path.join(OUT, node))) missing.push(node);

    if (node.startsWith('media/photos/')) {
      const t = node.replace(/(\.[^.]+)$/, '-thumb$1');
      if (!fs.existsSync(path.join(OUT, t))) missing.push(t + '  (gallery thumbnail)');
    }
  })(localised);

  console.log('');
  if (missing.length) {
    console.error('[snapshot] FAILED — these are referenced but were not written:');
    for (const m of missing) console.error('  ' + m);
    process.exit(1);
  }
  console.log('[snapshot] verified: every referenced file is present');

  if (leftOnApi.length) {
    console.warn(`[snapshot] ${leftOnApi.length} reference(s) could not be downloaded and still`);
    console.warn('           point at ' + API + '. They will break if that host goes away.');
  }

  console.log('[snapshot] done');
  console.log(`  members ${counts.members}  research ${counts.research}  ` +
              `courses ${counts.courses}  gallery ${counts.gallery}`);
  console.log(`  media   ${ctx.count} file(s), ${(ctx.bytes / 1048576).toFixed(2)} MB`);
  console.log('');
  console.log('  Preview:  npx serve ' + path.relative(ROOT, OUT));
}

main().catch((err) => {
  console.error('\n[snapshot] ' + err.message + '\n');
  process.exit(1);
});
