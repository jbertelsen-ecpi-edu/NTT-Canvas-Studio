# Maintenance & Canvas Coupling Map

**Read this first if "the NTT components broke" and you are not the original author.**

This tool does rich authoring *inside* Canvas. Canvas offers no stable, public API
for that, so the tool is necessarily glued to **internal implementation details of
Canvas, its Rich Content Editor (TinyMCE), and our SharePoint distribution folder.**
Any of those can change on the vendor's schedule — with no notice — and break us
silently. None of these couplings are bugs; they're the unavoidable cost of the
feature. This document maps every coupling point, the **symptom** you'll see when it
changes, and **where to fix it**, so anyone can triage without reverse-engineering
the whole codebase.

> If you only remember one thing: when something breaks right after a Canvas
> upgrade, it is almost always one of the rows in the tables below — start there.

---

## 30-second mental model

- **[runtime.js](runtime.js)** — renders and wires the components (tabs, accordion,
  file rows, shared/global tab, course-version groups). Runs on **published pages**
  *and* inside the **editor**. It is loaded **two different ways**:
  1. the **browser extension** content script (per [manifest.json](manifest.json)), and
  2. the **Canvas Theme JS** upload (built by [build-theme.ps1](build-theme.ps1)).
  Both copies can be live at once; they coordinate with `data-ntt-*-ready` DOM flags
  (first one wins, except the extension can take over in "priority" mode).
- **[authoring.js](authoring.js)** — extension-only. Adds the right-click editing UI
  *inside* the Canvas RCE (insert/format components, set groups, placeholders, etc.).
- **[runtime.css](runtime.css)** / **[authoring.css](authoring.css)** — styles for
  published view / editor preview.
- **[background.js](background.js)** + **[popup.js](popup.js)** — the extension's
  update check and toolbar popup; these talk to **SharePoint**, not Canvas.

---

## Triage: what kind of break is it?

| What the user reports | Most likely subsystem | Jump to |
|---|---|---|
| Components show as plain links / don't render on a **published** page | Runtime injection or timing, or Theme copy not loaded | §2, §5 |
| Right-click menu / editing tools are **gone in the editor** | RCE detection or TinyMCE API | §1 |
| Renders fine in editor but **saves wrong / loses content / leaks placeholder text** | Editor serialization | §3 |
| Breaks **only in fullscreen** edit mode | Fullscreen handling | §4 |
| Works via extension but **not** for theme-only users (or vice-versa) | Dual-copy coordination | §5 |
| Nothing injects on a certain Canvas page type/URL | Injection targets | §6 |
| "Update available" never appears / is wrong; popup buttons dead | SharePoint check / links | §7 |
| Whole extension dead after a Chrome update | Extension platform (MV3) | §8 |

---

## §1 — Canvas RCE detection & TinyMCE API  *(highest-risk)*

The editor is **TinyMCE**, embedded by Canvas. We find it and drive it through
Canvas/TinyMCE internals. A Canvas RCE upgrade (or a TinyMCE major-version bump) is
the single most likely thing to break us.

| Coupling (grep for this) | Where | Assumes | Symptom if Canvas changes it |
|---|---|---|---|
| `getElementById('wiki_page_body_ifr')` | [authoring.js](authoring.js) `getTinyMceIframe`, [runtime.js](runtime.js) `isAuthoringMode` | The RCE lives in an iframe with this exact id | Editing tools vanish in the editor; runtime thinks it's never in "edit mode" |
| `body#tinymce`, `.mce-content-body[contenteditable="true"]`, `#wiki_page_body[contenteditable="true"]` | [authoring.js](authoring.js) `getIframeBody`/parent-doc finder, [runtime.js](runtime.js) `isAuthoringMode` | These are the editable body's id/classes | Same as above; fullscreen detection also fails |
| `window.tinymce.activeEditor` | [authoring.js](authoring.js) `getTinyMceEditor` | A global `tinymce` object exists with this shape | Insert actions silently fall back to `execCommand` (or do nothing); undo/dirty tracking lost |
| `editor.insertContent()`, `editor.save()`, `editor.setDirty()` | [authoring.js](authoring.js) `insertHtml`, `notifyEditorChanged` | TinyMCE's API surface is unchanged | Inserting components fails or doesn't mark the page dirty (changes not saved) |
| `document.execCommand('insertHTML', …)` (fallback path) | [authoring.js](authoring.js) `insertHtml` | This (deprecated) browser API still works | Fallback insert stops working; only matters if the TinyMCE path is also broken |

