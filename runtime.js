(function () {
  'use strict';

  var VERSION = '0.8.0';

  // True only in the browser-extension copy (content script). The Canvas Theme
  // copy runs in the page's main world where `chrome.runtime.id` is undefined.
  // This lets the extension copy behave differently — notably, take priority
  // over a stale theme copy when the user opts in via the popup.
  var IS_EXTENSION = (function () {
    try { return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id); }
    catch (e) { return false; }
  })();

  // When true (extension only, set from the popup's stored toggle), the
  // extension re-owns the accordion toolbar even if a different copy built one.
  var extPriority = false;

  // One-shot guard so entering edit mode triggers a single update check per page
  // load (runInit re-runs via the observer). See maybeCheckForUpdate().
  var updateCheckRequested = false;

  // Dedupe + timing strategy: this file is loaded by BOTH the browser
  // extension (isolated content-script world) and the Canvas Theme upload
  // (page main world). They share the DOM but not window globals or DOM-node
  // JS expandos, so coordination is via shared-DOM flags: each component is
  // tagged with a `data-ntt-*-ready` attribute once initialized, and every
  // init step is idempotent. That makes re-runs and a second copy harmless,
  // with no page-level "claim" that could let an early copy (one that ran
  // before Canvas rendered the page body) lock out the correctly-timed copy.
  // See the bottom of the file for the run/observe loop.

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  // Course-version groups (categories). SINGLE SOURCE OF TRUTH for the label
  // shown above each group and the accent color applied to its tabs. Pages
  // store ONLY the `data-ntt-group` key on each tab — never the label text or
  // color — so editing this object (and shipping the update) re-labels and
  // re-colors every course at once, with no per-page edits. Keep it byte-for-
  // byte identical to the copy in authoring.js (same duplication pattern as
  // normalizeTabs/healTabsInBody). Adding a key here makes the group available
  // everywhere; an unknown/removed key degrades gracefully (no accent, no
  // label). No per-course overrides.
  var NTT_TAB_GROUPS = {
    standard: { label: 'Standard Course Versions', color: '#7a1f2b' },
    state:    { label: 'State-Specific Versions',  color: '#2e7d32' },
    client:   { label: 'Clientized Versions',      color: '#5d4037' }
  };
  // Order groups are offered/rendered in. Keys not listed still work; they just
  // sort after the listed ones.
  var NTT_TAB_GROUP_ORDER = ['standard', 'state', 'client'];

  // CSS that maps each known group key to its accent color custom property.
  // Generated from the registry so color lives in exactly one place. Injected
  // into <head> (never into saved page HTML). Shared shape with authoring.js.
  function tabGroupColorCss() {
    return Object.keys(NTT_TAB_GROUPS).map(function (key) {
      return '.ntt-tab[data-ntt-group="' + key + '"]{--ntt-tab-group-color:' +
        NTT_TAB_GROUPS[key].color + ';}';
    }).join('\n');
  }

  function ensureTabGroupStyle() {
    if (!document.head || document.getElementById('ntt-tab-groups')) return;
    var style = document.createElement('style');
    style.id = 'ntt-tab-groups';
    style.textContent = tabGroupColorCss();
    document.head.appendChild(style);
  }

  // Insert a group-label divider before the first tab of each contiguous run of
  // the same known group. Idempotent: clears prior labels first, so re-runs are
  // safe. Tabs with no/unknown group get no label (graceful orphan handling).
  function renderTabGroupLabels(root) {
    var list = root.querySelector('.ntt-tabs-list');
    if (!list) return;
    Array.from(list.querySelectorAll('.ntt-tab-group-label')).forEach(function (el) {
      el.remove();
    });
    var prevKey = null;
    Array.from(list.querySelectorAll('.ntt-tab')).forEach(function (tab) {
      if (tab.hidden) return; // skip the hidden shared/global tab in player mode
      var key = tab.getAttribute('data-ntt-group');
      var group = key && NTT_TAB_GROUPS[key];
      if (group && key !== prevKey) {
        var label = root.ownerDocument.createElement('div');
        label.className = 'ntt-tab-group-label';
        label.setAttribute('role', 'presentation');
        label.textContent = group.label;
        list.insertBefore(label, tab);
      }
      prevKey = group ? key : null;
    });
  }

  // Heal structural damage from the rich-text editor before wiring tabs up.
  // TinyMCE can split the tab strip into several `.ntt-tabs-list` blocks (and
  // leave an empty, label-less tab stub behind). In vertical placements each
  // extra list is another column-1 grid item with `grid-row: auto / span 99`,
  // so the second one is placed ~99 rows down and opens a large empty gap
  // before the stray tabs. Merge every list back into the first and drop tabs
  // that have no label. Idempotent: once merged, later passes are no-ops.
  function normalizeTabs(root) {
    const lists = Array.from(root.querySelectorAll('.ntt-tabs-list'));
    if (lists.length > 1) {
      const primary = lists[0];
      lists.slice(1).forEach(function (list) {
        while (list.firstChild) primary.appendChild(list.firstChild);
        list.remove();
      });
    }
    const primaryList = root.querySelector('.ntt-tabs-list');
    if (primaryList) {
      Array.from(primaryList.querySelectorAll('.ntt-tab')).forEach(function (tab) {
        if (!tab.textContent.trim()) tab.remove();
      });
    }
  }

  function initTabs(root) {
    // Ownership marker: '' = a non-extension (theme) copy initialized this,
    // 'ext' = the extension copy did. In extension-priority mode we take over a
    // stale theme copy's init once (so the first-tab default + normalize apply),
    // exactly like the toolbar override. Without priority it's plain first-wins.
    const priorOwner = root.getAttribute('data-ntt-tabs-ready');
    const canOverride = IS_EXTENSION && extPriority;
    if (priorOwner !== null && (priorOwner === 'ext' || !canOverride)) return;

    normalizeTabs(root);

    const allTabs = Array.from(root.querySelectorAll('.ntt-tab'));
    const allPanels = Array.from(root.querySelectorAll('.ntt-tab-panel'));

    if (!allTabs.length || !allPanels.length) return;

    // Mark ready only once there's real content, so an early/empty pass can be
    // retried by the observer when Canvas finishes rendering the panels.
    root.setAttribute('data-ntt-tabs-ready', IS_EXTENSION ? 'ext' : '');

    // Shared ("global") tab: an author marks one tab as shared; its content is
    // shown as a persistent block above the content of every tab positioned
    // BELOW it. In player mode the shared tab is hidden from the strip and its
    // panel is lifted out as that block (rendered once — no cloning, no
    // duplicate IDs). In authoring it stays a normal, editable, badged tab.
    const sharedTab = allTabs.find(function (t) {
      return t.classList.contains('ntt-tab--shared');
    });
    const sharedIndex = sharedTab ? allTabs.indexOf(sharedTab) : -1;

    let tabs = allTabs;
    let panels = allPanels;
    let sharedBlock = null;
    const belowSharedTabs = new Set();

    if (!isAuthoringMode() && sharedTab) {
      sharedTab.hidden = true; // drop it from the visible strip

      const sharedPanelId = sharedTab.getAttribute('aria-controls');
      const sharedPanel = sharedPanelId
        ? root.querySelector('#' + CSS.escape(sharedPanelId))
        : null;
      if (sharedPanel) {
        sharedPanel.classList.add('ntt-tabs-shared');
        // Sit it at the top of the panel column, above whichever version panel
        // is active.
        const list = root.querySelector('.ntt-tabs-list');
        if (list && list.nextSibling !== sharedPanel) {
          root.insertBefore(sharedPanel, list.nextSibling);
        }
        sharedBlock = sharedPanel;
        panels = allPanels.filter(function (p) { return p !== sharedPanel; });
      }

      // Tabs after the shared one (in document order) receive the block.
      allTabs.forEach(function (t, i) {
        if (i > sharedIndex && t !== sharedTab) belowSharedTabs.add(t);
      });
      tabs = allTabs.filter(function (t) { return t !== sharedTab; });
    }

    // WAI-ARIA APG: horizontal tabs use Left/Right arrows, vertical tabs use
    // Up/Down. Map both keys to the same "next/prev" action so users get the
    // expected behavior for the placement they're looking at.
    const isVertical =
      root.classList.contains('ntt-tabs--placement-start') ||
      root.classList.contains('ntt-tabs--placement-end');
    const nextKey = isVertical ? 'ArrowDown' : 'ArrowRight';
    const prevKey = isVertical ? 'ArrowUp' : 'ArrowLeft';

    function activateTab(tab) {
      const targetId = tab.getAttribute('aria-controls');

      tabs.forEach(function (item) {
        const isActive = item === tab;
        item.classList.toggle('is-active', isActive);
        item.setAttribute('aria-selected', isActive ? 'true' : 'false');
        item.setAttribute('tabindex', isActive ? '0' : '-1');
      });

      panels.forEach(function (panel) {
        const isActive = panel.id === targetId;
        panel.classList.toggle('is-active', isActive);
        panel.hidden = !isActive;
      });

      // The shared block shows only for tabs below the shared tab.
      if (sharedBlock) sharedBlock.hidden = !belowSharedTabs.has(tab);

      // Start every tab with a clean slate: clear any file selections (in the
      // shared block and all panels) so checks don't carry across tab switches.
      Array.from(root.querySelectorAll('.ntt-file-row__checkbox')).forEach(function (cb) {
        cb.checked = false;
      });
    }

    // Bind our handlers even when taking over another copy's init. We can't
    // remove that copy's listeners, but ours run too and are idempotent — and,
    // crucially, only ours know how to toggle the shared block. (A stale theme
    // copy's handler would otherwise re-hide it on every click.) Guard per tab
    // so we never bind ours twice.
    tabs.forEach(function (tab, index) {
      if (tab.__nttTabBound) return;
      tab.__nttTabBound = true;

      tab.addEventListener('click', function (event) {
        // Tab labels are anchors so saved HTML degrades gracefully without
        // JS — when JS is active we stop the href="#..." jump.
        event.preventDefault();
        activateTab(tab);
        tab.focus();
      });

      tab.addEventListener('keydown', function (event) {
        let nextIndex = null;

        if (event.key === nextKey) nextIndex = (index + 1) % tabs.length;
        if (event.key === prevKey) nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = tabs.length - 1;

        if (nextIndex !== null) {
          event.preventDefault();
          tabs[nextIndex].focus();
          activateTab(tabs[nextIndex]);
        }
      });
    });

    // The first tab is the default "start page" on load. We intentionally do
    // NOT honor a saved aria-selected here: in authoring, clicking a tab to edit
    // its panel marks that tab selected, and we don't want that transient
    // editing state to become the published landing tab. (A deliberate
    // non-first default would need its own "set as start page" control.)
    activateTab(tabs[0]);

    // Group dividers are a player-mode presentation detail; in authoring,
    // authoring.js injects its own (serialize-safe) preview labels.
    if (!isAuthoringMode()) renderTabGroupLabels(root);
  }

  // ---------------------------------------------------------------------------
  // Accordion
  //
  // Each `.ntt-accordion-item` toggles independently. The header is an anchor
  // so the saved markup degrades gracefully; we preventDefault and drive the
  // open/closed state via the is-open class, aria-expanded, and the hidden
  // attribute on the panel.
  // ---------------------------------------------------------------------------

  function initAccordion(root) {
    if (root.hasAttribute('data-ntt-accordion-ready')) return;

    const items = Array.from(root.querySelectorAll('.ntt-accordion-item'));
    const headers = Array.from(root.querySelectorAll('.ntt-accordion-header'));

    if (!headers.length) return;

    root.setAttribute('data-ntt-accordion-ready', '');

    // expand-single: opening one item auto-closes the others. Default is
    // multiple (each item toggles independently).
    const expandSingle = root.classList.contains('ntt-accordion--expand-single');

    // Default View (set via the authoring context menu): the initial open state
    // on page load. When set, it takes precedence over the authored per-item
    // is-open AND over the player-mode "auto-open sections with file rows".
    const defaultView =
      root.classList.contains('ntt-accordion--default-all-open') ? 'all-open' :
      root.classList.contains('ntt-accordion--default-first-open') ? 'first-open' :
      root.classList.contains('ntt-accordion--default-all-closed') ? 'all-closed' :
      null;

    function setOpen(item, isOpen) {
      const header = item.querySelector('.ntt-accordion-header');
      const panelId = header && header.getAttribute('aria-controls');
      const panel = panelId ? root.querySelector('#' + CSS.escape(panelId)) : null;

      item.classList.toggle('is-open', isOpen);
      if (header) header.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      if (panel) panel.hidden = !isOpen;
    }

    // Sync initial state from authored markup. In single mode, keep only the
    // first item that's marked open, and auto-open any section containing a
    // download file row when rendering in player mode.
    let firstOpenSeen = false;
    items.forEach(function (item, index) {
      const header = item.querySelector('.ntt-accordion-header');
      let isOpen;

      if (defaultView === 'all-open') {
        isOpen = true;
      } else if (defaultView === 'all-closed') {
        isOpen = false;
      } else if (defaultView === 'first-open') {
        isOpen = index === 0;
      } else {
        // No explicit default: honor the authored state, and (player mode only)
        // auto-open any section that contains a download file row.
        isOpen = Boolean(
          item.classList.contains('is-open') ||
            (header && header.getAttribute('aria-expanded') === 'true')
        );
        if (!isOpen && !isAuthoringMode()) {
          const panelId = header && header.getAttribute('aria-controls');
          const panel = panelId ? root.querySelector('#' + CSS.escape(panelId)) : null;
          if (panel && panel.querySelector('.ntt-file-row')) {
            isOpen = true;
          }
        }
      }

      if (expandSingle && isOpen && firstOpenSeen) isOpen = false;
      if (isOpen) firstOpenSeen = true;
      setOpen(item, isOpen);
    });

    headers.forEach(function (header, index) {
      header.addEventListener('click', function (event) {
        event.preventDefault();
        const item = header.closest('.ntt-accordion-item');
        if (!item) return;
        const willOpen = !item.classList.contains('is-open');
        if (expandSingle && willOpen) {
          // Close every other item before opening this one.
          items.forEach(function (other) {
            if (other !== item) setOpen(other, false);
          });
        }
        setOpen(item, willOpen);
      });

      header.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          header.click();
          return;
        }

        let nextIndex = null;
        if (event.key === 'ArrowDown') nextIndex = (index + 1) % headers.length;
        if (event.key === 'ArrowUp') nextIndex = (index - 1 + headers.length) % headers.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = headers.length - 1;

        if (nextIndex !== null) {
          event.preventDefault();
          headers[nextIndex].focus();
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // File Download Row
  //
  // Standalone rows that an author can drop into an accordion panel. The
  // runtime decorates each row with a file-type icon (from data-ext, the
  // link's title attribute, or the URL extension), formats the display date
  // from data-updated, and adds .is-updated when the date is within the
  // last 30 days (the CSS then draws the "Updated" pill + orange accent).
  // ---------------------------------------------------------------------------

  function isAuthoringMode() {
    return Boolean(
      document.querySelector('#wiki_page_body_ifr') ||
      document.querySelector('.mce-content-body[contenteditable="true"]') ||
      document.querySelector('#wiki_page_body[contenteditable="true"]') ||
      document.querySelector('body#tinymce[contenteditable="true"]')
    );
  }

  function getDownloadHref(href) {
    if (!href) return href;
    try {
      const url = new URL(href, window.location.href);
      const fileMatch = url.pathname.match(/^(.*\/files\/\d+)(?:\/download)?$/);
      if (fileMatch) {
        url.pathname = fileMatch[1] + '/download';
        url.searchParams.delete('wrap');
        url.searchParams.set('download_frd', '1');
        return url.toString();
      }
      return href;
    } catch (error) {
      return href;
    }
  }

  var MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Format a y/m/d as "Sep 15, 2023" WITHOUT going through Date string parsing
  // (which interprets "2023-09-15" as UTC and can render a day early in US zones).
  function formatYMD(y, m, d) {
    return MONTH_ABBR[m - 1] + ' ' + d + ', ' + y;
  }

  // Validate a calendar date and return {y,m,d,ts} or null (rejects e.g. 02/30).
  function makeDate(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2099) return null;
    const dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return { y: y, m: m, d: d, ts: dt.getTime() };
  }

  function parseYMD(str) {
    const m = String(str || '').match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    return m ? makeDate(+m[1], +m[2], +m[3]) : null;
  }

  // Pull the most likely version date out of a (inconsistently named) filename.
  // Handles ISO (YYYY-MM-DD), MM-DD-YYYY, and bare 8-digit MMDDYYYY / YYYYMMDD
  // (optionally v-prefixed), with -, _, ., / or space separators. When several
  // dates appear, the latest valid one wins (filenames carry the version date).
  function parseFilenameDate(name) {
    if (!name) return null;
    const text = String(name).replace(/\.[A-Za-z0-9]{1,5}$/, ''); // drop extension
    let best = null;
    const consider = function (cand) {
      if (cand && (!best || cand.ts > best.ts)) best = cand;
    };
    let re, mt;

    // ISO-ish: YYYY[sep]MM[sep]DD
    re = /(20\d{2})[\-_.\/ ](\d{1,2})[\-_.\/ ](\d{1,2})/g;
    while ((mt = re.exec(text))) consider(makeDate(+mt[1], +mt[2], +mt[3]));

    // MM[sep]DD[sep]YYYY
    re = /(\d{1,2})[\-_.\/ ](\d{1,2})[\-_.\/ ](20\d{2})/g;
    while ((mt = re.exec(text))) consider(makeDate(+mt[3], +mt[1], +mt[2]));

    // Bare 8 digits (optional leading "v"): try MMDDYYYY, then YYYYMMDD. Only
    // one interpretation can validate (a 20xx year forces YYYYMMDD; a <=12 lead
    // forces MMDDYYYY), so no ambiguity.
    re = /(?:^|[^0-9])v?(\d{8})(?![0-9])/g;
    while ((mt = re.exec(text))) {
      const s = mt[1];
      consider(makeDate(+s.slice(4, 8), +s.slice(0, 2), +s.slice(2, 4))); // MMDDYYYY
      consider(makeDate(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8))); // YYYYMMDD
    }

    return best;
  }

  // Resolve a row's date strictly from the filename (the link title attributes).
  // We deliberately do NOT fall back to the authored data-updated: that value is
  // just "the day the row was created" (see addFileDownloadRow), so showing it
  // is misleading. A file whose name carries no date simply shows no date.
  function resolveRowDate(links) {
    for (let i = 0; i < links.length; i++) {
      const t = links[i] && links[i].getAttribute('title');
      const d = parseFilenameDate(t);
      if (d) return d;
    }
    return null;
  }

  function decorateFileRow(row) {
    if (row.hasAttribute('data-ntt-row-ready')) return;

    const downloadButton = row.querySelector('.ntt-file-row__download');
    const fileNameLink = row.querySelector('a[href]:not(.ntt-file-row__download)');
    const playerMode = !isAuthoringMode();

    let activeLink = downloadButton || fileNameLink;
    if (!activeLink) return;

    const ext = getFileExtension(row, activeLink);
    const normalizedExt = (ext || 'file').toLowerCase();

    let checkbox = row.querySelector('.ntt-file-row__checkbox');
    if (!checkbox) {
      checkbox = row.ownerDocument.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'ntt-file-row__checkbox';
    }

    let iconEl = row.querySelector('.ntt-file-row__icon');
    if (!iconEl) {
      iconEl = row.ownerDocument.createElement('span');
      iconEl.className = 'ntt-file-row__icon';
    }
    iconEl.dataset.ext = normalizedExt;
    iconEl.setAttribute('data-ext', normalizedExt);
    iconEl.textContent = normalizedExt.toUpperCase();

    let nameEl = row.querySelector('.ntt-file-row__name');
    if (!nameEl) {
      nameEl = row.ownerDocument.createElement('span');
      nameEl.className = 'ntt-file-row__name';
      nameEl.textContent = extractFileNameFromLink(activeLink);
    }
    if (!nameEl.id) {
      nameEl.id = 'ntt-file-' + Date.now() + '-name';
    }
    checkbox.setAttribute('aria-labelledby', nameEl.id);

    let dateEl = row.querySelector('.ntt-file-row__date');
    if (!dateEl) {
      dateEl = row.ownerDocument.createElement('span');
      dateEl.className = 'ntt-file-row__date';
    }
    // The date text + "Updated" pill are applied by updateFileRowDate(), which
    // runs on every row each pass (even rows another copy already decorated), so
    // the filename-derived date overrides a stale theme copy's data-updated one.

    let downloadEl = downloadButton;
    if (playerMode) {
      if (!downloadEl && fileNameLink) {
        downloadEl = row.ownerDocument.createElement('a');
        downloadEl.className = 'ntt-file-row__download';
        downloadEl.href = getDownloadHref(fileNameLink.href);
        if (fileNameLink.target) downloadEl.target = fileNameLink.target;
        if (fileNameLink.rel) downloadEl.rel = fileNameLink.rel;
        if (fileNameLink.title) downloadEl.title = fileNameLink.title;
        downloadEl.textContent = 'Download';

        const plainName = row.ownerDocument.createElement('span');
        plainName.className = 'ntt-file-row__name';
        plainName.id = nameEl.id;
        plainName.textContent = fileNameLink.textContent.trim() || extractFileNameFromLink(fileNameLink);

        if (fileNameLink.parentElement && fileNameLink.parentElement.classList.contains('ntt-file-row__name')) {
          fileNameLink.parentElement.replaceWith(plainName);
        } else {
          fileNameLink.replaceWith(plainName);
        }
        nameEl = plainName;
      }

      if (downloadEl) {
        downloadEl.href = getDownloadHref(downloadEl.href);
      }
    } else {
      if (fileNameLink && downloadButton) {
        // In authoring mode, avoid showing a button and preserve the name link.
        downloadButton.remove();
        activeLink = fileNameLink;
      }
      if (!nameEl.contains(fileNameLink) && fileNameLink) {
        const wrapper = row.ownerDocument.createElement('span');
        wrapper.className = 'ntt-file-row__name';
        wrapper.id = nameEl.id;
        wrapper.textContent = '';
        fileNameLink.replaceWith(wrapper);
        wrapper.appendChild(fileNameLink);
        nameEl = wrapper;
      }
    }

    if (playerMode && downloadEl) {
      if (!row.contains(downloadEl)) row.appendChild(downloadEl);
    }

    if (!row.contains(checkbox)) row.insertBefore(checkbox, row.firstChild);
    if (!row.contains(iconEl)) row.insertBefore(iconEl, checkbox.nextSibling);
    if (!row.contains(nameEl)) row.insertBefore(nameEl, iconEl.nextSibling);
    if (!row.contains(dateEl)) row.insertBefore(dateEl, playerMode && downloadEl ? downloadEl : row.lastChild);
    if (playerMode && downloadEl && downloadEl.parentNode === row && row.lastChild !== downloadEl) row.appendChild(downloadEl);

    row.setAttribute('data-ext', normalizedExt);

    row.setAttribute('data-ntt-row-ready', '');
  }

  // Apply the filename-derived date (+ "Updated" pill) to a row. Runs on EVERY
  // row each init pass — including rows a stale theme copy already decorated and
  // marked ready — so the real version date from the filename always wins over
  // the authored data-updated. Idempotent: only writes when the value changes,
  // so it doesn't feed the mutation observer a loop.
  function updateFileRowDate(row) {
    const downloadLink = row.querySelector('.ntt-file-row__download');
    const otherLink = row.querySelector('a[title]:not(.ntt-file-row__download)');
    const rowDate = resolveRowDate([downloadLink, otherLink]);

    // No filename date → clear the date and pill (don't leave a stale theme
    // copy's data-updated value showing).
    const dateEl = row.querySelector('.ntt-file-row__date');
    if (dateEl) {
      const text = rowDate ? formatYMD(rowDate.y, rowDate.m, rowDate.d) : '';
      if (dateEl.textContent !== text) dateEl.textContent = text;
    }

    let updated = false;
    if (rowDate) {
      const diffDays = (Date.now() - rowDate.ts) / (1000 * 60 * 60 * 24);
      updated = diffDays >= 0 && diffDays <= 30;
    }
    if (row.classList.contains('is-updated') !== updated) {
      row.classList.toggle('is-updated', updated);
    }
  }

  // Strip stray, non-component elements an author may have left inside a file
  // row (e.g. a pasted "2026-06-03" date span), which otherwise render as a
  // second date next to ours. Keeps only the managed parts; preserves links and
  // images defensively. Runs each pass; idempotent once cleaned.
  const FILE_ROW_PARTS = [
    'ntt-file-row__checkbox', 'ntt-file-row__icon', 'ntt-file-row__name',
    'ntt-file-row__date', 'ntt-file-row__download'
  ];
  function sanitizeFileRow(row) {
    if (!row.hasAttribute('data-ntt-row-ready')) return;
    Array.from(row.children).forEach(function (child) {
      if (child.nodeType !== 1) return;
      const tag = child.tagName;
      if (tag === 'A' || tag === 'IMG') return;
      const known = FILE_ROW_PARTS.some(function (c) {
        return child.classList && child.classList.contains(c);
      });
      if (!known) child.remove();
    });
  }

  function getFileExtension(row, link) {
    const explicit = (row && row.getAttribute('data-ext')) || '';
    const explicitLower = explicit.toLowerCase();
    const inferred = inferExtensionFromLink(link);

    if (inferred && inferred !== 'file') {
      return inferred;
    }
    if (explicitLower && explicitLower !== 'file') {
      return explicitLower;
    }
    return 'file';
  }

  function inferExtensionFromLink(link) {
    if (!link) return 'file';

    const candidates = [];
    const title = link.getAttribute('title') || '';
    if (title) candidates.push(title);
    const linkText = (link.textContent || '').trim();
    if (linkText) candidates.push(linkText);
    const fileNameEl = link.closest('.ntt-file-row') && link.closest('.ntt-file-row').querySelector('.ntt-file-row__name');
    if (fileNameEl && fileNameEl !== link) {
      const nameText = (fileNameEl.textContent || '').trim();
      if (nameText) candidates.push(nameText);
    }
    const path = (link.href || '').split('?')[0].split('#')[0];
    if (path) candidates.push(path);

    for (let i = 0; i < candidates.length; i++) {
      const text = candidates[i] || '';
      const m = text.match(/\.([a-z0-9]{2,5})$/i);
      if (m) {
        const ext = m[1].toLowerCase();
        if (ext === 'ppt') return 'pptx';
        return ext;
      }
    }
    return 'file';
  }

  function extractFileNameFromLink(link) {
    if (!link) return 'Download';
    const title = link.getAttribute('title');
    if (title && title.trim()) {
      return title.trim();
    }
    const path = (link.getAttribute('href') || '').split('?')[0].split('#')[0];
    const segments = path.split('/').filter(Boolean);
    const lastSegment = segments[segments.length - 1] || '';
    if (lastSegment) return decodeURIComponent(lastSegment.replace(/\+/g, ' '));
    return 'Download';
  }

  // A plain link inside an NTT component that points at a Canvas file
  // (…/files/<id>) is an authored file download. We don't require any special
  // link text — the author's visible text is what they want shown. The
  // .ntt-component scope guarantees we never rewrite links elsewhere on the
  // page that aren't part of one of our components.
  function isFileDownloadLink(link) {
    if (!link || link.tagName !== 'A' || !link.hasAttribute('href')) return false;
    if (!(link.textContent || '').trim()) return false;
    if (link.closest('.ntt-file-row')) return false;
    if (!link.closest('.ntt-component')) return false;
    try {
      const url = new URL(link.getAttribute('href'), window.location.href);
      return /\/files\/\d+(?:\/download)?$/.test(url.pathname);
    } catch (error) {
      return false;
    }
  }

  // Wrap the link in a bare .ntt-file-row and let decorateFileRow() build the
  // checkbox, icon, date, and Download button. In player mode it preserves the
  // link's visible text as the (plain, unlinked) file name and strips the
  // inline link — exactly the desired transform.
  function wrapFileLinkInRow(link) {
    if (!isFileDownloadLink(link)) return null;
    const doc = link.ownerDocument;
    const row = doc.createElement('div');
    row.className = 'ntt-file-row';
    row.setAttribute('data-updated', new Date().toISOString().slice(0, 10));
    row.setAttribute('data-ext', inferExtensionFromLink(link));
    link.replaceWith(row);
    row.appendChild(link);
    return row;
  }

  function convertInlineFileLinks() {
    Array.from(document.querySelectorAll('.ntt-component a[href]'))
      .forEach(wrapFileLinkInRow);
  }

  // --- Shared file-toolbar helpers -----------------------------------------

  var POPUP_HINT_KEY = 'nttDownloadPopupHintDismissed';
  function popupHintDismissed() {
    try { return window.localStorage.getItem(POPUP_HINT_KEY) === '1'; }
    catch (e) { return false; }
  }

  // Browsers block multiple programmatic downloads as pop-ups/redirects, and the
  // only signal is a tiny address-bar icon instructors miss. We can't detect or
  // bypass it, so a blocked batch surfaces this dismissible hint. Dismissal is
  // remembered so it stops nagging once understood.
  function buildDownloadHint(doc, extraClass) {
    const hint = doc.createElement('div');
    hint.className = 'ntt-download-hint' + (extraClass ? ' ' + extraClass : '');
    hint.setAttribute('role', 'status');
    hint.hidden = true;
    hint.innerHTML =
      '<span class="ntt-download-hint__arrow" aria-hidden="true">↗</span>' +
      '<span class="ntt-download-hint__text">' +
        '<strong>Only one file downloaded?</strong> Your browser blocked the rest. ' +
        'Click the blocked-content icon near the top of the address bar (shown above), ' +
        'choose <em>Always allow pop-ups and redirects from this site</em>, then click ' +
        '<strong>Download Selected</strong> again.' +
      '</span>' +
      '<button type="button" class="ntt-download-hint__dismiss" ' +
        'aria-label="Dismiss this message and don\'t show it again">Got it</button>';
    hint.querySelector('.ntt-download-hint__dismiss').addEventListener('click', function () {
      hint.hidden = true;
      try { window.localStorage.setItem(POPUP_HINT_KEY, '1'); } catch (e) {}
    });
    return hint;
  }

  // Download each row's file through a hidden iframe (not an anchor click):
  // Canvas file URLs 302-redirect cross-origin, which the anchor/target approach
  // exposes as a top-level redirect that Chrome's pop-up blocker suppresses for
  // all but the first file. An iframe consumes the attachment response without a
  // top-level navigation, so the blocker never fires. Stagger avoids coalescing.
  function triggerDownloads(doc, rows, hint) {
    const hrefs = rows
      .map(function (row) {
        const link = row.querySelector('.ntt-file-row__download');
        return link && link.href ? link.href : null;
      })
      .filter(Boolean);

    hrefs.forEach(function (href, index) {
      setTimeout(function () {
        const frame = doc.createElement('iframe');
        frame.style.display = 'none';
        frame.src = href;
        doc.body.appendChild(frame);
        setTimeout(function () {
          if (frame.parentNode) frame.parentNode.removeChild(frame);
        }, 60000);
      }, index * 300);
    });

    if (hrefs.length > 1 && hint && !popupHintDismissed()) hint.hidden = false;
  }

  // Build a "Select All / Download Selected" toolbar + hint for a set of file
  // rows. getRows() returns the in-scope rows at action time (dynamic, so a tab
  // switch is handled for free). opts.insert(toolbar, hint) places them.
  function buildFileToolbar(host, getRows, opts) {
    opts = opts || {};
    const doc = host.ownerDocument;
    const scope = opts.ariaScope || 'in this section';

    const toolbar = doc.createElement('div');
    toolbar.className = 'ntt-accordion-toolbar' + (opts.toolbarClass ? ' ' + opts.toolbarClass : '');
    // Stamp which copy owns this toolbar so priority mode can tell its own from a
    // stale one.
    toolbar.setAttribute('data-ntt-source', IS_EXTENSION ? 'extension' : 'theme');

    const selectAll = doc.createElement('button');
    selectAll.type = 'button';
    selectAll.className = 'ntt-accordion-action';
    selectAll.textContent = 'Select All';
    selectAll.setAttribute('aria-label', 'Select all files ' + scope);

    const downloadAll = doc.createElement('button');
    downloadAll.type = 'button';
    downloadAll.className = 'ntt-accordion-action';
    downloadAll.textContent = 'Download Selected';
    downloadAll.setAttribute('aria-label', 'Download selected files ' + scope);

    toolbar.appendChild(selectAll);
    toolbar.appendChild(downloadAll);

    const hint = buildDownloadHint(doc, opts.hintClass);
    opts.insert(toolbar, hint);

    const update = function () {
      const rows = getRows();
      if (opts.hideWhenEmpty) toolbar.hidden = rows.length === 0;
      const hasSelected = rows.some(function (row) {
        const c = row.querySelector('.ntt-file-row__checkbox');
        return c && c.checked;
      });
      downloadAll.disabled = !hasSelected;
    };

    selectAll.addEventListener('click', function (event) {
      event.preventDefault();
      getRows().forEach(function (row) {
        const c = row.querySelector('.ntt-file-row__checkbox');
        if (c) c.checked = true;
      });
      update();
    });

    downloadAll.addEventListener('click', function (event) {
      event.preventDefault();
      const checked = getRows().filter(function (row) {
        const c = row.querySelector('.ntt-file-row__checkbox');
        return c && c.checked;
      });
      triggerDownloads(doc, checked, hint);
    });

    return { toolbar: toolbar, hint: hint, update: update };
  }

  // Priority/dedupe guard shared by both toolbar builders: returns true if we
  // should stop (a toolbar already exists and we shouldn't replace it).
  function toolbarAlreadyOwned(root, toolbarSelector, hintSelector) {
    const existing = root.querySelector(toolbarSelector);
    if (!existing) return false;
    if (!(IS_EXTENSION && extPriority) ||
        existing.getAttribute('data-ntt-source') === 'extension') {
      return true;
    }
    existing.remove();
    const staleHint = root.querySelector(hintSelector);
    if (staleHint && staleHint.parentNode) staleHint.parentNode.removeChild(staleHint);
    return false;
  }

  function createAccordionToolbar(root) {
    if (isAuthoringMode() || !root) return;
    // Inside a tabs component the single tab-view toolbar replaces these.
    if (root.closest('.ntt-tabs')) return;
    if (toolbarAlreadyOwned(root, '.ntt-accordion-toolbar', '.ntt-download-hint')) return;
    if (!root.querySelector('.ntt-file-row')) return;

    const built = buildFileToolbar(
      root,
      function () { return Array.from(root.querySelectorAll('.ntt-file-row')); },
      {
        ariaScope: 'in this accordion',
        insert: function (toolbar, hint) {
          const title = root.querySelector('.ntt-component-title');
          root.insertBefore(toolbar, title ? title.nextSibling : root.firstChild);
          root.insertBefore(hint, toolbar.nextSibling);
        }
      }
    );

    Array.from(root.querySelectorAll('.ntt-file-row__checkbox')).forEach(function (cb) {
      cb.addEventListener('change', built.update);
    });
    built.update();
  }

  // Canonical content order inside a tabs component, directly after the tab
  // strip: the single toolbar, its hint, then the shared/global block, then the
  // version panels. Enforced idempotently on every pass so it can't be left in
  // the wrong order by the init/toolbar timing race (the shared block is moved
  // by initTabs and the toolbar inserted by createTabsToolbar, possibly in
  // either order across the async priority load).
  function orderTabsContent(root) {
    const list = root.querySelector(':scope > .ntt-tabs-list');
    if (!list) return;
    const seq = [
      root.querySelector(':scope > .ntt-tabs-toolbar'),
      root.querySelector(':scope > .ntt-tabs-hint'),
      root.querySelector(':scope > .ntt-tabs-shared')
    ];
    let anchor = list;
    seq.forEach(function (el) {
      if (!el) return;
      if (anchor.nextSibling !== el) root.insertBefore(el, anchor.nextSibling);
      anchor = el;
    });
  }

  // One toolbar per tabs component, covering every file row currently visible
  // (the shared/global block plus the active version panel). Per-accordion
  // toolbars inside tabs are suppressed (here + via CSS for any a stale theme
  // copy still makes), so the user gets a single set of controls — at the very
  // top, above both the global and course-specific accordions.
  function createTabsToolbar(root) {
    if (isAuthoringMode() || !root) return;
    if (!root.querySelector('.ntt-file-row')) return;

    let toolbar = root.querySelector(':scope > .ntt-tabs-toolbar');
    if (toolbar && IS_EXTENSION && extPriority &&
        toolbar.getAttribute('data-ntt-source') !== 'extension') {
      toolbar.remove();
      const sh = root.querySelector(':scope > .ntt-tabs-hint');
      if (sh && sh.parentNode) sh.parentNode.removeChild(sh);
      toolbar = null;
    }

    if (!toolbar) {
      const visibleRows = function () {
        return Array.from(root.querySelectorAll('.ntt-file-row')).filter(function (r) {
          return !r.closest('.ntt-tab-panel[hidden]');
        });
      };

      const built = buildFileToolbar(root, visibleRows, {
        ariaScope: 'in the selected tab',
        toolbarClass: 'ntt-tabs-toolbar',
        hintClass: 'ntt-tabs-hint',
        hideWhenEmpty: true,
        insert: function (toolbarEl, hint) {
          const list = root.querySelector(':scope > .ntt-tabs-list');
          root.insertBefore(toolbarEl, list ? list.nextSibling : root.firstChild);
          root.insertBefore(hint, toolbarEl.nextSibling);
        }
      });

      // Track checkbox changes anywhere in the tabs, and tab switches (mouse or
      // keyboard), so button state + visibility follow the current view.
      root.addEventListener('change', function (event) {
        const t = event.target;
        if (t && t.classList && t.classList.contains('ntt-file-row__checkbox')) built.update();
      });
      const refresh = function (event) {
        const t = event.target;
        if (t && t.closest && t.closest('.ntt-tab')) setTimeout(built.update, 0);
      };
      root.addEventListener('click', refresh);
      root.addEventListener('keyup', refresh);

      built.update();
    }

    // Always re-assert order (cheap + idempotent) so the controls sit at the top.
    orderTabsContent(root);
  }

  // ---------------------------------------------------------------------------
  // Component registration. Add new components here so a single boot call
  // initializes everything on the page.
  // ---------------------------------------------------------------------------

  function initAllComponents() {
    // Tag every component root with the canonical marker class. This is the
    // single signal used to scope behaviors like link conversion, and it
    // self-heals pages authored before .ntt-component existed.
    document.querySelectorAll('.ntt-tabs, .ntt-accordion').forEach(function (root) {
      root.classList.add('ntt-component');
    });
    // Convert authored file links into rows first, so the accordion's
    // auto-open (which looks for .ntt-file-row) sees them.
    if (!isAuthoringMode()) {
      convertInlineFileLinks();
    }
    document.querySelectorAll('.ntt-tabs').forEach(initTabs);
    document.querySelectorAll('.ntt-accordion').forEach(initAccordion);
    document.querySelectorAll('.ntt-file-row').forEach(decorateFileRow);
    // Always re-assert the filename date and strip stray content, even on rows a
    // stale theme copy decorated, so the filename date wins and no second date
    // (or other leftover) shows.
    document.querySelectorAll('.ntt-file-row').forEach(function (row) {
      sanitizeFileRow(row);
      updateFileRowDate(row);
    });
    document.querySelectorAll('.ntt-accordion').forEach(createAccordionToolbar);
    document.querySelectorAll('.ntt-tabs').forEach(createTabsToolbar);
  }

  function runInit() {
    if (document.documentElement) {
      document.documentElement.setAttribute('data-ntt-runtime', VERSION);
    }
    try {
      ensureTabGroupStyle();
      initAllComponents();
    } catch (err) {
      // Never let one failure wedge the page or stop the observer.
      if (window.console && console.error) console.error('[NTT] init error', err);
    }
    maybeCheckForUpdate();
  }

  // Entering Canvas edit mode is the moment an author is actively working — a
  // good, traffic-free trigger to ask the background worker whether a newer
  // extension zip has been uploaded to SharePoint. Content scripts can't fetch
  // SharePoint cross-origin, so we just message the worker (it does the fetch).
  // Extension-only, and once per page load.
  function maybeCheckForUpdate() {
    if (updateCheckRequested || !IS_EXTENSION || !isAuthoringMode()) return;
    updateCheckRequested = true;
    try {
      chrome.runtime.sendMessage({ type: 'CHECK_UPDATE' });
    } catch (e) {
      // Service worker asleep or context gone — harmless; next page load retries.
    }
  }

  // Canvas renders wiki-page content via JS, so the component markup can appear
  // after this script first runs. Watch for it and (re)initialize as it shows
  // up. Debounced; all init is idempotent, so our own decoration mutations
  // settle in a pass or two without looping.
  var initTimer = null;
  function scheduleInit() {
    if (initTimer) return;
    initTimer = setTimeout(function () {
      initTimer = null;
      runInit();
    }, 50);
  }

  function startObserver() {
    if (!window.MutationObserver) return;
    var observer = new MutationObserver(scheduleInit);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Extension-only bridge to the popup: read the priority toggle, react when it
  // changes, and answer status queries. The Canvas Theme copy has no `chrome`,
  // so this whole block is a no-op there.
  function setupExtensionBridge() {
    if (!IS_EXTENSION) return;
    try {
      chrome.storage.local.get('nttExtensionPriority', function (res) {
        extPriority = !!(res && res.nttExtensionPriority);
        // Re-run so we take over the toolbar now that the (async) flag is known.
        if (extPriority) runInit();
      });
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes.nttExtensionPriority) return;
        extPriority = !!changes.nttExtensionPriority.newValue;
        // Turning it ON takes over live; turning it OFF applies on next reload.
        if (extPriority) runInit();
      });
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (msg && msg.type === 'NTT_STATUS') {
          sendResponse({
            version: VERSION,
            isExtension: true,
            overriding: extPriority
          });
        }
        return true;
      });
    } catch (e) {
      if (window.console && console.error) console.error('[NTT] extension bridge error', e);
    }
  }

  // Run now, again at the usual lifecycle points, and whenever the DOM changes.
  setupExtensionBridge();
  runInit();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runInit);
  }
  window.addEventListener('load', runInit);
  startObserver();
})();
