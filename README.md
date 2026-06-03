# NTT Canvas Editor

Interactive content components (Tabs, Accordions, File Download Rows) for
Canvas pages, plus an authoring extension that lets editors build them.

## Pieces

| File | Role |
|---|---|
| `runtime.js` / `runtime.css` | Render + behave the components on a published page. **Single source of truth.** |
| `authoring.js` / `authoring.css` | Right-click authoring UI inside the Canvas rich-content editor. |
| `manifest.json` | Browser-extension manifest (dev tooling). |
| `NTTcanvasUI.20190225.css` | Pristine institutional Canvas Theme CSS. **Never edited** — base + rollback artifact. |
| `build-theme.ps1` | Produces the upload bundle in `dist/` (see below). |

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
`<html>`; any later copy bails.

The extension's view-page script runs at `document_start` (see `manifest.json`)
so on a developer's machine the in-development copy claims the page *before*
the Theme copy and always wins. Students (no extension) just run the Theme copy.

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

### Rollback

Re-upload the original `NTTcanvasUI.20190225.css` to the CSS slot and clear the
JS slot. Apply.

### Notes & gotchas

- **Never hand-edit the Theme CSS in Canvas.** Always edit `runtime.css` and
  rebuild — the base file is preserved by the build, not by manual care.
- Theme JS/CSS load on **every** Canvas page; keep the runtime cheap and
  error-safe (it already no-ops when no components are present).
- The desktop Theme upload does **not** run in the Canvas iOS/Android apps. If
  students view these pages in the mobile app, also populate the separate
  "Mobile app JS/CSS" Theme fields (mobile custom JS is more limited).
- Keep `runtime.css` / `runtime.js` changes in sync — every authoring-side
  component change should ship matching runtime updates.