**Fix approach:** these are deliberately isolated into the small helper functions
named above. When Canvas changes the RCE, update the selector/ID or the API call in
*one* of those helpers — you should rarely need to touch component logic. Inspect a
live edit page (DevTools) to find the new id/class, and confirm `window.tinymce`'s
shape.

---

## §2 — Page render timing

Canvas renders page bodies via JavaScript *after* our script first runs, so we watch
for the markup and (re)initialize. Idempotent init makes re-runs safe.

| Coupling | Where | Assumes | Symptom if it changes |
|---|---|---|---|
| `MutationObserver` on `document.documentElement` + `data-ntt-*-ready` flags | [runtime.js](runtime.js) `startObserver`, `initTabs`/`initAccordion` | Re-running init when the DOM changes will catch late content | Components never initialize on pages where Canvas renders content late (the bug fixed in commit *"Fix runtime not initializing on Canvas's late-rendered content"*) |
| `normalizeTabs` / `healTabsInBody` | [runtime.js](runtime.js), [authoring.js](authoring.js) | TinyMCE splits the tab strip into multiple `.ntt-tabs-list` blocks / leaves empty tab stubs / wraps tabs in stray spans | New editor mangling we don't heal → broken/duplicated tab strips, short accent bars |

**Fix approach:** if a *new* kind of editor mangling appears, extend
`normalizeTabs`/`unwrapNestedTabs` (and mirror in `healTabsInBody`). If timing
regresses, confirm the observer still fires for the new render path.

---

## §3 — Editor serialization quirks

What TinyMCE *saves* vs. what it *shows* is its own behavior, and we exploit it.

| Coupling | Where | Assumes | Symptom if it changes |
|---|---|---|---|
| `data-mce-bogus="all"` on injected preview nodes (group-label dividers) | [authoring.js](authoring.js) `renderTabGroupLabels` | TinyMCE renders bogus nodes but never serializes them | Group-heading labels get **saved into** the page HTML (duplicated/stale labels appear) |
| `contenteditable="false"` + label text on the shared-assets marker | [authoring.js](authoring.js) `insertSharedAnchorAboveAccordion` (the `.ntt-shared-anchor` element) | TinyMCE keeps a non-empty, non-editable block and doesn't prune it | Placeholder marker is stripped on save (shared content reverts to top-injection) **or** authors can type into it |

**Fix approach:** verify in a real save (edit → save → reload → view source) that
bogus nodes are gone and markers survive. If a TinyMCE upgrade changes pruning rules,
adjust the marker markup.

---

## §4 — Fullscreen edit mode

In RCE fullscreen, Canvas lifts the editable out of the iframe into the parent
document, and the browser hides everything outside the fullscreen subtree.

| Coupling | Where | Assumes | Symptom if it changes |
|---|---|---|---|
| Re-parent the context-menu/dialog into `document.fullscreenElement`; listen on parent doc | [authoring.js](authoring.js) `showContextMenu`, `showLinkDialog`, `bindIntegration` | Fullscreen API semantics + editable moves to parent doc | Right-click menu / dialogs don't appear (or appear behind) in fullscreen; editing works normally otherwise |

---

## §5 — Theme copy vs. extension copy

`runtime.js` ships twice (extension content script + Canvas Theme JS). They share the
DOM but **not** JS globals.

