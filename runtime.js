(function () {
  'use strict';

  var VERSION = '0.1.0';

  // Cross-realm dedupe guard. See claimPage() near the bottom — the claim is
  // made at DOM-ready (not at module top), so it is robust regardless of when
  // this file is injected/executed.

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  function initTabs(root) {
    const tabs = Array.from(root.querySelectorAll('.ntt-tab'));
    const panels = Array.from(root.querySelectorAll('.ntt-tab-panel'));

    if (!tabs.length || !panels.length) return;

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

    const activeTab =
      tabs.find(function (tab) {
        return tab.getAttribute('aria-selected') === 'true';
      }) || tabs[0];

    activateTab(activeTab);
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
    const items = Array.from(root.querySelectorAll('.ntt-accordion-item'));
    const headers = Array.from(root.querySelectorAll('.ntt-accordion-header'));

    if (!headers.length) return;

    // expand-single: opening one item auto-closes the others. Default is
    // multiple (each item toggles independently).
    const expandSingle = root.classList.contains('ntt-accordion--expand-single');

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
    items.forEach(function (item) {
      const header = item.querySelector('.ntt-accordion-header');
      let isOpen = Boolean(
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
    if (root.querySelector('.ntt-accordion-toolbar')) return;

    const fileRows = Array.from(root.querySelectorAll('.ntt-file-row'));
    if (!fileRows.length) return;

    const doc = root.ownerDocument;
    const toolbar = doc.createElement('div');
    toolbar.className = 'ntt-accordion-toolbar';

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
      selectedRows.forEach(function (row) {
        const link = row.querySelector('.ntt-file-row__download');
        if (!link || !link.href) return;
        const anchor = doc.createElement('a');
        anchor.href = link.href;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        anchor.style.display = 'none';
        doc.body.appendChild(anchor);
        anchor.click();
        doc.body.removeChild(anchor);
      });
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

  // Claim the page via a marker on the shared <html> element. The extension
  // (isolated content-script world) and the Canvas Theme upload (page main
  // world) share the DOM but not window globals, so a DOM attribute is what
  // lets them coordinate: the first copy to claim wins, any later copy bails.
  // This prevents double-decoration when a developer with the extension views
  // a page that also carries the Theme copy. (Students have no extension, so
  // only the Theme copy runs for them.)
  function claimPage() {
    var docEl = document.documentElement;
    if (docEl.hasAttribute('data-ntt-runtime')) return false;
    docEl.setAttribute('data-ntt-runtime', VERSION);
    return true;
  }

  function boot() {
    if (!claimPage()) return;
    initAllComponents();
  }

  // Decoration must wait for the component markup to exist.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
