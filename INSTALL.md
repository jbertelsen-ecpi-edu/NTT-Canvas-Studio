# Installing the NTT Canvas Editor extension

This is the authoring extension for building NTT components (Tabs, Accordions,
File Download Rows) inside Canvas pages. It's distributed as an unpacked Chrome
extension — a one-time setup, then a quick reload to update.

> Works in Chrome and Edge (and other Chromium browsers). It only runs on
> `ntt.instructure.com` course pages.

## First-time install

1. **Save the folder somewhere permanent.** Unzip `NTT-Canvas-Editor-vX.Y.Z.zip`
   to a stable location you won't delete or move — e.g.
   `C:\NTT\NTT-Canvas-Editor\`.
   **Do not** run it from Downloads or a temp folder; if the folder moves or is
   cleaned up, the extension stops working.
2. Open your browser to **`chrome://extensions`** (Edge: `edge://extensions`).
3. Turn on **Developer mode** (toggle, top-right).
4. Click **Load unpacked** and select the **`NTT-Canvas-Editor`** folder (the
   one that contains `manifest.json`).
5. Done — you'll see the NTT Canvas Editor tile with its icon. Open a Canvas
   page to confirm components render and right-click authoring works.

> **Developer-mode note:** Chrome shows a "Disable developer mode extensions"
> prompt on some startups. Click **Cancel / Keep** — it's expected for unpacked
> extensions and doesn't mean anything is wrong.

## Updating to a new version

When you receive a new `NTT-Canvas-Editor-vX.Y.Z.zip`:

1. Unzip it **over the same folder** you used at install (replace the files).
2. Go to **`chrome://extensions`** and click the **↻ reload** icon on the
   NTT Canvas Editor tile.
3. Refresh any open Canvas tab.

That's it — no need to remove and re-add. (If you extracted to a *new* folder
instead of overwriting, remove the old one and **Load unpacked** the new one.)

## Troubleshooting

- **Components don't render / authoring menu missing:** make sure you're on an
  `ntt.instructure.com` course page, then hard-refresh (Ctrl+F5).
- **Extension disappeared after restart:** the folder was moved/deleted — put it
  back at the permanent path and **Load unpacked** again.
- **"Manifest file is missing or unreadable":** you selected the wrong folder —
  pick the one that directly contains `manifest.json`.
