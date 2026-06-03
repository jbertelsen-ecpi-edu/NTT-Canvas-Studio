(function () {
  'use strict';

  if (window.NTTCanvasAuthoringLoaded) return;
  window.NTTCanvasAuthoringLoaded = true;

  console.log('[NTT] Authoring script loaded.');

  // ---------------------------------------------------------------------------
  // Editor access.
  //
  // The Canvas RCE normally runs in #wiki_page_body_ifr (a TinyMCE iframe with
  // body#tinymce[contenteditable="true"] inside). In fullscreen mode Canvas
  // may drop the iframe entirely and run the editable directly in the parent
  // document. We support both: any [contenteditable="true"] inside which an
  // NTT component lives is fair game.
  // ---------------------------------------------------------------------------

  function getTinyMceIframe() {
    return document.getElementById('wiki_page_body_ifr');
  }

  function getIframeDoc() {
    const iframe = getTinyMceIframe();
    if (!iframe) return null;
    try {
      return iframe.contentDocument || iframe.contentWindow.document;
    } catch (error) {
      return null;
    }
  }

  function getIframeBody() {
    const doc = getIframeDoc();
    return doc ? doc.getElementById('tinymce') : null;
  }

  function getTinyMceEditor() {
    return window.tinymce && window.tinymce.activeEditor
      ? window.tinymce.activeEditor
      : null;
  }

  // Find a contenteditable in the parent document that looks like Canvas's
  // RCE (used when the iframe is gone — e.g. fullscreen mode).
  function findParentEditable() {
    return (
      document.querySelector('body#tinymce[contenteditable="true"]') ||
      document.querySelector('.mce-content-body[contenteditable="true"]') ||
      document.querySelector('#wiki_page_body[contenteditable="true"]') ||
      Array.from(document.querySelectorAll('[contenteditable="true"]')).find(function (el) {
        return el.querySelector('.ntt-tabs, .ntt-accordion') || el.id === 'tinymce';
      }) ||
      null
    );
  }

  // Every (doc, body) pair where editing may currently be happening.
  function getEditableContexts() {
    const contexts = [];
    const ifrDoc = getIframeDoc();
    const ifrBody = getIframeBody();
    if (ifrDoc && ifrBody && ifrBody.isContentEditable) {
      contexts.push({ doc: ifrDoc, body: ifrBody });
    }
    const parentBody = findParentEditable();
    if (parentBody && parentBody !== ifrBody) {
      contexts.push({ doc: document, body: parentBody });
    }
    return contexts;
  }

  // ---------------------------------------------------------------------------
  // Selection tracking.
  //
  // We capture the caret at right-click time. The browser moves the caret to
  // the right-click position before firing `contextmenu`, so one snapshot at
  // that moment is enough for any subsequent menu action. The captured range
  // is stored together with its owning document so we can restore correctly
  // whether the click came from the iframe or the parent.
  // ---------------------------------------------------------------------------

  let savedSelectionDoc = null;
  let savedSelectionRange = null;

  function rememberSelection(doc) {
    const targetDoc = doc || document;
    const selection = targetDoc.getSelection();
    if (selection && selection.rangeCount > 0) {
      savedSelectionDoc = targetDoc;
      savedSelectionRange = selection.getRangeAt(0).cloneRange();
    }
  }

  function restoreSelection() {
    if (!savedSelectionDoc || !savedSelectionRange) return false;

    // Focus the editable that owns the saved range so the caret is real.
    const editable =
      (contextTarget && contextTarget.originalTarget &&
        contextTarget.originalTarget.closest('[contenteditable="true"]')) ||
      savedSelectionDoc.querySelector('[contenteditable="true"]');
    if (editable) editable.focus();

    const selection = savedSelectionDoc.getSelection();
    if (!selection) return false;
    selection.removeAllRanges();
    selection.addRange(savedSelectionRange);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Authoring preview styles. Injected into every editor doc we encounter so
  // authors see component boundaries while editing.
  // ---------------------------------------------------------------------------

  const PREVIEW_CSS = `
    /* Width modifiers (also defined in runtime.css; duplicated here so
       authors see the constrained width in the editor too). */
    .ntt-width-narrow,
    .ntt-width-medium,
    .ntt-width-wide {
      margin-left: auto;
      margin-right: auto;
    }
    .ntt-width-narrow { max-width: 400px; }
    .ntt-width-medium { max-width: 600px; }
    .ntt-width-wide   { max-width: 900px; }

    /* Alignment modifiers (active when combined with a width modifier). */
    .ntt-align-left   { margin-left: 0;    margin-right: auto; }
    .ntt-align-center { margin-left: auto; margin-right: auto; }
    .ntt-align-right  { margin-left: auto; margin-right: 0;    }

    .ntt-tabs {
      border: 2px dashed #0b2f57;
      padding: 12px;
      /* Avoid margin shorthand so width/align modifiers can set
         margin-left/right via .ntt-width-* / .ntt-align-* rules. */
      margin-top: 16px;
      margin-bottom: 16px;
      background: #f8fbff;
    }

    .ntt-tabs::before {
      content: "NTT Tabs Component";
      display: block;
      font-size: 12px;
      font-weight: bold;
      color: #0b2f57;
      margin-bottom: 8px;
    }

    .ntt-component-title {
      margin: 0 0 12px 0;
      font-size: 1.25rem;
      font-weight: 700;
      color: #002855;
    }

    /* Span both columns in grid placements so the editable heading sits
       above both the tab strip and the panels (not stuck in col 1). */
    .ntt-tabs--placement-start > .ntt-component-title,
    .ntt-tabs--placement-end > .ntt-component-title {
      grid-column: 1 / -1;
    }

    .ntt-tabs-list {
      display: flex;
      flex-wrap: wrap;
      gap: 1.5rem;
      border-bottom: 1px solid #d0d7de;
      margin-bottom: 12px;
      padding: 0;
    }

    .ntt-tab {
      position: relative;
      padding: 0.5rem 0;
      border: 0;
      background: transparent;
      color: #56616f;
      text-decoration: none;
      font-weight: 500;
    }

    .ntt-tab.is-active {
      color: #002855;
      font-weight: 600;
    }

    .ntt-tab.is-active::after {
      content: "";
      position: absolute;
      background: currentColor;
      left: 0;
      right: 0;
      bottom: -1px;
      height: 2px;
    }

    .ntt-tab-panel {
      display: block !important;
      border: 1px solid #c7cdd1;
      padding: 10px;
      margin-bottom: 10px;
      background: #fff;
    }

    .ntt-tab-panel::before {
      content: "Tab Panel";
      display: block;
      font-size: 11px;
      font-weight: bold;
      color: #666;
      margin-bottom: 6px;
    }

    /* Placement variants — visible in authoring so the layout matches what
       students will see. All panels stay visible (display: block !important
       higher up) so authors can edit each one in place. */
    .ntt-tabs--placement-bottom {
      display: flex;
      flex-direction: column;
    }
    .ntt-tabs--placement-bottom > .ntt-tabs-list {
      order: 2;
      border-bottom: 0;
      border-top: 1px solid #d0d7de;
      margin-bottom: 0;
      margin-top: 12px;
    }
    .ntt-tabs--placement-bottom .ntt-tab.is-active::after {
      bottom: auto;
      top: -1px;
    }
    .ntt-tabs--placement-bottom > .ntt-tab-panel { order: 1; }

    .ntt-tabs--placement-start,
    .ntt-tabs--placement-end {
      display: grid;
      gap: 0 12px;
      align-items: start;
    }
    .ntt-tabs--placement-start { grid-template-columns: auto 1fr; }
    .ntt-tabs--placement-end   { grid-template-columns: 1fr auto; }

    /* The "NTT Tabs Component" label is a ::before pseudo that becomes a
       grid item — pin it to row 1 spanning both columns so it doesn't steal
       a cell from the tabs-list / panels. */
    .ntt-tabs--placement-start::before,
    .ntt-tabs--placement-end::before {
      grid-column: 1 / -1;
      grid-row: 1;
    }

    /* Vertical tabs-list spans all panel rows so its (taller) height doesn't
       make row 2 huge and push subsequent panels down below the strip. */
    .ntt-tabs--placement-start > .ntt-tabs-list,
    .ntt-tabs--placement-end   > .ntt-tabs-list {
      grid-row: auto / span 99;
      flex-direction: column;
      flex-wrap: nowrap;
      gap: 0;
      align-self: start;
      margin-bottom: 0;
      border-bottom: 0;
    }
    .ntt-tabs--placement-start .ntt-tab,
    .ntt-tabs--placement-end .ntt-tab {
      padding: 0.4rem 0.75rem;
    }

    .ntt-tabs--placement-start > .ntt-tabs-list {
      grid-column: 1;
      border-right: 1px solid #d0d7de;
    }
    .ntt-tabs--placement-start > .ntt-tab-panel { grid-column: 2; }
    .ntt-tabs--placement-start .ntt-tab.is-active::after {
      left: auto;
      right: -1px;
      top: 0;
      bottom: 0;
      width: 2px;
      height: auto;
    }

    .ntt-tabs--placement-end > .ntt-tabs-list {
      grid-column: 2;
      border-left: 1px solid #d0d7de;
    }
    .ntt-tabs--placement-end > .ntt-tab-panel { grid-column: 1; }
    .ntt-tabs--placement-end .ntt-tab.is-active::after {
      right: auto;
      left: -1px;
      top: 0;
      bottom: 0;
      width: 2px;
      height: auto;
    }

    .ntt-accordion {
      border: 2px dashed #0b2f57;
      padding: 12px;
      margin-top: 16px;
      margin-bottom: 16px;
      background: #f8fbff;
    }

    .ntt-accordion::before {
      content: "NTT Accordion Component";
      display: block;
      font-size: 12px;
      font-weight: bold;
      color: #0b2f57;
      margin-bottom: 8px;
    }

    .ntt-accordion-item {
      border: 1px solid #c7cdd1;
      margin-bottom: 8px;
      background: #fff;
    }

    .ntt-accordion-header {
      display: block;
      padding: 6px 10px;
      background: #f5f5f5;
      color: #0b2f57;
      text-decoration: none;
      font-weight: bold;
    }

    .ntt-accordion-panel {
      display: block !important;
      padding: 10px;
    }

    .ntt-accordion-panel::before {
      content: "Accordion Panel";
      display: block;
      font-size: 11px;
      font-weight: bold;
      color: #666;
      margin-bottom: 6px;
    }

    /* File Download Row — match runtime look so authors see what students
       will see in the editor. */
    .ntt-file-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px;
      border-bottom: 1px solid #eef0f3;
      background: #fff;
    }

    .ntt-file-row__checkbox {
      flex: 0 0 auto;
    }

    .ntt-file-row__icon {
      flex: 0 0 auto;
      display: inline-block;
      width: 36px;
      height: 36px;
      border-radius: 6px;
      background: #eef0f3;
      color: #555;
      text-align: center;
      line-height: 36px;
      font-size: 10px;
      font-weight: 700;
    }

    .ntt-file-row__name {
      flex: 1 1 auto;
      font-weight: 500;
      color: #002855;
    }

    .ntt-file-row__date {
      flex: 0 0 auto;
      color: #6b7280;
      font-size: 13px;
    }

    .ntt-file-row__download {
      flex: 0 0 auto;
      padding: 5px 12px;
      background: #002855;
      color: #ffffff;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      text-decoration: none;
    }

  `;

  function injectPreviewCss(doc) {
    if (!doc || !doc.head || doc.getElementById('ntt-tinymce-preview-css')) return;
    const style = doc.createElement('style');
    style.id = 'ntt-tinymce-preview-css';
    style.textContent = PREVIEW_CSS;
    doc.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Tabs / accordion HTML templates (Canvas-safe: no <script>, no inline
  // handlers, anchor tags so TinyMCE handles them cleanly).
  // ---------------------------------------------------------------------------

  function getTabsHtml() {
    const uid = 'ntt-tabs-' + Date.now();
    return `
<div class="ntt-component ntt-tabs">
  <h3 class="ntt-component-title">Tabs Title</h3>
  <div class="ntt-tabs-list" role="tablist" aria-label="Course content tabs">
    <a class="ntt-tab is-active" href="#${uid}-panel-1" role="tab" aria-selected="true" tabindex="0" aria-controls="${uid}-panel-1" id="${uid}-tab-1">Overview</a>
    <a class="ntt-tab" href="#${uid}-panel-2" role="tab" aria-selected="false" tabindex="-1" aria-controls="${uid}-panel-2" id="${uid}-tab-2">Resources</a>
  </div>

  <div class="ntt-tab-panel is-active" role="tabpanel" id="${uid}-panel-1" aria-labelledby="${uid}-tab-1">
    <h3>Overview</h3>
    <p>Add overview content here.</p>
  </div>

  <div class="ntt-tab-panel" role="tabpanel" id="${uid}-panel-2" aria-labelledby="${uid}-tab-2">
    <h3>Resources</h3>
    <p>Add resources here.</p>
  </div>
</div>
`;
  }

  function getFileRowHtml() {
    const uid = 'ntt-file-' + Date.now();
    const today = new Date().toISOString().slice(0, 10);
    return `<div class="ntt-file-row" data-updated="${today}" data-ext="pdf"><input type="checkbox" class="ntt-file-row__checkbox" aria-labelledby="${uid}-name"><span class="ntt-file-row__icon"></span><a class="ntt-file-row__name" id="${uid}-name" href="#" title="File Name.pdf">File Name</a><span class="ntt-file-row__date">${today}</span></div>`;
  }

  function getAccordionHtml() {
    const uid = 'ntt-accordion-' + Date.now();
    return `
<div class="ntt-component ntt-accordion">
  <h3 class="ntt-component-title">Accordion Title</h3>
  <div class="ntt-accordion-item is-open">
    <a class="ntt-accordion-header" href="#${uid}-panel-1" role="button" aria-expanded="true" aria-controls="${uid}-panel-1" id="${uid}-header-1">Section 1</a>
    <div class="ntt-accordion-panel" id="${uid}-panel-1" role="region" aria-labelledby="${uid}-header-1">
      <p>Add content for section 1 here.</p>
    </div>
  </div>

  <div class="ntt-accordion-item">
    <a class="ntt-accordion-header" href="#${uid}-panel-2" role="button" aria-expanded="false" aria-controls="${uid}-panel-2" id="${uid}-header-2">Section 2</a>
    <div class="ntt-accordion-panel" id="${uid}-panel-2" role="region" aria-labelledby="${uid}-header-2">
      <p>Add content for section 2 here.</p>
    </div>
  </div>
</div>
`;
  }

  // ---------------------------------------------------------------------------
  // Insert HTML.
  //
  // Preferred path: TinyMCE's own insertContent — TinyMCE knows where its
  // editable currently lives (iframe or parent doc) and tracks undo + dirty
  // state. Fallback: execCommand('insertHTML') against the saved selection's
  // document.
  // ---------------------------------------------------------------------------

  function insertHtml(html) {
    const editor = getTinyMceEditor();

    if (editor) {
      editor.focus();
      restoreSelection();
      editor.insertContent(html);
      // Update the saved range to the end of the inserted content.
      rememberSelection(savedSelectionDoc);
      notifyEditorChanged();
      return true;
    }

    const doc = savedSelectionDoc || getIframeDoc() || document;
    const body =
      (savedSelectionDoc && savedSelectionDoc.querySelector('[contenteditable="true"]')) ||
      findParentEditable() ||
      getIframeBody();
    if (!doc || !body || !body.isContentEditable) return false;

    restoreSelection();
    const inserted = doc.execCommand('insertHTML', false, html);
    rememberSelection(doc);
    notifyEditorChanged();
    return inserted;
  }

  function notifyEditorChanged() {
    getEditableContexts().forEach(function (ctx) {
      ctx.body.dispatchEvent(new Event('input', { bubbles: true }));
      ctx.body.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const editor = getTinyMceEditor();
    if (editor) {
      editor.setDirty(true);
      editor.save();
    }
  }

  // ---------------------------------------------------------------------------
  // Custom NTT context menu.
  //
  // The menu is a <dialog> opened via .show() (non-modal) so it renders in
  // the browser's top layer, above every other stacking context. In Fullscreen
  // API mode the browser still hides any element OUTSIDE the fullscreen
  // subtree, so showContextMenu() re-parents the dialog into the fullscreen
  // element when one is active.
  //
  // We listen for `contextmenu` on every editor doc — iframe AND parent — so
  // right-clicks fire our handler whether the editable is in the iframe or
  // lifted into the parent doc.
  // ---------------------------------------------------------------------------

  let contextTarget = null;

  function handleEditableContextMenu(event) {
    const target = event.target;
    if (!target || !target.closest) return;

    // Only intercept right-clicks inside an editable area.
    const editable = target.closest('[contenteditable="true"]');
    if (!editable) return;

    const tab = target.closest('.ntt-tab');
    const tabsRoot = target.closest('.ntt-tabs');
    const accordionHeader = target.closest('.ntt-accordion-header');
    const accordionItem = accordionHeader
      ? accordionHeader.closest('.ntt-accordion-item')
      : target.closest('.ntt-accordion-item');
    const accordionRoot = accordionHeader
      ? accordionHeader.closest('.ntt-accordion')
      : target.closest('.ntt-accordion');

    // Component "title bar" is a ::before pseudo-element on the component
    // root; right-clicks on a pseudo-element route to the host.
    let componentRoot = null;
    if (target === tabsRoot) componentRoot = tabsRoot;
    else if (target === accordionRoot) componentRoot = accordionRoot;

    // If the click is inside a tab-panel or accordion-panel's CONTENT area,
    // treat it as free-form editable content: only the Insert + panel-
    // specific sections apply. Component-level options (placement, width,
    // align, behavior, delete) live on the tab label, accordion header, or
    // title bar so the user can reach them deliberately rather than seeing
    // them every time they edit panel content.
    const tabPanel = target.closest('.ntt-tab-panel');
    const accordionPanel = target.closest('.ntt-accordion-panel');

    // Components can nest (e.g. an accordion inside a tab panel). When the
    // accordion lives inside this tab panel, a click on the accordion — its
    // header or its own content — targets the accordion (the inner
    // component), not the enclosing tab panel.
    const accordionInsideTabPanel = Boolean(
      accordionRoot && tabPanel && tabPanel.contains(accordionRoot)
    );

    const inTabPanel = Boolean(tabPanel) && !accordionInsideTabPanel;
    const inAccordionPanel = Boolean(accordionPanel) && !Boolean(accordionHeader);
    const inPanel = inTabPanel || inAccordionPanel;
    const fileRow = target.closest('.ntt-file-row');

    // A nested accordion is the active component, so ignore the outer tabs.
    const ctxTabsRoot = (inPanel || accordionInsideTabPanel) ? null : tabsRoot;
    const ctxAccordionRoot = inPanel ? null : accordionRoot;
    const ctxAccordionItem = inPanel ? null : accordionItem;
    const nttComponent = ctxTabsRoot || ctxAccordionRoot;

    // Heading toggle target. In a tab panel: the panel's first h1-h6. On
    // a component title bar: the .ntt-component-title (or first heading
    // child of the component root).
    let toggleableHeading = null;
    if (inTabPanel) {
      toggleableHeading = tabPanel.querySelector('h1, h2, h3, h4, h5, h6');
    } else if (componentRoot) {
      toggleableHeading =
        componentRoot.querySelector(':scope > .ntt-component-title') ||
        Array.from(componentRoot.children).find(function (child) {
          return /^H[1-6]$/.test(child.tagName);
        }) ||
        null;
    }

    const insideComponent = Boolean(nttComponent);
    const isTab = Boolean(tab);
    const isAccordionHeader = Boolean(accordionHeader);
    const isComponentRoot = Boolean(componentRoot);
    const isInTabs = Boolean(ctxTabsRoot);
    const isInAccordion = Boolean(ctxAccordionRoot);
    const isInAccordionPanel = inAccordionPanel;
    const isOnFileRow = Boolean(fileRow);
    const hasToggleableHeading = Boolean(toggleableHeading);
    const canInsert = !insideComponent;

    // If we have nothing to offer, let the browser's native menu show.
    if (!canInsert && !isTab && !isAccordionHeader && !isComponentRoot &&
        !isInTabs && !insideComponent && !isInAccordionPanel &&
        !hasToggleableHeading) return;

    contextTarget = {
      originalTarget: target,
      ownerDoc: target.ownerDocument,
      tab,
      tabsRoot: ctxTabsRoot,
      accordionHeader,
      accordionItem: ctxAccordionItem,
      accordionRoot: ctxAccordionRoot,
      accordionPanel,
      tabPanel,
      fileRow,
      componentRoot,
      nttComponent,
      toggleableHeading
    };

    rememberSelection(target.ownerDocument);
    event.preventDefault();

    // Translate iframe-relative coords to the parent viewport. Parent-doc
    // events are already in parent-viewport coords.
    let x = event.clientX;
    let y = event.clientY;
    if (target.ownerDocument !== document) {
      const iframe = getTinyMceIframe();
      if (iframe) {
        const rect = iframe.getBoundingClientRect();
        x = rect.left + event.clientX;
        y = rect.top + event.clientY;
      }
    }

    showContextMenu({
      x: x,
      y: y,
      isTab: isTab,
      isAccordionHeader: isAccordionHeader,
      isComponentRoot: isComponentRoot,
      isInTabs: isInTabs,
      tabsPlacement: isInTabs ? getTabsPlacement(tabsRoot) : null,
      isInAccordion: isInAccordion,
      accordionExpand: isInAccordion ? getAccordionExpand(accordionRoot) : null,
      inComponent: insideComponent,
      componentWidth: insideComponent ? getComponentWidth(nttComponent) : null,
      componentAlign: insideComponent ? getComponentAlign(nttComponent) : null,
      canInsert: canInsert,
      hasToggleableHeading: hasToggleableHeading,
      headingHidden: hasToggleableHeading ? isHeadingHidden(toggleableHeading) : false,
      isInAccordionPanel: isInAccordionPanel,
      isOnFileRow: isOnFileRow
    });
  }

  function isHeadingHidden(heading) {
    return Boolean(heading && heading.classList.contains('ntt-is-hidden'));
  }

  function setToggleableHeadingHidden(hidden) {
    const heading = contextTarget && contextTarget.toggleableHeading;
    if (!heading) return;
    heading.classList.toggle('ntt-is-hidden', hidden);
    notifyEditorChanged();
  }

  function addFileDownloadRow() {
    const panel = contextTarget && contextTarget.accordionPanel;
    if (!panel) return;
    const doc = (contextTarget && contextTarget.ownerDoc) || document;

    const tmp = doc.createElement('div');
    tmp.innerHTML = getFileRowHtml();
    const row = tmp.firstElementChild;
    if (!row) return;

    // Insert at the end of the panel so multiple rows stack naturally.
    panel.appendChild(row);
    notifyEditorChanged();
  }

  function deleteFileDownloadRow() {
    const row = contextTarget && contextTarget.fileRow;
    if (!row) return;
    row.remove();
    notifyEditorChanged();
  }

  function openSetDownloadLinkDialog() {
    const row = contextTarget && contextTarget.fileRow;
    if (!row) return;
    const link = row.querySelector('.ntt-file-row__name');
    if (!link || link.tagName !== 'A') return;

    showLinkDialog({
      url: link.getAttribute('href') === '#' ? '' : link.getAttribute('href') || '',
      name: (link.textContent.trim()) || link.getAttribute('title') || '',
      onSubmit: function (values) {
        link.setAttribute('href', values.url);
        if (values.name) {
          link.setAttribute('title', values.name);
          link.textContent = values.name;
        }
        const ext = extractExtension(values.url, values.name);
        if (ext) row.setAttribute('data-ext', ext);
        notifyEditorChanged();
      }
    });
  }

  function extractExtension(url, name) {
    const candidates = [name || '', (url || '').split('?')[0].split('#')[0]];
    for (let i = 0; i < candidates.length; i++) {
      const m = candidates[i].match(/\.([a-z0-9]+)$/i);
      if (m) return m[1].toLowerCase();
    }
    return '';
  }

  function getComponentWidth(root) {
    if (!root) return 'full';
    if (root.classList.contains('ntt-width-narrow')) return 'narrow';
    if (root.classList.contains('ntt-width-medium')) return 'medium';
    if (root.classList.contains('ntt-width-wide')) return 'wide';
    return 'full';
  }

  function setComponentWidth(width) {
    const root = contextTarget && contextTarget.nttComponent;
    if (!root) return;
    root.classList.remove('ntt-width-narrow', 'ntt-width-medium', 'ntt-width-wide');
    if (width && width !== 'full') {
      root.classList.add('ntt-width-' + width);
    }
    notifyEditorChanged();
  }

  function getAccordionExpand(root) {
    if (!root) return 'multiple';
    if (root.classList.contains('ntt-accordion--expand-single')) return 'single';
    return 'multiple';
  }

  function setAccordionExpand(mode) {
    const root = contextTarget && contextTarget.accordionRoot;
    if (!root) return;
    root.classList.remove('ntt-accordion--expand-single');
    if (mode === 'single') {
      root.classList.add('ntt-accordion--expand-single');
    }
    notifyEditorChanged();
  }

  function getComponentAlign(root) {
    if (!root) return 'center';
    if (root.classList.contains('ntt-align-left')) return 'left';
    if (root.classList.contains('ntt-align-right')) return 'right';
    return 'center';
  }

  function setComponentAlign(align) {
    const root = contextTarget && contextTarget.nttComponent;
    if (!root) return;
    root.classList.remove('ntt-align-left', 'ntt-align-center', 'ntt-align-right');
    // Center is the implicit default — only add a class for non-default.
    if (align === 'left' || align === 'right') {
      root.classList.add('ntt-align-' + align);
    }
    notifyEditorChanged();
  }

  function getTabsPlacement(tabsRoot) {
    if (!tabsRoot) return 'top';
    if (tabsRoot.classList.contains('ntt-tabs--placement-bottom')) return 'bottom';
    if (tabsRoot.classList.contains('ntt-tabs--placement-start')) return 'start';
    if (tabsRoot.classList.contains('ntt-tabs--placement-end')) return 'end';
    return 'top';
  }

  function setTabsPlacement(placement) {
    const tabsRoot = contextTarget && contextTarget.tabsRoot;
    if (!tabsRoot) return;
    tabsRoot.classList.remove(
      'ntt-tabs--placement-bottom',
      'ntt-tabs--placement-start',
      'ntt-tabs--placement-end'
    );
    if (placement && placement !== 'top') {
      tabsRoot.classList.add('ntt-tabs--placement-' + placement);
    }
    notifyEditorChanged();
  }

  function createContextMenu() {
    if (document.getElementById('ntt-context-menu')) return;

    const menu = document.createElement('dialog');
    menu.id = 'ntt-context-menu';
    menu.innerHTML = `
      <div class="ntt-context-menu__title">NTT Canvas Editor</div>

      <div class="ntt-context-menu__section" data-ntt-insert-section hidden>
        <div class="ntt-context-menu__section-label">Insert</div>
        <button type="button" data-ntt-action="insert-tabs">Insert Tabs</button>
        <button type="button" data-ntt-action="insert-accordion">Insert Accordion</button>
      </div>

      <div class="ntt-context-menu__section" data-ntt-heading-section hidden>
        <div class="ntt-context-menu__section-label">Heading</div>
        <button type="button" data-ntt-action="toggle-heading" data-ntt-heading-label>Hide Heading</button>
      </div>

      <div class="ntt-context-menu__section" data-ntt-file-row-section hidden>
        <div class="ntt-context-menu__section-label">File Download</div>
        <button type="button" data-ntt-action="add-file-row">Add File Download Row</button>
        <button type="button" data-ntt-action="set-file-link" data-ntt-file-link>Set Download Link…</button>
        <button type="button" data-ntt-action="delete-file-row" class="is-danger" data-ntt-file-delete>Delete File Download Row</button>
      </div>

      <div class="ntt-context-menu__section" data-ntt-tab-section hidden>
        <div class="ntt-context-menu__section-label">Tabs</div>
        <button type="button" data-ntt-action="insert-tab-before">Insert Tab Before</button>
        <button type="button" data-ntt-action="insert-tab-after">Insert Tab After</button>
        <button type="button" data-ntt-action="delete-tab" class="is-danger">Delete Tab</button>
      </div>

      <div class="ntt-context-menu__section" data-ntt-accordion-section hidden>
        <div class="ntt-context-menu__section-label">Accordion</div>
        <button type="button" data-ntt-action="insert-accordion-item-before">Insert Before</button>
        <button type="button" data-ntt-action="insert-accordion-item-after">Insert After</button>
        <button type="button" data-ntt-action="delete-accordion-item" class="is-danger">Delete</button>
      </div>

      <div class="ntt-context-menu__section" data-ntt-tabs-placement-section hidden>
        <div class="ntt-context-menu__section-label">Tabs Placement</div>
        <button type="button" data-ntt-action="set-tabs-placement-top" data-placement="top">Top</button>
        <button type="button" data-ntt-action="set-tabs-placement-bottom" data-placement="bottom">Bottom</button>
        <button type="button" data-ntt-action="set-tabs-placement-start" data-placement="start">Start (left)</button>
        <button type="button" data-ntt-action="set-tabs-placement-end" data-placement="end">End (right)</button>
      </div>

      <div class="ntt-context-menu__section" data-ntt-accordion-expand-section hidden>
        <div class="ntt-context-menu__section-label">Accordion Behavior</div>
        <button type="button" data-ntt-action="set-accordion-expand-single" data-expand="single">Expand Single</button>
        <button type="button" data-ntt-action="set-accordion-expand-multiple" data-expand="multiple">Expand Multiple</button>
      </div>

      <div class="ntt-context-menu__section" data-ntt-width-section hidden>
        <div class="ntt-context-menu__section-label">Width</div>
        <button type="button" data-ntt-action="set-width-narrow" data-width="narrow">Narrow</button>
        <button type="button" data-ntt-action="set-width-medium" data-width="medium">Medium</button>
        <button type="button" data-ntt-action="set-width-wide" data-width="wide">Wide</button>
        <button type="button" data-ntt-action="set-width-full" data-width="full">Full</button>
      </div>

      <div class="ntt-context-menu__section" data-ntt-align-section hidden>
        <div class="ntt-context-menu__section-label">Align</div>
        <button type="button" data-ntt-action="set-align-left" data-align="left">Left</button>
        <button type="button" data-ntt-action="set-align-center" data-align="center">Center</button>
        <button type="button" data-ntt-action="set-align-right" data-align="right">Right</button>
      </div>

      <div class="ntt-context-menu__section" data-ntt-component-section hidden>
        <div class="ntt-context-menu__section-label">Component</div>
        <button type="button" data-ntt-action="delete-component" class="is-danger">Delete Component</button>
      </div>
    `;
    document.body.appendChild(menu);

    // Prevent the menu from stealing focus from TinyMCE on mousedown.
    menu.addEventListener('mousedown', function (event) {
      event.preventDefault();
    });

    menu.addEventListener('click', function (event) {
      const button = event.target.closest('button[data-ntt-action]');
      if (!button) return;
      runContextAction(button.getAttribute('data-ntt-action'));
      hideContextMenu();
    });

    // Parent-doc dismissers (work in fullscreen too).
    document.addEventListener('click', function (event) {
      if (!menu.contains(event.target)) hideContextMenu();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') hideContextMenu();
    });
    window.addEventListener('blur', hideContextMenu);
    window.addEventListener('scroll', hideContextMenu, true);

    // Parent-doc contextmenu listener — handles fullscreen mode where Canvas
    // runs the editable inline in the parent document instead of an iframe.
    document.addEventListener('contextmenu', handleEditableContextMenu, true);

    // Hide on fullscreen transitions; the next right-click re-parents the
    // dialog into the new active container.
    document.addEventListener('fullscreenchange', hideContextMenu);
  }

  function showContextMenu(options) {
    createContextMenu();
    const menu = document.getElementById('ntt-context-menu');
    if (!menu) return;

    // Fullscreen API auto-hides everything outside the fullscreen subtree
    // (you see this as aria-hidden="true" on out-of-tree nodes). Move the
    // dialog into the active fullscreen element so it actually renders.
    const fsElement = document.fullscreenElement;
    const targetParent = fsElement || document.body;
    if (menu.parentElement !== targetParent) {
      if (menu.open) menu.close();
      targetParent.appendChild(menu);
    }

    const insertSection = menu.querySelector('[data-ntt-insert-section]');
    const headingSection = menu.querySelector('[data-ntt-heading-section]');
    const fileRowSection = menu.querySelector('[data-ntt-file-row-section]');
    const tabSection = menu.querySelector('[data-ntt-tab-section]');
    const accordionSection = menu.querySelector('[data-ntt-accordion-section]');
    const tabsPlacementSection = menu.querySelector('[data-ntt-tabs-placement-section]');
    const accordionExpandSection = menu.querySelector('[data-ntt-accordion-expand-section]');
    const widthSection = menu.querySelector('[data-ntt-width-section]');
    const alignSection = menu.querySelector('[data-ntt-align-section]');
    const componentSection = menu.querySelector('[data-ntt-component-section]');
    insertSection.hidden = !options.canInsert;
    headingSection.hidden = !options.hasToggleableHeading;
    fileRowSection.hidden = !(options.isInAccordionPanel || options.isOnFileRow);
    tabSection.hidden = !options.isTab;
    accordionSection.hidden = !options.isAccordionHeader;
    tabsPlacementSection.hidden = !options.isInTabs;
    accordionExpandSection.hidden = !options.isInAccordion;
    widthSection.hidden = !options.inComponent;
    alignSection.hidden = !options.inComponent;
    componentSection.hidden = !options.isComponentRoot;

    // Heading-toggle button label reflects current state.
    if (options.hasToggleableHeading) {
      const labelBtn = headingSection.querySelector('[data-ntt-heading-label]');
      if (labelBtn) {
        labelBtn.textContent = options.headingHidden ? 'Show Heading' : 'Hide Heading';
      }
    }

    // Show "Set Download Link" + "Delete" only when right-click is on a row.
    const fileLinkBtn = fileRowSection.querySelector('[data-ntt-file-link]');
    const fileDeleteBtn = fileRowSection.querySelector('[data-ntt-file-delete]');
    if (fileLinkBtn) fileLinkBtn.hidden = !options.isOnFileRow;
    if (fileDeleteBtn) fileDeleteBtn.hidden = !options.isOnFileRow;

    // Mark the active placement button.
    if (options.isInTabs) {
      Array.from(tabsPlacementSection.querySelectorAll('button[data-placement]')).forEach(function (btn) {
        const isCurrent = btn.getAttribute('data-placement') === options.tabsPlacement;
        btn.classList.toggle('is-current', isCurrent);
      });
    }

    // Mark the active accordion expand-mode button.
    if (options.isInAccordion) {
      Array.from(accordionExpandSection.querySelectorAll('button[data-expand]')).forEach(function (btn) {
        const isCurrent = btn.getAttribute('data-expand') === options.accordionExpand;
        btn.classList.toggle('is-current', isCurrent);
      });
    }

    // Mark the active width button.
    if (options.inComponent) {
      Array.from(widthSection.querySelectorAll('button[data-width]')).forEach(function (btn) {
        const isCurrent = btn.getAttribute('data-width') === options.componentWidth;
        btn.classList.toggle('is-current', isCurrent);
      });
    }

    // Mark the active align button.
    if (options.inComponent) {
      Array.from(alignSection.querySelectorAll('button[data-align]')).forEach(function (btn) {
        const isCurrent = btn.getAttribute('data-align') === options.componentAlign;
        btn.classList.toggle('is-current', isCurrent);
      });
    }

    menu.style.left = `${options.x}px`;
    menu.style.top = `${options.y}px`;

    if (typeof menu.show === 'function' && !menu.open) menu.show();
    menu.classList.add('is-open');

    // Keep the menu on-screen if the click was near a viewport edge.
    const rect = menu.getBoundingClientRect();
    const overflowX = rect.right - window.innerWidth;
    const overflowY = rect.bottom - window.innerHeight;
    if (overflowX > 0) menu.style.left = `${options.x - overflowX - 8}px`;
    if (overflowY > 0) menu.style.top = `${options.y - overflowY - 8}px`;
  }

  function hideContextMenu() {
    const menu = document.getElementById('ntt-context-menu');
    if (!menu) return;
    if (typeof menu.close === 'function' && menu.open) menu.close();
    menu.classList.remove('is-open');
  }

  function runContextAction(action) {
    if (action === 'insert-tabs') {
      insertHtml('\n' + getTabsHtml() + '\n');
      return;
    }
    if (action === 'insert-accordion') {
      insertHtml('\n' + getAccordionHtml() + '\n');
      return;
    }
    if (action === 'insert-tab-before') {
      insertTabRelativeToCurrent('before');
      return;
    }
    if (action === 'insert-tab-after') {
      insertTabRelativeToCurrent('after');
      return;
    }
    if (action === 'delete-tab') {
      deleteCurrentTab();
      return;
    }
    if (action === 'insert-accordion-item-before') {
      insertAccordionItemRelative('before');
      return;
    }
    if (action === 'insert-accordion-item-after') {
      insertAccordionItemRelative('after');
      return;
    }
    if (action === 'delete-accordion-item') {
      deleteCurrentAccordionItem();
      return;
    }
    if (action === 'delete-component') {
      deleteCurrentComponent();
      return;
    }
    if (action === 'set-tabs-placement-top') { setTabsPlacement('top'); return; }
    if (action === 'set-tabs-placement-bottom') { setTabsPlacement('bottom'); return; }
    if (action === 'set-tabs-placement-start') { setTabsPlacement('start'); return; }
    if (action === 'set-tabs-placement-end') { setTabsPlacement('end'); return; }
    if (action === 'set-width-narrow') { setComponentWidth('narrow'); return; }
    if (action === 'set-width-medium') { setComponentWidth('medium'); return; }
    if (action === 'set-width-wide') { setComponentWidth('wide'); return; }
    if (action === 'set-width-full') { setComponentWidth('full'); return; }
    if (action === 'set-align-left') { setComponentAlign('left'); return; }
    if (action === 'set-align-center') { setComponentAlign('center'); return; }
    if (action === 'set-align-right') { setComponentAlign('right'); return; }
    if (action === 'set-accordion-expand-single') { setAccordionExpand('single'); return; }
    if (action === 'set-accordion-expand-multiple') { setAccordionExpand('multiple'); return; }
    if (action === 'toggle-heading') {
      const heading = contextTarget && contextTarget.toggleableHeading;
      setToggleableHeadingHidden(heading ? !isHeadingHidden(heading) : true);
      return;
    }
    if (action === 'add-file-row') { addFileDownloadRow(); return; }
    if (action === 'delete-file-row') { deleteFileDownloadRow(); return; }
    if (action === 'set-file-link') { openSetDownloadLinkDialog(); return; }
  }

  // ---------------------------------------------------------------------------
  // Component-level operations. The document used for createElement comes
  // from the right-clicked target so we operate in the right tree (iframe vs
  // parent doc).
  // ---------------------------------------------------------------------------

  function getContextDoc() {
    return (contextTarget && contextTarget.ownerDoc) || getIframeDoc() || document;
  }

  function deleteCurrentComponent() {
    const componentRoot = contextTarget && contextTarget.componentRoot;
    if (!componentRoot) return;
    componentRoot.remove();
    notifyEditorChanged();
  }

  function insertTabRelativeToCurrent(position) {
    const currentTab = contextTarget && contextTarget.tab;
    const tabsRoot = contextTarget && contextTarget.tabsRoot;
    if (!currentTab || !tabsRoot) return;

    const doc = getContextDoc();
    const tabList = tabsRoot.querySelector('.ntt-tabs-list');
    const panels = Array.from(tabsRoot.querySelectorAll('.ntt-tab-panel'));
    const tabs = Array.from(tabsRoot.querySelectorAll('.ntt-tab'));
    const currentIndex = tabs.indexOf(currentTab);
    if (currentIndex === -1) return;

    const uid = 'ntt-tab-' + Date.now();
    const title = 'New Tab';

    const newTab = doc.createElement('a');
    newTab.className = 'ntt-tab';
    newTab.href = `#${uid}-panel`;
    newTab.setAttribute('role', 'tab');
    newTab.setAttribute('aria-selected', 'false');
    newTab.setAttribute('tabindex', '-1');
    newTab.setAttribute('aria-controls', `${uid}-panel`);
    newTab.id = `${uid}-button`;
    newTab.textContent = title;

    const newPanel = doc.createElement('div');
    newPanel.className = 'ntt-tab-panel';
    newPanel.setAttribute('role', 'tabpanel');
    newPanel.id = `${uid}-panel`;
    newPanel.setAttribute('aria-labelledby', `${uid}-button`);
    newPanel.innerHTML = `<h3>${title}</h3><p>Add content here.</p>`;

    if (position === 'before') {
      tabList.insertBefore(newTab, currentTab);
      tabsRoot.insertBefore(newPanel, panels[currentIndex]);
    } else {
      tabList.insertBefore(newTab, currentTab.nextSibling);
      tabsRoot.insertBefore(newPanel, panels[currentIndex + 1] || null);
    }

    notifyEditorChanged();
  }

  function deleteCurrentTab() {
    const currentTab = contextTarget && contextTarget.tab;
    const tabsRoot = contextTarget && contextTarget.tabsRoot;
    if (!currentTab || !tabsRoot) return;

    const tabs = Array.from(tabsRoot.querySelectorAll('.ntt-tab'));
    if (tabs.length <= 1) {
      alert('A tabs component must have at least one tab.');
      return;
    }

    const currentIndex = tabs.indexOf(currentTab);
    const panelId = currentTab.getAttribute('aria-controls');
    const panel = panelId
      ? tabsRoot.querySelector('#' + CSS.escape(panelId))
      : null;

    const wasActive =
      currentTab.classList.contains('is-active') ||
      currentTab.getAttribute('aria-selected') === 'true';

    currentTab.remove();
    if (panel) panel.remove();

    if (wasActive) {
      const remaining = Array.from(tabsRoot.querySelectorAll('.ntt-tab'));
      const nextTab =
        remaining[currentIndex] || remaining[currentIndex - 1] || remaining[0];
      if (nextTab) activateAuthoringTab(tabsRoot, nextTab);
    }

    notifyEditorChanged();
  }

  function activateAuthoringTab(tabsRoot, activeTab) {
    const tabs = Array.from(tabsRoot.querySelectorAll('.ntt-tab'));
    const panels = Array.from(tabsRoot.querySelectorAll('.ntt-tab-panel'));

    tabs.forEach(function (tab) {
      const isActive = tab === activeTab;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      tab.setAttribute('tabindex', isActive ? '0' : '-1');
    });

    panels.forEach(function (panel) {
      const isActive = panel.id === activeTab.getAttribute('aria-controls');
      panel.classList.toggle('is-active', isActive);
      // Authoring mode: leave panels visible so the author can edit them.
      panel.removeAttribute('hidden');
    });
  }

  function insertAccordionItemRelative(position) {
    let currentItem = contextTarget && contextTarget.accordionItem;
    const accordionHeader = contextTarget && contextTarget.accordionHeader;
    let accordionRoot = contextTarget && contextTarget.accordionRoot;
    if (!currentItem && accordionHeader) {
      currentItem = accordionHeader.closest('.ntt-accordion-item');
    }
    if (!accordionRoot && currentItem) {
      accordionRoot = currentItem.closest('.ntt-accordion');
    }
    if (!currentItem || !accordionRoot) return;

    const doc = getContextDoc();
    const uid = 'ntt-accordion-item-' + Date.now();
    const title = 'New Section';

    const newItem = doc.createElement('div');
    newItem.className = 'ntt-accordion-item';

    const newHeader = doc.createElement('a');
    newHeader.className = 'ntt-accordion-header';
    newHeader.href = `#${uid}-panel`;
    newHeader.setAttribute('role', 'button');
    newHeader.setAttribute('aria-expanded', 'false');
    newHeader.setAttribute('aria-controls', `${uid}-panel`);
    newHeader.id = `${uid}-header`;
    newHeader.textContent = title;

    const newPanel = doc.createElement('div');
    newPanel.className = 'ntt-accordion-panel';
    newPanel.setAttribute('role', 'region');
    newPanel.id = `${uid}-panel`;
    newPanel.setAttribute('aria-labelledby', `${uid}-header`);
    newPanel.innerHTML = '<p>Add content here.</p>';

    newItem.appendChild(newHeader);
    newItem.appendChild(newPanel);

    if (position === 'before') {
      accordionRoot.insertBefore(newItem, currentItem);
    } else {
      accordionRoot.insertBefore(newItem, currentItem.nextSibling);
    }

    notifyEditorChanged();
  }

  function deleteCurrentAccordionItem() {
    const currentItem = contextTarget && contextTarget.accordionItem;
    const accordionRoot = contextTarget && contextTarget.accordionRoot;

    if (!currentItem || !accordionRoot) {
      alert('Could not delete accordion item. Please try again.');
      return;
    }

    const items = Array.from(accordionRoot.querySelectorAll('.ntt-accordion-item'));
    if (items.length <= 1) {
      alert('An accordion must have at least one section.');
      return;
    }

    currentItem.remove();
    notifyEditorChanged();
  }

  // ---------------------------------------------------------------------------
  // Tab label ↔ panel heading sync — bidirectional.
  //
  // Edits inside a `.ntt-tab` → copy text to the first heading in the panel
  // pointed to by aria-controls.
  // Edits inside the first heading in a `.ntt-tab-panel` → copy text to the
  // `.ntt-tab` whose aria-controls points at that panel.
  //
  // Each direction checks equality before writing, so the cascade short-
  // circuits and there's no infinite loop.
  // ---------------------------------------------------------------------------

  function observeEditable(root) {
    if (!root || root.__nttSyncObserverBound) return;
    root.__nttSyncObserverBound = true;

    const observer = new MutationObserver(function (mutations) {
      const seenTabs = new Set();
      const seenHeadings = new Set();
      mutations.forEach(function (mutation) {
        let node = mutation.target;
        while (node && node !== root) {
          if (node.nodeType === 1) {
            if (node.matches && node.matches('.ntt-tab')) {
              if (!seenTabs.has(node)) {
                seenTabs.add(node);
                syncTabPanelHeading(node);
              }
              return;
            }
            if (/^H[1-6]$/.test(node.tagName || '')) {
              const panel = node.closest('.ntt-tab-panel');
              if (panel) {
                const firstHeading = panel.querySelector('h1, h2, h3, h4, h5, h6');
                if (firstHeading === node && !seenHeadings.has(node)) {
                  seenHeadings.add(node);
                  syncTabFromPanelHeading(node, panel);
                }
                return;
              }
            }
          }
          node = node.parentNode;
        }
      });
    });

    observer.observe(root, {
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  function syncTabPanelHeading(tab) {
    const tabsRoot = tab.closest('.ntt-tabs');
    if (!tabsRoot) return;
    const panelId = tab.getAttribute('aria-controls');
    if (!panelId) return;
    const panel = tabsRoot.querySelector('#' + CSS.escape(panelId));
    if (!panel) return;
    const heading = panel.querySelector('h1, h2, h3, h4, h5, h6');
    if (!heading) return;

    const newText = (tab.textContent || '').replace(/\s+/g, ' ').trim();
    if ((heading.textContent || '').trim() === newText) return;
    heading.textContent = newText;
  }

  function syncTabFromPanelHeading(heading, panel) {
    const tabsRoot = panel.closest('.ntt-tabs');
    if (!tabsRoot) return;
    const panelId = panel.id;
    if (!panelId) return;

    const tab = Array.from(tabsRoot.querySelectorAll('.ntt-tab')).find(function (t) {
      return t.getAttribute('aria-controls') === panelId;
    });
    if (!tab) return;

    const newText = (heading.textContent || '').replace(/\s+/g, ' ').trim();
    if ((tab.textContent || '').trim() === newText) return;
    tab.textContent = newText;
  }

  // ---------------------------------------------------------------------------
  // Integration binding.
  //
  // Each editable context (iframe doc or parent doc) gets:
  //  - contextmenu listener (capture phase, idempotent via doc flag)
  //  - click + Esc dismissers for the menu
  //  - preview CSS in its <head>
  //  - MutationObserver for tab ↔ heading sync (per-body flag)
  //
  // We poll periodically so newly-appearing editables (e.g. after a
  // fullscreen toggle that drops + recreates the iframe) get wired up.
  // ---------------------------------------------------------------------------

  function bindIntegration() {
    getEditableContexts().forEach(function (ctx) {
      const doc = ctx.doc;
      const body = ctx.body;

      if (!doc.__nttAuthoringBound) {
        doc.__nttAuthoringBound = true;
        doc.addEventListener('contextmenu', handleEditableContextMenu, true);
        doc.addEventListener('click', hideContextMenu);
        doc.addEventListener('keydown', function (event) {
          if (event.key === 'Escape') hideContextMenu();
        });
        injectPreviewCss(doc);
        console.log(
          '[NTT] Bound editor integration on',
          doc === document ? 'parent doc' : 'iframe doc'
        );
      }

      observeEditable(body);
    });
  }

  function startIntegrationLoop() {
    bindIntegration();
    // Keep retrying — the iframe/parent editable can come and go on
    // fullscreen toggles. Idempotent flags make this cheap.
    setInterval(bindIntegration, 1000);
    document.addEventListener('fullscreenchange', function () {
      // Give Canvas a beat to swap the editable, then re-bind.
      setTimeout(bindIntegration, 0);
    });
  }

  // ---------------------------------------------------------------------------
  // Set Download Link dialog — a small modal that asks for a URL (and
  // optionally a file name) and applies it to the file row's Download
  // button. Uses a <dialog> opened in modal mode so it lives in the top
  // layer above any TinyMCE fullscreen container.
  // ---------------------------------------------------------------------------

  let linkDialogResolve = null;

  function createLinkDialog() {
    if (document.getElementById('ntt-link-dialog')) return;

    const dialog = document.createElement('dialog');
    dialog.id = 'ntt-link-dialog';
    dialog.innerHTML = `
      <form method="dialog" data-ntt-link-form>
        <h3 class="ntt-link-dialog__title">Set Download Link</h3>
        <p class="ntt-link-dialog__hint">Paste a URL to attach to this row's Download button.</p>
        <label class="ntt-link-dialog__field">
          <span>URL</span>
          <input type="url" name="url" required placeholder="https://...">
        </label>
        <label class="ntt-link-dialog__field">
          <span>File name (optional)</span>
          <input type="text" name="name" placeholder="Course Overview.pdf">
        </label>
        <div class="ntt-link-dialog__actions">
          <button type="button" data-ntt-link-cancel>Cancel</button>
          <button type="submit" data-ntt-link-ok>OK</button>
        </div>
      </form>
    `;
    document.body.appendChild(dialog);

    const form = dialog.querySelector('[data-ntt-link-form]');
    const cancelBtn = dialog.querySelector('[data-ntt-link-cancel]');

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      const formData = new FormData(form);
      const url = String(formData.get('url') || '').trim();
      const name = String(formData.get('name') || '').trim();
      if (!url) return;
      closeLinkDialog({ url: url, name: name });
    });

    cancelBtn.addEventListener('click', function () {
      closeLinkDialog(null);
    });

    dialog.addEventListener('cancel', function () {
      // Triggered by Esc.
      closeLinkDialog(null);
    });
  }

  function showLinkDialog(options) {
    createLinkDialog();
    const dialog = document.getElementById('ntt-link-dialog');
    if (!dialog) return;

    // Re-parent into the fullscreen subtree if one is active, same trick
    // as the context menu.
    const fsElement = document.fullscreenElement;
    const targetParent = fsElement || document.body;
    if (dialog.parentElement !== targetParent) {
      if (dialog.open) dialog.close();
      targetParent.appendChild(dialog);
    }

    const form = dialog.querySelector('[data-ntt-link-form]');
    form.reset();
    if (options && options.url) form.elements['url'].value = options.url;
    if (options && options.name) form.elements['name'].value = options.name;

    linkDialogResolve = function (values) {
      if (values && options && typeof options.onSubmit === 'function') {
        options.onSubmit(values);
      }
    };

    if (typeof dialog.showModal === 'function' && !dialog.open) {
      dialog.showModal();
    }

    // Focus the URL input shortly after — showModal moves focus to the
    // dialog itself first.
    setTimeout(function () {
      const urlInput = form.elements['url'];
      if (urlInput) urlInput.focus();
    }, 0);
  }

  function closeLinkDialog(values) {
    const dialog = document.getElementById('ntt-link-dialog');
    if (dialog && dialog.open) dialog.close();
    const resolve = linkDialogResolve;
    linkDialogResolve = null;
    if (resolve) resolve(values);
  }

  // ---------------------------------------------------------------------------
  // Boot.
  // ---------------------------------------------------------------------------

  createContextMenu();
  createLinkDialog();
  startIntegrationLoop();
})();
