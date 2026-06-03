(function () {
  'use strict';

  var VERSION = '0.5.0';

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

    const tabs = Array.from(root.querySelectorAll('.ntt-tab'));
    const panels = Array.from(root.querySelectorAll('.ntt-tab-panel'));

    if (!tabs.length || !panels.length) return;

    // True when another copy already initialized (and bound listeners): we're
    // taking over, so skip re-binding to avoid duplicate handlers.
    const takingOver = priorOwner !== null;

    // Mark ready only once there's real content, so an early/empty pass can be
    // retried by the observer when Canvas finishes rendering the panels.
    root.setAttribute('data-ntt-tabs-ready', IS_EXTENSION ? 'ext' : '');

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
    }

    if (!takingOver) {
      tabs.forEach(function (tab, index) {
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
    }

    // The first tab is the default "start page" on load. We intentionally do
    // NOT honor a saved aria-selected here: in authoring, clicking a tab to edit
    // its panel marks that tab selected, and we don't want that transient
    // editing state to become the published landing tab. (A deliberate
    // non-first default would need its own "set as start page" control.)
    activateTab(tabs[0]);
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
    const dateAttr = row.getAttribute('data-updated');
    if (dateAttr) {
      const updated = new Date(dateAttr);
      if (!isNaN(updated.getTime())) {
        dateEl.textContent = updated.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric'
        });
      }
    }

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

    if (dateAttr) {
      const updated = new Date(dateAttr);
      if (!isNaN(updated.getTime())) {
        const diffDays = (Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24);
        if (diffDays >= 0 && diffDays <= 30) {
          row.classList.add('is-updated');
        }
      }
    }

    row.setAttribute('data-ntt-row-ready', '');
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

  function createAccordionToolbar(root) {
    if (isAuthoringMode() || !root) return;

    // Normally the first copy to build a toolbar wins and the other defers here.
    // In extension-priority mode, the extension instead replaces any toolbar it
    // didn't build (e.g. a stale theme copy's), then keeps its own — the source
    // stamp prevents an observer loop, and the theme copy defers to ours.
    var existingToolbar = root.querySelector('.ntt-accordion-toolbar');
    if (existingToolbar) {
      if (!(IS_EXTENSION && extPriority) ||
          existingToolbar.getAttribute('data-ntt-source') === 'extension') {
        return;
      }
      existingToolbar.remove();
      var staleHint = root.querySelector('.ntt-download-hint');
      if (staleHint && staleHint.parentNode) staleHint.parentNode.removeChild(staleHint);
    }

    const fileRows = Array.from(root.querySelectorAll('.ntt-file-row'));
    if (!fileRows.length) return;

    const doc = root.ownerDocument;
    const toolbar = doc.createElement('div');
    toolbar.className = 'ntt-accordion-toolbar';
    // Stamp which copy owns this toolbar so priority mode can tell its own
    // toolbar from a stale one (see the guard above).
    toolbar.setAttribute('data-ntt-source', IS_EXTENSION ? 'extension' : 'theme');

    const selectAll = doc.createElement('button');
    selectAll.type = 'button';
    selectAll.className = 'ntt-accordion-action';
    selectAll.textContent = 'Select All';
    selectAll.setAttribute('aria-label', 'Select all files in this accordion');

    const downloadAll = doc.createElement('button');
    downloadAll.type = 'button';
    downloadAll.className = 'ntt-accordion-action';
    downloadAll.textContent = 'Download Selected';
    downloadAll.setAttribute('aria-label', 'Download selected files in this accordion');

    toolbar.appendChild(selectAll);
    toolbar.appendChild(downloadAll);

    const title = root.querySelector('.ntt-component-title');
    const insertBefore = title ? title.nextSibling : root.firstChild;
    root.insertBefore(toolbar, insertBefore);

    // Browsers block multiple programmatic downloads as pop-ups/redirects, and
    // the only signal is a tiny icon in the address bar that instructors miss.
    // We can't detect or bypass the block from JS, so when a multi-file
    // download is triggered we surface a clear, dismissible hint pointing them
    // to that icon. Dismissal is remembered so it stops nagging once understood.
    const POPUP_HINT_KEY = 'nttDownloadPopupHintDismissed';
    const popupHintDismissed = function () {
      try { return window.localStorage.getItem(POPUP_HINT_KEY) === '1'; }
      catch (e) { return false; }
    };

    const hint = doc.createElement('div');
    hint.className = 'ntt-download-hint';
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
    root.insertBefore(hint, toolbar.nextSibling);

    hint.querySelector('.ntt-download-hint__dismiss').addEventListener('click', function () {
      hint.hidden = true;
      try { window.localStorage.setItem(POPUP_HINT_KEY, '1'); } catch (e) {}
    });

    const updateDownloadSelectedState = function () {
      const hasSelected = Array.from(root.querySelectorAll('.ntt-file-row__checkbox')).some(function (checkbox) {
        return checkbox.checked;
      });
      downloadAll.disabled = !hasSelected;
    };

    fileRows.forEach(function (row) {
      const checkbox = row.querySelector('.ntt-file-row__checkbox');
      if (checkbox) {
        checkbox.addEventListener('change', updateDownloadSelectedState);
      }
    });

    updateDownloadSelectedState();

    selectAll.addEventListener('click', function (event) {
      event.preventDefault();
      fileRows.forEach(function (row) {
        const checkbox = row.querySelector('.ntt-file-row__checkbox');
        if (checkbox) checkbox.checked = true;
      });
      updateDownloadSelectedState();
    });

    downloadAll.addEventListener('click', function (event) {
      event.preventDefault();
      const selectedRows = Array.from(root.querySelectorAll('.ntt-file-row')).filter(function (row) {
        const checkbox = row.querySelector('.ntt-file-row__checkbox');
        return checkbox && checkbox.checked;
      });
      const hrefs = selectedRows
        .map(function (row) {
          const link = row.querySelector('.ntt-file-row__download');
          return link && link.href ? link.href : null;
        })
        .filter(Boolean);

      // Drive each download through a hidden iframe rather than an anchor click.
      // Canvas file URLs 302-redirect to a cross-origin storage host, which the
      // anchor/target approaches expose as a top-level redirect — Chrome's
      // "pop-ups and redirects" blocker then suppresses all but the first file.
      // An iframe consumes the Content-Disposition: attachment response as a
      // download without any top-level navigation, so the blocker never fires.
      // A small stagger keeps the browser from coalescing/dropping rapid loads.
      hrefs.forEach(function (href, index) {
        setTimeout(function () {
          const frame = doc.createElement('iframe');
          frame.style.display = 'none';
          frame.src = href;
          doc.body.appendChild(frame);
          // The download is handed to the browser as soon as the response
          // headers arrive; the iframe itself is no longer needed afterward.
          setTimeout(function () {
            if (frame.parentNode) frame.parentNode.removeChild(frame);
          }, 60000);
        }, index * 300);
      });

      // The first file always gets through; any extras are what the browser
      // may suppress. Show the hint (unless already dismissed) so a blocked
      // batch isn't silently reduced to a single file.
      if (hrefs.length > 1 && !popupHintDismissed()) {
        hint.hidden = false;
      }
    });
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
    document.querySelectorAll('.ntt-accordion').forEach(createAccordionToolbar);
  }

  function runInit() {
    if (document.documentElement) {
      document.documentElement.setAttribute('data-ntt-runtime', VERSION);
    }
    try {
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
