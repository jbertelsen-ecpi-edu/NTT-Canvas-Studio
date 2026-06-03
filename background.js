// Background service worker (MV3). Its one job: when an author enters Canvas
// edit mode, check the SharePoint distribution folder for a newer extension zip
// and, if found, badge the toolbar icon. The popup reads the stored result and
// shows an "Update available" banner.
//
// Why here and not in the content script: MV3 applies the *page's* CORS to
// content-script fetches, so a content script can't read SharePoint. The
// service worker gets the extension's host-permission CORS bypass and sends the
// user's SharePoint session cookies (credentials: 'include').

'use strict';

// Server-relative path of the folder that holds NTT-Canvas-Editor-vX.Y.Z.zip.
var SP_SITE = 'https://studentsecpi.sharepoint.com/sites/ntt';
var SP_FOLDER = "/sites/ntt/Department Folders/Production/ID Team Resources/Canvas Browser Extension for Chrome";

// Don't hit SharePoint more than this often, even if edit mode is entered repeatedly.
var THROTTLE_MS = 4 * 60 * 60 * 1000; // 4 hours

var ZIP_RE = /NTT-Canvas-Editor-v(\d+)\.(\d+)\.(\d+)\.zip/i;

// Parse "1.2.3" (or a [m,n,p] match) into a comparable number array.
function toParts(str) {
  var m = String(str).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

// Returns >0 if a is newer than b, <0 if older, 0 if equal.
function compareParts(a, b) {
  for (var i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function setBadge(updateAvailable) {
  try {
    if (updateAvailable) {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#e8920b' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch (e) { /* action API unavailable — ignore */ }
}

function checkForUpdate(force) {
  chrome.storage.local.get(['lastUpdateCheck'], function (res) {
    var last = (res && res.lastUpdateCheck) || 0;
    if (!force && Date.now() - last < THROTTLE_MS) return;

    var url = SP_SITE +
      "/_api/web/GetFolderByServerRelativeUrl('" +
      encodeURI(SP_FOLDER).replace(/'/g, "''") +
      "')/Files?$select=Name";

    fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json;odata=nometadata' }
    })
      .then(function (r) {
        if (!r.ok) throw new Error('SharePoint ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var files = (data && data.value) || [];
        var latest = null;
        files.forEach(function (f) {
          var m = f && f.Name && f.Name.match(ZIP_RE);
          if (!m) return;
          var parts = [+m[1], +m[2], +m[3]];
          if (!latest || compareParts(parts, latest) > 0) latest = parts;
        });

        var installed = toParts(chrome.runtime.getManifest().version);
        var updateAvailable = !!(latest && installed && compareParts(latest, installed) > 0);
        var latestVersion = latest ? latest.join('.') : null;

        chrome.storage.local.set({
          latestVersion: latestVersion,
          updateAvailable: updateAvailable,
          lastUpdateCheck: Date.now()
        });
        setBadge(updateAvailable);
      })
      .catch(function (err) {
        // Not signed in, offline, CORS, or path wrong: leave prior state, no badge churn.
        console.warn('[NTT] update check failed:', err && err.message);
      });
  });
}

chrome.runtime.onMessage.addListener(function (msg) {
  if (msg && msg.type === 'CHECK_UPDATE') checkForUpdate(false);
  // No async sendResponse needed; fire-and-forget.
});

// A fresh install/update means we're current until a check proves otherwise.
chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.local.set({ updateAvailable: false, latestVersion: null });
  setBadge(false);
});
