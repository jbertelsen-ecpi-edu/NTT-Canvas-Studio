# NTT Canvas Editor

Interactive content components (Tabs, Accordions, File Download Rows) for
Canvas pages, plus an authoring extension that lets editors build them.

## Pieces

| File | Role |
|---|---|
| `runtime.js` / `runtime.css` | Render + behave the components on a published page. **Single source of truth.** |
| `authoring.js` / `authoring.css` | Right-click authoring UI inside the Canvas rich-content editor. |
| `manifest.json` | Browser-extension manifest (dev tooling). |
| `NTTcanvasUI.20190225.css` | Snapshot of NTT's institutional Canvas Theme CSS — the build base + rollback artifact. Re-synced from the live theme before a build (see `MAINTENANCE.md`); never hand-edited to add component styles. |
| `build-theme.ps1` | Produces the upload bundle in `dist/` (see below). |
| `MAINTENANCE.md` | Canvas/TinyMCE coupling map, breakage triage, and the safe theme-update (base resync) procedure. |

## Two delivery channels, one source

The same `runtime.js` / `runtime.css` reach pages two ways:

- **Browser extension (development).** Injects the local files as you edit —
  the fast iteration loop. No upload step.
- **Canvas Theme Editor (production).** Students don't have the extension, so
  for them the runtime is loaded globally via **Canvas Admin → Themes →
  Upload** (one CSS slot, one JS slot, account-wide). This is updated only at
  release points, not per edit.

### Avoiding two runtimes on one page

When a developer with the extension views a page that *also* has the Theme
runtime, both copies are present. They run in different JS realms (the
extension's content script is an isolated world; the Theme upload runs in the
page's main world) that share the DOM but not `window`, so dedupe uses a
**shared-DOM marker**: the first copy to run sets `data-ntt-runtime` on
`<html>` (at DOM-ready, via `claimPage()`); any later copy bails. This prevents
double-decoration when a developer with the extension views a page that also
carries the Theme copy. Students (no extension) just run the Theme copy.

`runtime.css` is fully `.ntt-*`-scoped, so loading it account-wide has no
effect on pages without NTT components.

## Release workflow (publishing to students)

1. Develop against `runtime.js` / `runtime.css` (extension reloads instantly).
2. Bump `VERSION` at the top of `runtime.js` for a meaningful release.
3. Build the upload bundle:

   ```powershell
   pwsh ./build-theme.ps1
   ```

   This writes to `dist/` (git-ignored):
   - `NTTcanvasUI.<yyyyMMdd>.css` — the pristine base copied **byte-for-byte**,
     then `runtime.css` appended inside a clearly-commented banner. The script
     **self-verifies** the base bytes are unchanged and aborts if not.
   - `runtime.<yyyyMMdd>.js` — a dated copy of `runtime.js`.

4. In **Canvas Admin → Themes → (your theme) → Upload**:
   - **CSS file** → `dist/NTTcanvasUI.<date>.css`
   - **JavaScript file** → `dist/runtime.<date>.js`
   - **Preview Your Changes**, then **Apply**. (Apply is account-wide and takes
     a few minutes to propagate.)

### Verifying a release (propagation)

After **Apply**, Canvas warns it "can take hours to propagate." That is the
worst-case ceiling for global cache turnover, **not** how long you wait to
verify — and it never affects development (you iterate on the extension,
instantly; the Theme is only touched at release points). To confirm a release
right away:

- **Preview Your Changes** runs the just-uploaded files in the sandbox
  immediately, before Apply — instant confirmation they work.
- The uploaded file is live at its URL the moment it uploads (the **View File**
  link) — open it to confirm the correct version is up.
- After Apply, spot-check a real page with a hard refresh (Ctrl+F5) or an
  incognito window to bypass local cache; it usually updates within minutes.

### Rollback

Re-upload the original `NTTcanvasUI.20190225.css` to the CSS slot and clear the
JS slot. Apply.

### Notes & gotchas

- **Never hand-edit the *component* styles in the Theme CSS.** Always edit
  `runtime.css` and rebuild — the components block is regenerated every build.
- **If NTT changes the *institutional* base** (the part above the components
  banner in the live Theme CSS), re-sync the repo base from live *before* your
  next `build-theme.ps1`, or the rebuild appends to a stale snapshot and
  silently overwrites their change. Full procedure + coupling/breakage map:
  **`MAINTENANCE.md`** ("Updating the Theme CSS safely").
- Theme JS/CSS load on **every** Canvas page; keep the runtime cheap and
  error-safe (it already no-ops when no components are present).
- The desktop Theme upload does **not** run in the Canvas iOS/Android apps. If
  students view these pages in the mobile app, also populate the separate
  "Mobile app JS/CSS" Theme fields (mobile custom JS is more limited).
- Keep `runtime.css` / `runtime.js` changes in sync — every authoring-side
  component change should ship matching runtime updates.
