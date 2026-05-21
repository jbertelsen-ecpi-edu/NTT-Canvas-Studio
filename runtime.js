(function () {
  'use strict';

  if (window.NTTCanvasRuntimeLoaded) return;
  window.NTTCanvasRuntimeLoaded = true;

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
    // first item that's marked open.
    let firstOpenSeen = false;
    items.forEach(function (item) {
      const header = item.querySelector('.ntt-accordion-header');
      let isOpen = Boolean(
        item.classList.contains('is-open') ||
          (header && header.getAttribute('aria-expanded') === 'true')
      );
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

  function decorateFileRow(row) {
    const link = row.querySelector('.ntt-file-row__download');

    const ext = getFileExtension(row, link);
    const iconEl = row.querySelector('.ntt-file-row__icon');
    if (iconEl) {
      iconEl.setAttribute('data-ext', ext);
      iconEl.textContent = ext.toUpperCase();
    }

    const dateAttr = row.getAttribute('data-updated');
    if (dateAttr) {
      const updated = new Date(dateAttr);
      if (!isNaN(updated.getTime())) {
        const dateEl = row.querySelector('.ntt-file-row__date');
        if (dateEl) {
          dateEl.textContent = updated.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
          });
        }
        const diffDays = (Date.now() - updated.getTime()) / (1000 * 60 * 60 * 24);
        if (diffDays >= 0 && diffDays <= 30) {
          row.classList.add('is-updated');
        }
      }
    }
  }

  function getFileExtension(row, link) {
    // 1. Author-specified data-ext wins.
    const explicit = row.getAttribute('data-ext');
    if (explicit) return explicit.toLowerCase();
    if (!link) return 'file';
    // 2. Link title (Canvas sets this to the filename when inserted from Files).
    const title = link.getAttribute('title') || '';
    let m = title.match(/\.([a-z0-9]+)$/i);
    if (m) return m[1].toLowerCase();
    // 3. URL path.
    const path = (link.href || '').split('?')[0].split('#')[0];
    m = path.match(/\.([a-z0-9]+)$/i);
    if (m) return m[1].toLowerCase();
    return 'file';
  }

  // ---------------------------------------------------------------------------
  // Component registration. Add new components here so a single boot call
  // initializes everything on the page.
  // ---------------------------------------------------------------------------

  function initAllComponents() {
    document.querySelectorAll('.ntt-tabs').forEach(initTabs);
    document.querySelectorAll('.ntt-accordion').forEach(initAccordion);
    document.querySelectorAll('.ntt-file-row').forEach(decorateFileRow);
  }

  initAllComponents();
})();
