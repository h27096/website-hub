/* Stored documents are a small JSON tree, never HTML. Only the renderer below
   creates elements; arbitrary attributes, styles and executable nodes are absent. */
(() => {
  'use strict';
  const tags = new Set(['p','h1','h2','h3','strong','em','u','ul','ol','li','a','br']);
  const safeURL = value => {
    if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\/[^\s\u0000-\u001f\u007f]+$/i.test(value) || value.includes('\\')) return false;
    try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
  };
  function renderNode(node, depth = 0) {
    if (!node || depth > 16) throw new Error('Invalid document format');
    if (node.type === 'text' && typeof node.text === 'string') return document.createTextNode(node.text);
    if (node.type === 'logo') {
      const logo = document.createElement('img');
      logo.src = 'assets/robco-employee-logo.png'; logo.alt = 'RobCo Industries';
      logo.className = 'employee-document-logo'; logo.contentEditable = 'false';
      return logo;
    }
    if (node.type !== 'doc' && !tags.has(node.type)) throw new Error('Unsupported document formatting');
    const el = node.type === 'doc' ? document.createDocumentFragment() : document.createElement(node.type);
    if (node.type === 'a') {
      if (!safeURL(node.href)) throw new Error('Unsafe document link');
      el.href = node.href; el.target = '_blank'; el.rel = 'noopener noreferrer'; el.referrerPolicy = 'no-referrer';
    }
    if (node.type !== 'br') {
      if (!Array.isArray(node.children)) throw new Error('Invalid document format');
      node.children.forEach(child => el.append(renderNode(child, depth + 1)));
    }
    return el;
  }
  function serialize(root) {
    let count = 0;
    function read(node, depth) {
      if (++count > 20000 || depth > 16) throw new Error('Document is too complex. Reduce nested formatting.');
      if (node.nodeType === Node.TEXT_NODE) return [{type:'text',text:node.nodeValue}];
      if (node.nodeType !== Node.ELEMENT_NODE) return [];
      const tag = node.tagName.toLowerCase();
      if (['script','style','iframe','object','embed','svg','math','template'].includes(tag)) return [];
      if (tag === 'img') return node.classList.contains('employee-document-logo') ? [{type:'logo'}] : [];
      const children = [...node.childNodes].flatMap(n => read(n, depth + 1));
      const type = ({div:'p',b:'strong',i:'em'})[tag] || tag;
      if (!tags.has(type)) return children;
      if (type === 'br') return [{type}];
      if (type === 'a') return safeURL(node.getAttribute('href')) ? [{type,href:node.getAttribute('href'),children}] : children;
      return [{type,children}];
    }
    const result = {type:'doc',children:[...root.childNodes].flatMap(n => read(n, 0))};
    if (new TextEncoder().encode(JSON.stringify(result)).length > 450000) throw new Error('Document is too large to save.');
    return result;
  }
  window.RobcoDocument = {renderNode,serialize,safeURL};

  window.openEmployeeDocument = async function (manage = false) {
    if (document.getElementById('employeeDocumentDialog')) return;
    if (manage ? !window.overseerSession?.access_token : !window.employeePassword) return;
    const opener = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.id = 'employeeDocumentDialog'; dialog.className = 'employee-document-dialog';
    dialog.setAttribute('aria-labelledby','employeeDocumentTitle');
    // Constant UI only. No database values are interpolated into HTML.
    dialog.innerHTML = `<header><div><small>ROBCO INDUSTRIES / PERSONNEL ARCHIVE</small><h1 id="employeeDocumentTitle">EMPLOYEE DOCUMENT</h1></div><button type="button" data-action="close">CLOSE</button></header>
      <p class="employee-document-status" role="status" aria-live="polite"></p>
      <div class="employee-document-actions"></div>
      <div class="employee-document-toolbar" role="toolbar" aria-label="Document formatting" hidden></div>
      <article class="employee-document-body" aria-label="Employee document"></article>
      <section class="employee-document-history" aria-label="Revision history" hidden></section>`;
    document.body.append(dialog); dialog.showModal();
    const status = dialog.querySelector('[role=status]');
    const body = dialog.querySelector('article');
    const actions = dialog.querySelector('.employee-document-actions');
    const toolbar = dialog.querySelector('[role=toolbar]');
    const history = dialog.querySelector('.employee-document-history');
    let current, editing = false, busy = false, closed = false, savedRange;
    const requests = new Set();
    const credential = manage ? window.overseerSession.access_token : window.employeePassword;
    const authorized = () => credential === (manage ? window.overseerSession?.access_token : window.employeePassword);
    const button = (label, action, parent = actions) => {
      const el = document.createElement('button'); el.type = 'button'; el.textContent = label;
      el.addEventListener('click', action); parent.append(el); return el;
    };
    function message(text) { if (!closed) status.textContent = text; }
    async function rpc(name, args = {}) {
      if (!authorized()) throw new Error('Session changed. Close this document and sign in again.');
      const controller = new AbortController(); requests.add(controller);
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const headers = {apikey:SUPABASE_KEY,'Content-Type':'application/json'};
        if (manage) headers.Authorization = 'Bearer ' + credential;
        const response = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + name, {
          method:'POST',headers,body:JSON.stringify(args),cache:'no-store',signal:controller.signal
        });
        if (!response.ok) {
          let error; try { error = await response.json(); } catch {}
          if (error?.code === '40001') throw new Error('Another Overseer saved a newer version. Your draft remains here. Copy it before Cancel, then reopen and merge your edits.');
          if (response.status === 401 || response.status === 403) throw new Error('Access denied or session expired. Sign in again.');
          if (error?.code === 'PGRST202') throw new Error('Document setup is required. Run the employee document migration and private seed SQL.');
          throw new Error('Document request failed. Check your connection and database setup, then retry.');
        }
        const result = await response.json();
        if (closed || !authorized()) throw new Error('Session closed or changed.');
        return result;
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('Request timed out. Reopen to check whether a save completed before retrying.');
        throw error;
      } finally { clearTimeout(timer); requests.delete(controller); }
    }
    function show(doc) {
      const fragment = renderNode(doc.content);
      body.replaceChildren(fragment); current = doc;
      message(`REVISION ${doc.revision} · SAVED ${new Date(doc.updated_at).toLocaleString()} · ${manage ? 'OVERSEER ACCESS' : 'READ ONLY'}`);
    }
    async function load() {
      if (busy || editing || closed) return;
      busy = true;
      try {
        const doc = await rpc('read_employee_document',manage ? {} : {employee_password:credential});
        if (!doc) throw new Error('Document not initialized. Ask the Overseer to run the private seed SQL.');
        show(doc);
      } catch (error) { message(error.message); }
      finally { busy = false; controls(); }
    }
    function controls() {
      if (closed) return;
      actions.replaceChildren();
      if (editing) {
        button('SAVE CHANGES',save).disabled = busy;
        button('CANCEL',() => { if (busy) return; editing = false; body.contentEditable = 'false'; toolbar.hidden = true; history.hidden = true; show(current); controls(); load(); }).disabled = busy;
      } else {
        button('REFRESH DOCUMENT',load).disabled = busy;
        if (manage) {
          button('EDIT DOCUMENT',edit).disabled = busy || !current;
          button('VIEW REVISION HISTORY',() => viewHistory()).disabled = busy || !current;
        }
      }
    }
    function edit() {
      if (busy || !current) return;
      editing = true; history.hidden = true; toolbar.hidden = false;
      body.contentEditable = 'true'; body.setAttribute('role','textbox'); body.setAttribute('aria-multiline','true');
      body.focus(); message(`EDITING REVISION ${current.revision} · CHANGES ARE NOT SAVED`); controls();
    }
    async function save() {
      if (!editing || busy) return;
      busy = true; controls(); body.contentEditable = 'false';
      try {
        const doc = await rpc('save_employee_document',{p_content:serialize(body),p_expected_revision:current.revision});
        editing = false; toolbar.hidden = true; body.removeAttribute('role'); show(doc);
      } catch (error) { message(error.message); }
      finally { busy = false; body.contentEditable = String(editing); controls(); }
    }
    async function viewHistory(before = null) {
      if (busy || editing) return;
      busy = true; controls(); history.hidden = false;
      try {
        const revisions = await rpc('list_employee_document_revisions',{p_before:before});
        if (before === null) history.replaceChildren();
        for (const revision of revisions) {
          const row = document.createElement('div'); row.className = 'employee-document-revision';
          const label = document.createElement('p');
          label.textContent = `Revision ${revision.revision} · ${new Date(revision.updated_at).toLocaleString()} · ${revision.updated_by || 'Initial document import'}${revision.restored_from ? ' · Restored from ' + revision.restored_from : ''}`;
          row.append(label);
          button('PREVIEW',async () => {
            if (busy) return; busy = true; controls();
            try {
              const doc = await rpc('read_employee_document_revision',{p_revision:revision.revision});
              let preview = row.querySelector('article'); if (!preview) { preview = document.createElement('article'); preview.className = 'employee-document-body'; row.append(preview); }
              preview.replaceChildren(renderNode(doc.content));
            } catch(error) { message(error.message); } finally { busy = false; controls(); }
          },row);
          button('RESTORE THIS REVISION',async () => {
            if (busy || !confirm(`Restore revision ${revision.revision} as a new revision? Current history will be kept.`)) return;
            busy = true; controls();
            try {
              show(await rpc('restore_employee_document_revision',{p_revision:revision.revision,p_expected_revision:current.revision}));
              history.hidden = true; history.replaceChildren();
            } catch(error) { message(error.message); } finally { busy = false; controls(); }
          },row);
          history.append(row);
        }
        if (!revisions.length && before === null) history.textContent = 'No revisions yet.';
        if (revisions.length === 50) button('OLDER REVISIONS',event => { event.currentTarget.remove(); viewHistory(revisions.at(-1).revision); },history);
      } catch(error) { message(error.message); } finally { busy = false; controls(); }
    }
    function rememberSelection() {
      const selection = getSelection();
      if (selection.rangeCount && body.contains(selection.anchorNode) && body.contains(selection.focusNode)) savedRange = selection.getRangeAt(0).cloneRange();
    }
    function command(name, value) {
      if (!editing || busy) return;
      body.focus();
      if (savedRange && body.contains(savedRange.commonAncestorContainer)) { const s = getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
      document.execCommand(name,false,value); rememberSelection();
    }
    const format = document.createElement('select'); format.setAttribute('aria-label','Paragraph style');
    for (const [value,label] of [['p','Normal text'],['h1','Heading 1'],['h2','Heading 2'],['h3','Heading 3']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = label; format.append(option);
    }
    format.onchange = () => command('formatBlock',format.value); toolbar.append(format);
    for (const [label,name] of [['Bold','bold'],['Italic','italic'],['Underline','underline'],['Bulleted list','insertUnorderedList'],['Numbered list','insertOrderedList'],['Undo','undo'],['Redo','redo']]) {
      const b = button(label,() => command(name),toolbar); b.onmousedown = event => event.preventDefault();
    }
    button('Link',() => {
      if (!editing || busy) return;
      const href = prompt('Link URL (https:// or http://):'); if (href === null) return;
      if (!safeURL(href)) { message('Enter a full HTTP or HTTPS link.'); return; }
      command('createLink',href);
    },toolbar);
    button('Remove link',() => command('unlink'),toolbar);
    body.addEventListener('click',event => { if (editing && event.target.closest('a')) event.preventDefault(); });
    // Paste/drop plain text: arbitrary clipboard HTML never enters the editor.
    body.addEventListener('paste',event => { if (!editing) return; event.preventDefault(); command('insertText',event.clipboardData.getData('text/plain')); });
    body.addEventListener('drop',event => event.preventDefault());
    document.addEventListener('selectionchange',rememberSelection);
    const beforeUnload = event => { if (editing) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload',beforeUnload);
    const refresh = () => { if (!editing && history.hidden) load(); };
    window.addEventListener('focus',refresh);
    const interval = setInterval(() => { if (!document.hidden && !editing && history.hidden) load(); },60000);
    function close() {
      if (busy && editing) { message('Wait for the save to finish before closing.'); return; }
      if (editing && !confirm('Discard unsaved document changes?')) return;
      closed = true; requests.forEach(c => c.abort()); clearInterval(interval);
      document.removeEventListener('selectionchange',rememberSelection);
      window.removeEventListener('beforeunload',beforeUnload); window.removeEventListener('focus',refresh);
      dialog.close(); dialog.remove(); opener?.focus();
    }
    dialog.querySelector('[data-action=close]').onclick = close;
    dialog.addEventListener('cancel',event => { event.preventDefault(); close(); });
    message('LOADING EMPLOYEE DOCUMENT…'); controls(); await load();
  };
})();
