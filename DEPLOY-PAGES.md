# Publishing the site free on GitHub Pages

A fully static copy of the public site, published to GitHub Pages. No server, no
cold start, nothing to keep awake, free with no monthly limit.

## How it works

The public pages are a static shell that fills itself from one request to
`GET /api/content`, with images at `/api/photos/<id>`. The server is only needed
to answer that request — not to show the page.

So `scripts/snapshot.js` asks the API **once, at build time**, downloads every
photograph and document, rewrites the references to local copies, and writes a
complete site to `dist/`. What gets published makes no requests to the API at
all.

```
  Render  ──(once, at build)──▶  snapshot.js  ──▶  dist/  ──▶  GitHub Pages
  (your editor)                                                (the website)
```

Render becomes your content editor; GitHub Pages becomes your website. Render
sleeping stops mattering, because you are the only person who ever visits it.

**The trade:** the published site shows what the database held when the snapshot
ran. Edit in `/admin`, then publish again.

---

## One-time setup

### 1. Apply the code changes

Extract the delivered zips over the repository root, in order. Each expects the
previous one to be applied:

```powershell
cd <your repo folder>
Expand-Archive -Path "$HOME\Downloads\cvlab-photo-fix.zip"       -DestinationPath . -Force
Expand-Archive -Path "$HOME\Downloads\cvlab-metrics-fix.zip"     -DestinationPath . -Force
Expand-Archive -Path "$HOME\Downloads\cvlab-static-snapshot.zip" -DestinationPath . -Force
```

Check what landed before committing:

```powershell
git status
npm run check          # expect: 61 passed, 0 failed
```

### 2. Try it locally first

Do this before touching GitHub. It proves the snapshot works against your real
data, and takes a minute:

```powershell
npm run snapshot -- --api https://cvlab-jnu.onrender.com
```

Render is probably asleep, so the first attempt takes up to a minute — the
script says `waking the server…` and retries. You should end with:

```
[snapshot] verified: every referenced file is present
[snapshot] done
  members 6  research 55  courses 4  gallery 0
  media   1 file(s), 0.04 MB
```

Open it:

```powershell
npx serve dist
```

Visit the address it prints. Click through every page — home, lab in-charge,
members, research, teaching. Confirm your photograph appears and the metrics
show real numbers rather than em-dashes.

**If the build fails, stop here and fix it.** It fails rather than publishing a
site with broken images, which is the behaviour you want.

### 3. Commit and push

`dist/` is in `.gitignore` — it is generated, never committed.

```powershell
git add -A
git commit -m "Add static snapshot build for GitHub Pages" -m "scripts/snapshot.js bakes GET /api/content and all media into a self-contained dist/, so the published site needs no API at view time."
git push
```

### 4. Turn on Pages

In your repository on github.com:

**Settings → Pages → Build and deployment → Source → "GitHub Actions"**

Not "Deploy from a branch" — the workflow uploads the built `dist/`, which does
not exist in the repository.

### 5. Tell the workflow where your API is

**Settings → Secrets and variables → Actions → Variables tab → New repository
variable**

```
Name:   CVLAB_API_BASE
Value:  https://cvlab-jnu.onrender.com
```

No trailing slash. This is a **variable**, not a secret — it is a public URL.
The snapshot reads only public, unauthenticated endpoints, so this workflow
never holds a database credential or a session.

### 6. Publish

**Actions tab → "Publish static site to Pages" → Run workflow → Run workflow**

It takes two to three minutes, most of it waiting for Render to wake. When it
finishes, the run summary shows when the snapshot was taken and how large the
site is, and the Actions page links to the published URL:

```
https://<your-github-username>.github.io/<repository-name>/
```

### 7. Check the published site

Open that URL and go through the same list as step 2. Then open the browser's
developer tools (F12) → **Network** tab and reload. You should see requests for
`content.json` and files under `media/` — **and none to onrender.com.** That is
the whole point: nothing on the page depends on the API being awake.

---

## Updating the site, from now on

1. Open `https://cvlab-jnu.onrender.com/admin` and sign in. The first load takes
   about 50 seconds while Render wakes — you are the only one who waits.
2. Make your changes and save.
3. **Actions → Publish static site to Pages → Run workflow.**
4. Two minutes later the public site reflects the change.

A weekly rebuild runs on Sundays at 08:11 IST, so edits get published even if
you forget step 3. That request also stops Atlas treating the cluster as idle.
To remove it, delete the `schedule:` block in
`.github/workflows/pages.yml`.

---

## Things worth knowing

**Both sites stay live.** Render keeps serving the full application at its own
URL, admin portal included. GitHub Pages serves the static copy. They read the
same database; only the Pages copy is a point-in-time snapshot.

**You no longer need an uptime pinger.** No 750-hour budget to manage, no
15-minute idle timer that matters, nothing to keep awake.

**Uploads still have to go through `/admin` on Render.** GitHub Pages serves
files; it cannot accept them. Photographs and course materials are uploaded on
Render and appear on Pages at the next publish.

**The published files are plainly public.** Photographs and PDFs become ordinary
files on a public web host, fetchable without going through your API. That is
already true of anything on a public website, but it is worth a thought before
you upload something you would rather stayed semi-private.

**If a photo fails to download** during the build, the snapshot leaves that one
reference pointing at the API rather than failing the whole build, and prints a
warning. The site still works; that single image depends on Render being awake.
Re-run the workflow to pick it up.

---

## If something goes wrong

**Workflow fails: "Repository variable CVLAB_API_BASE is not set"**
Step 5 was missed, or it was created as a secret rather than a variable. It must
be under the **Variables** tab.

**Workflow fails: "The API never answered"**
Render did not wake within about a minute. Open the Render URL in a browser,
wait for it to load, then re-run the workflow. If it still fails, check Render's
dashboard — the service may be failing to start, in which case its logs say why.

**Workflow fails: "these are referenced but were not written"**
A photograph or document could not be downloaded. The message names the file.
Usually the API was partly awake; re-run the workflow. If it repeats, check that
the photo still exists in `/admin`.

**Published site shows "could not be loaded"**
`content.json` is missing or not being found. Confirm Pages is set to
**GitHub Actions** as its source, not a branch.

**Published site loads but shows no images**
Check the Network tab for 404s under `media/`. If the paths look like
`https://media/photos/...`, the `site.js` from the snapshot zip was not applied
— re-extract it.

**Pages 404s entirely**
The first deploy can take a few minutes to become reachable. If it persists,
check Settings → Pages shows a published URL and a green tick.