| Coupling | Where | Assumes | Symptom if it changes |
|---|---|---|---|
| `IS_EXTENSION` via `chrome.runtime && chrome.runtime.id` | [runtime.js](runtime.js) top | Only the extension copy has a `chrome.runtime.id` | Copies misidentify themselves; priority/override logic misbehaves |
| `data-ntt-*-ready` ownership flags + extension "priority" takeover | [runtime.js](runtime.js) `initTabs` etc. | First copy wins; extension can re-own when the user opts in | Double-initialization or a stale theme copy "winning" and ignoring extension fixes |
| Theme CSS/JS build appends [runtime.css](runtime.css) to the pristine base, verifies base byte-for-byte | [build-theme.ps1](build-theme.ps1) | The institutional base file `NTTcanvasUI.20190225.css` is unchanged | Build aborts (good — it's a safety check) if the base drifts; theme styles missing if the upload step is skipped |

**Note:** the **Canvas Theme** copy has no `chrome.*` and no `authoring.js`. Theme-only
users get the published-page runtime but **not** the right-click editing UI. Keep this
in mind when a report is "works for me (extension) but not for them (theme)."

---

## §6 — Injection targets (where the extension runs)

| Coupling | Where | Assumes | Symptom if it changes |
|---|---|---|---|
| `https://ntt.instructure.com/courses/*/pages/*` (and `…/edit*` exclude/include) | [manifest.json](manifest.json) `content_scripts` matches | Canvas page URLs keep this shape; our instance host is `ntt.instructure.com` | Nothing injects on pages whose URL no longer matches (e.g. Canvas reworks page routes, or the instance is renamed) |

**Fix approach:** update the match patterns; bump version; rebuild + redistribute.

---

## §7 — Distribution & update check (SharePoint, not Canvas)

The update badge/banner reads our SharePoint distribution folder. Popup buttons open
SharePoint URLs.

| Coupling | Where | Assumes | Symptom if it changes |
|---|---|---|---|
| SharePoint REST `…/_api/web/GetFolderByServerRelativeUrl('…')/Files` with session cookies | [background.js](background.js) `checkForUpdate` | The folder path `SP_FOLDER` exists and the user is signed in to SharePoint | "Update available" never shows (fails silently, logs `[NTT] update check failed`) |
| Zip name pattern `NTT-Canvas-Editor-v(\d+).(\d+).(\d+).zip` | [background.js](background.js) `ZIP_RE` | We keep this exact zip naming (package-extension.ps1 produces it) | New versions aren't detected even though uploaded |
| `FEATURE_REQUEST_URL`, `DOWNLOAD_FOLDER_URL` | [popup.js](popup.js) | Those SharePoint list/folder URLs are valid | Popup buttons open dead links |
| `host_permissions` for `studentsecpi.sharepoint.com` | [manifest.json](manifest.json) | The extension may fetch SharePoint (CORS bypass) | Update check blocked by CORS |

**Fix approach:** if the SharePoint site/folder moves, update `SP_SITE`/`SP_FOLDER`
in [background.js](background.js) and the URLs in [popup.js](popup.js), plus the host
in [manifest.json](manifest.json).

---

## §8 — Chrome extension platform (MV3)

`chrome.storage`, `chrome.action` (badge), `chrome.tabs`, `chrome.runtime` messaging,
and the MV3 **service worker** model. These change rarely, but a Chrome MV3 policy
change can disable the whole extension. Symptom: extension dead after a Chrome update;
check `chrome://extensions` for errors on the service worker.

---

## Procedure — Updating the Theme CSS safely (avoid clobbering NTT's base)

**The hazard:** the uploaded Canvas Theme CSS is `NTT's institutional base` +
(below a banner) `our component styles`. [build-theme.ps1](build-theme.ps1) builds it
by appending [runtime.css](runtime.css) to a **frozen snapshot of the base committed
in the repo** (`NTTcanvasUI.20190225.css`). If NTT changes their *live* theme CSS and
we later rebuild from that stale snapshot, **our upload silently reverts NTT's
change.** The build's byte-for-byte self-check does **not** catch this — it only
proves we preserved the *repo's* base, not that the repo base matches what's live.

So: **never rebuild-and-upload the theme without first re-syncing the base from
live.** The flow whenever you ship a theme update (or NTT changes their base):

1. **Capture live.** In Canvas → Theme Editor, open the current CSS and copy the whole
   thing out (this is the source of truth for NTT's base right now).
2. **Split at the banner.** Find the auto-generated banner line
   (`*** NTT Canvas Interactive Components …`). **Everything above it** is NTT's
   current institutional base. (Also drop the standing warning header at the very top,
   if present — see below.) Discard everything from the banner down (that's our old
   appended block).
3. **Refresh the repo base.** Replace `NTTcanvasUI.20190225.css` with that captured
   above-the-banner content and commit it (so the snapshot tracks reality).
4. **Build + upload.** Run `build-theme.ps1` (re-appends the *current*
   [runtime.css](runtime.css)) and upload the result to Theme Editor.
5. **Verify.** Confirm NTT's recent base change is still present in the uploaded file,
   and a smoke-test page still renders (see below).

**Ownership rule:** NTT owns everything **above** the banner; the ID team owns
everything **below** it. The *only* sanctioned way the two get combined into the
uploaded file is the resync-then-build flow above — never by hand-editing the live
file on either side. (The banner already says "do NOT hand-edit below this banner.")

**Standing warning header (implemented).** [build-theme.ps1](build-theme.ps1) prepends
a comment block to the **top** of every built file — the first thing anyone editing the
live Theme CSS sees — telling institutional editors to notify the ID team before
changing styles *above* the components banner (an un-synced rebuild would overwrite
them) and never to edit *below* it. The byte-for-byte self-check verifies the base at
the post-header offset, and step 2 above strips this header on resync. To change the
wording, edit the `$header` here-string in `build-theme.ps1`.

## After any Canvas (or Chrome) release: 5-minute smoke test

Do this whenever Canvas announces an RCE/editor change, or when a break is reported:

1. **Published view** — open a page that has tabs + accordion + file rows + a shared
   tab. Confirm: tabs switch, group headings/colors show, file rows have dates,
   shared block injects (at its anchor if one is set). *(Tests §2, §5.)*
2. **Edit mode** — open the same page in the editor. Confirm the right-click menu
   appears on a tab, an accordion heading, and the shared-assets placeholder
   (delete-only). Insert a tab; set a course-version group. *(Tests §1.)*
3. **Save round-trip** — save, reload, **view source**. Confirm: no group-label
   `div`s saved, the shared-assets marker survived, no duplicate content. *(Tests §3.)*
4. **Fullscreen** — toggle RCE fullscreen, right-click a component, confirm the menu
   shows. *(Tests §4.)*
5. **Update check** — in the toolbar popup, confirm the version shows and (if a newer
   zip is on SharePoint) the banner appears. *(Tests §7.)*

If step 1 or 2 fails, the cause is almost certainly §1 — inspect the live edit page in
DevTools for the RCE iframe id / editable selectors and update the helpers in §1.

---

## Local verification without Canvas

You can exercise the **published-view** runtime against `runtime.css`/`runtime.js`
without Canvas by loading a small static HTML harness (a `.ntt-tabs` block + panels)
in a browser — useful for confirming rendering/behavior after edits. The **authoring**
path (TinyMCE) can only be fully tested inside the Canvas editor.

---

## Ownership / escalation (reduce the bus factor)

- This tool's coupling to Canvas means **someone must watch for Canvas RCE changes**
  and run the smoke test above. Treat that as an owned responsibility, not ad-hoc.
- The riskiest surface is §1. It is intentionally confined to a handful of small
  helpers so a fix is localized.
- If maintaining this becomes infeasible, the published-view styling/components have a
  vendor analogue (CidiLabs DesignPLUS); the **bespoke** parts (course-version groups,
  shared-asset injection + opt-out + anchor placement, file-download workflow) do not,
  and would need to be rebuilt or retired.
