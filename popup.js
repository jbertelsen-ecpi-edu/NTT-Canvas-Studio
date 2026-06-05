(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Once the SharePoint List exists, paste its URL here (the list's AllItems
  // view, e.g. .../sites/ntt/Lists/Canvas%20Feature%20Requests/AllItems.aspx).
  // Users land on the list and click "+ New" to add a request. Leaving this
  // empty disables the button and shows the "not set up yet" note.
  // -------------------------------------------------------------------------
  var FEATURE_REQUEST_URL = 'https://studentsecpi.sharepoint.com/sites/ntt/_layouts/15/listforms.aspx?cid=MmU5YjM3ZDYtMTQwZC00ZmY2LTliN2EtNTM4Mjc3NmRhY2E1&nav=NjQwNDQ1YzQtNjkxNS00OTlhLWJjNGYtODNhMTgxOThhNTVm';

  // SharePoint folder users open to download the latest zip (library view scoped
  // to the Canvas Browser Extension folder).
  var DOWNLOAD_FOLDER_URL = 'https://studentsecpi.sharepoint.com/sites/ntt/Department%20Folders/Forms/AllItems.aspx?id=%2Fsites%2Fntt%2FDepartment%20Folders%2FProduction%2FID%20Team%20Resources%2FCanvas%20Browser%20Extension%20for%20Chrome';

  var STORAGE_KEY = 'nttExtensionPriority';

  var toggle = document.getElementById('priorityToggle');
  var statusDot = document.getElementById('statusDot');
  var statusText = document.getElementById('statusText');
  var extVersion = document.getElementById('extVersion');
  var featureBtn = document.getElementById('featureBtn');
  var featureNote = document.getElementById('featureNote');
  var updateBanner = document.getElementById('updateBanner');
  var updateVersion = document.getElementById('updateVersion');
  var updateBtn = document.getElementById('updateBtn');
  var healthWarning = document.getElementById('healthWarning');
  var healthDetail = document.getElementById('healthDetail');

  // Map a diagnosis code from runtime.js to a short, plain-English line.
  var HEALTH_MESSAGES = {
    'init-error': 'The components threw an error while loading.',
    'rce-not-detected': 'The Canvas editor (RCE) was not detected on an edit page.',
    'tabs-stalled': 'A tabs component was present but did not initialize.',
    'accordion-stalled': 'An accordion was present but did not initialize.'
  };

  extVersion.textContent = 'v' + chrome.runtime.getManifest().version;

  // --- Update banner: reflect what the background worker last found ---------
  chrome.storage.local.get(['updateAvailable', 'latestVersion'], function (res) {
    if (res && res.updateAvailable && res.latestVersion) {
      updateVersion.textContent = 'v' + res.latestVersion;
      updateBanner.hidden = false;
    }
  });
  updateBtn.addEventListener('click', function () {
    chrome.tabs.create({ url: DOWNLOAD_FOLDER_URL });
  });

  // --- Health warning: reflect the last self-diagnosis from the content script
  chrome.storage.local.get(['healthOk', 'healthCode', 'healthDetail'], function (res) {
    if (!res || res.healthOk === false) {
      if (!res) return; // nothing reported yet
      var line = HEALTH_MESSAGES[res.healthCode] || 'A component failed to initialize.';
      if (res.healthDetail) line += ' (' + res.healthDetail + ')';
      healthDetail.textContent = line;
      healthWarning.hidden = false;
    }
  });

  // --- Priority toggle: reflect + persist the stored flag ------------------
  chrome.storage.local.get(STORAGE_KEY, function (res) {
    toggle.checked = !!(res && res[STORAGE_KEY]);
  });
  toggle.addEventListener('change', function () {
    var obj = {};
    obj[STORAGE_KEY] = toggle.checked;
    chrome.storage.local.set(obj);
  });

  // --- Status line: ask the content script what's running on this tab ------
  function setStatus(state, text) {
    statusDot.className = 'ntt-popup__dot ntt-popup__dot--' + state;
    statusText.textContent = text;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    if (!tab || !tab.id) {
      setStatus('off', 'No active tab');
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'NTT_STATUS' }, function (resp) {
      if (chrome.runtime.lastError || !resp) {
        setStatus('off', 'Not active on this page');
        return;
      }
      if (resp.overriding) {
        setStatus('on', 'Active v' + resp.version + ' — overriding theme');
      } else {
        setStatus('idle', 'Active v' + resp.version + ' — theme has priority');
      }
    });
  });

  // --- Feature request: open the SharePoint List in a new tab --------------
  if (FEATURE_REQUEST_URL) {
    featureBtn.addEventListener('click', function () {
      chrome.tabs.create({ url: FEATURE_REQUEST_URL });
    });
  } else {
    featureBtn.disabled = true;
    featureNote.hidden = false;
  }
})();
