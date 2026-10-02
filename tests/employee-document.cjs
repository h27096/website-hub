/* Browser integration against the actual migration in local PostgreSQL (PGlite).
   Only existing Supabase Auth/employee credential checks are fixtures.
   No requests or changes go to the live Supabase project. */
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {createDB,overseer} = require('./employee-document-db.cjs');
const root = path.resolve(__dirname,'..');
(async () => {
  const {db,as} = await createDB();
  const server = http.createServer((req,res) => {
    const file = path.resolve(root,'.'+(req.url==='/'?'/index.html':req.url.split('?')[0]));
    if (!file.startsWith(root+path.sep) || !fs.existsSync(file)) {res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/html');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser = await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{})});
  const errors=[]; let failSave=false;
  try {
    const context = await browser.newContext();
    await context.route('https://cdn.jsdelivr.net/**',r=>r.fulfill({contentType:'text/javascript',body:'window.supabase={createClient:()=>({})};'}));
    await context.route('https://*.supabase.co/**',async route => {
      const request=route.request(), url=new URL(request.url());
      const reply=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
      const authorized=request.headers().authorization==='Bearer overseer-test';
      if(url.pathname.includes('/auth/v1/token')) return reply({user:{id:overseer},access_token:'overseer-test'});
      if(url.pathname.includes('/overseers')) return reply(authorized?[{user_id:overseer}]:[]);
      const name=url.pathname.split('/').pop(), args=JSON.parse(request.postData()||'{}');
      if(name==='save_employee_document' && failSave) {failSave=false; return reply({message:'offline'},503);}
      const calls={
        employee_login:['employee_password'],read_employee_document:['employee_password'],
        save_employee_document:['p_content','p_expected_revision'],list_employee_document_revisions:['p_before'],
        read_employee_document_revision:['p_revision'],restore_employee_document_revision:['p_revision','p_expected_revision'],
        submit_website_request:['employee_password','website_name','website_url','website_description']
      };
      if (!calls[name]) return reply([]);
      const keys=calls[name].filter(k=>Object.hasOwn(args,k));
      const sql=`select ${name==='list_employee_document_revisions'?'*':'public.'+name+'('+keys.map((k,i)=>k+' => $'+(i+1)).join(',')+') as result'}${name==='list_employee_document_revisions'?' from public.'+name+'('+keys.map((k,i)=>k+' => $'+(i+1)).join(',')+')':''}`;
      try {
        const data=await as(authorized?'authenticated':'anon',authorized?overseer:null,sql,keys.map(k=>args[k]));
        return reply(name==='list_employee_document_revisions'?data.rows:data.rows[0].result);
      } catch(error) {return reply({message:error.message,code:error.code},error.code==='42501'?403:400);}
    });
    const url=`http://127.0.0.1:${server.address().port}`;
    const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
    const employee=await context.newPage(); employee.on('pageerror',e=>errors.push(e.message));
    async function loginEmployee(p) {
      await p.goto(url); await p.evaluate(()=>showEmployeeLogin());
      await p.locator('#employeePassword').fill('test-employee'); await p.getByRole('button',{name:'AUTHENTICATE',exact:true}).click();
      await p.getByRole('button',{name:'📄 ROBCO EMPLOYEE DOCUMENT',exact:true}).waitFor();
    }
    async function loginOverseer(p) {
      await p.goto(url); await p.evaluate(()=>showOverseerLogin());
      await p.locator('#overseerEmail').fill('test@example.com'); await p.locator('#overseerPassword').fill('test');
      await p.getByRole('button',{name:'AUTHENTICATE',exact:true}).click();
      await p.getByRole('button',{name:'📄 MANAGE EMPLOYEE DOCUMENT',exact:true}).click();
      await p.getByText(/REVISION 1 · SAVED/).waitFor();
    }
    await loginEmployee(employee);
    await employee.locator('#employeeWebsiteName').fill('Employee request');
    await employee.locator('#employeeWebsiteURL').fill('https://example.com');
    await employee.locator('#employeeWebsiteDescription').fill('Existing form still works');
    await employee.getByRole('button',{name:'📄 ROBCO EMPLOYEE DOCUMENT',exact:true}).click();
    await employee.getByText(/READ ONLY/).waitFor();
    assert.equal(await employee.getByRole('button',{name:'EDIT DOCUMENT',exact:true}).count(),0);
    assert.equal(await employee.locator('[contenteditable=true]').count(),0);
    const forgery=await employee.evaluate(async()=>{
      const r=await fetch(SUPABASE_URL+'/rest/v1/rpc/save_employee_document',{method:'POST',headers:{apikey:SUPABASE_KEY,'Content-Type':'application/json'},body:JSON.stringify({p_content:{type:'doc',children:[]},p_expected_revision:1})});return r.status;
    }); assert.equal(forgery,403);
    await employee.getByRole('button',{name:'CLOSE',exact:true}).click();
    assert.equal(await employee.locator('#employeeWebsiteName').inputValue(),'Employee request');
    await employee.getByRole('button',{name:'➕ SUBMIT REQUEST',exact:true}).click();
    await employee.waitForFunction(()=>document.getElementById('employeeOutput').textContent.includes('REQUEST SENT'));
    assert.equal((await db.query('select count(*)::int as n from website_requests')).rows[0].n,1);
    await loginOverseer(page);
    await page.getByRole('button',{name:'EDIT DOCUMENT',exact:true}).click();
    const editor=page.locator('article[contenteditable=true]');
    await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter');
    await page.getByRole('button',{name:'Bold',exact:true}).click(); await page.keyboard.type('Persistent bold');
    await page.getByRole('button',{name:'Bold',exact:true}).click();
    await page.keyboard.press('Enter'); await page.getByRole('button',{name:'Italic',exact:true}).click(); await page.keyboard.type('Italic line');
    await page.getByRole('button',{name:'Italic',exact:true}).click();
    await page.keyboard.press('Enter'); await page.getByRole('button',{name:'Underline',exact:true}).click(); await page.keyboard.type('Underlined');
    await page.getByRole('button',{name:'Underline',exact:true}).click();
    await page.keyboard.press('Enter'); await page.getByLabel('Paragraph style').selectOption('h2'); await page.keyboard.type('New heading');
    await page.keyboard.press('Enter'); await page.getByLabel('Paragraph style').selectOption('p');
    await page.getByRole('button',{name:'Bulleted list',exact:true}).click(); await page.keyboard.type('Bullet item');
    await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
    await page.getByRole('button',{name:'Numbered list',exact:true}).click(); await page.keyboard.type('Numbered item');
    await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
    await page.keyboard.type('Safe link'); await page.keyboard.press('Shift+Home');
    page.once('dialog',d=>d.accept('https://example.com')); await page.getByRole('button',{name:'Link',exact:true}).click();
    await page.keyboard.press('Control+End'); await page.keyboard.type(' Undo marker');
    await page.getByRole('button',{name:'Undo',exact:true}).click();
    assert.ok(!(await editor.textContent()).includes('Undo marker'));
    await page.getByRole('button',{name:'Redo',exact:true}).click();
    assert.ok((await editor.textContent()).includes('Undo marker'));
    // Clipboard HTML scripts are never inserted; literal script text stays inert.
    await editor.evaluate(el=>{
      const transfer=new DataTransfer(); transfer.setData('text/html','<img src=x onerror="window.pwned=true">');
      transfer.setData('text/plain','<script>window.pwned=true</script>');
      el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
    });
    failSave=true; await page.getByRole('button',{name:'SAVE CHANGES',exact:true}).click();
    await page.getByText(/Document request failed/).waitFor(); assert.ok((await editor.textContent()).includes('Persistent bold'));
    await page.getByRole('button',{name:'SAVE CHANGES',exact:true}).click();
    await page.getByText(/REVISION 2 · SAVED/).waitFor();
    const content=(await db.query('select content from employee_documents')).rows[0].content;
    const types=[]; const walk=n=>{types.push(n.type); (n.children||[]).forEach(walk);}; walk(content);
    for(const type of ['strong','em','u','h2','ul','ol','a']) assert.ok(types.includes(type),type);
    assert.equal(await page.evaluate(()=>window.pwned),undefined);
    await employee.getByRole('button',{name:'📄 ROBCO EMPLOYEE DOCUMENT',exact:true}).click();
    await employee.getByText(/REVISION 2 · SAVED/).waitFor();
    assert.ok((await employee.locator('.employee-document-body').textContent()).includes('Persistent bold'));
    assert.equal(await employee.locator('.employee-document-body script').count(),0);
    // Reload and sign back in: persisted database content is read again.
    await page.reload(); await page.evaluate(()=>{window.overseerSession={access_token:'overseer-test'};showOverseerPanel();});
    await page.getByRole('button',{name:'📄 MANAGE EMPLOYEE DOCUMENT',exact:true}).click();
    await page.getByText(/REVISION 2 · SAVED/).waitFor();
    await page.getByRole('button',{name:'EDIT DOCUMENT',exact:true}).click();
    await page.locator('article[contenteditable=true]').fill('Cancel this draft'); await page.getByRole('button',{name:'CANCEL',exact:true}).click();
    await page.getByText(/REVISION 2 · SAVED/).waitFor();
    assert.ok(!(await page.locator('.employee-document-body').textContent()).includes('Cancel this draft'));
    await page.getByRole('button',{name:'EDIT DOCUMENT',exact:true}).click();
    await as('authenticated',overseer,'select public.save_employee_document($1,2)',[content]);
    await page.getByRole('button',{name:'SAVE CHANGES',exact:true}).click();
    await page.getByText(/Another Overseer saved/).waitFor();
    assert.equal(await page.locator('[contenteditable=true]').count(),1);
    await page.getByRole('button',{name:'CANCEL',exact:true}).click(); await page.getByText(/REVISION 3 · SAVED/).waitFor();
    await page.getByRole('button',{name:'VIEW REVISION HISTORY',exact:true}).click();
    const original=page.locator('.employee-document-revision').filter({hasText:'Revision 1 ·'});
    await original.getByRole('button',{name:'PREVIEW',exact:true}).click(); await original.getByText('Original document.',{exact:true}).waitFor();
    page.once('dialog',d=>d.accept()); await original.getByRole('button',{name:'RESTORE THIS REVISION',exact:true}).click();
    await page.getByText(/REVISION 4 · SAVED/).waitFor();
    await employee.getByRole('button',{name:'REFRESH DOCUMENT',exact:true}).click(); await employee.getByText(/REVISION 4 · SAVED/).waitFor();
    assert.ok(!(await employee.locator('.employee-document-body').textContent()).includes('Persistent bold'));
    const safety=await page.evaluate(()=>{
      const holder=document.createElement('div'); holder.innerHTML='<script>evil()</script><a href="javascript:evil()">text</a><p onclick="evil()">safe</p>';
      const doc=RobcoDocument.serialize(holder); const result=document.createElement('div'); result.append(RobcoDocument.renderNode(doc));
      return {html:result.innerHTML,unsafe:['javascript:evil()','data:text/html,x','https://safe.test\\evil'].some(RobcoDocument.safeURL)};
    }); assert.equal(safety.html,'text<p>safe</p>'); assert.equal(safety.unsafe,false);
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.locator('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth));
    if(process.env.DOC_SCREENSHOT) await page.screenshot({path:process.env.DOC_SCREENSHOT});
    if(process.env.PRIVATE_DOC_SEED) {
      await db.exec('delete from employee_document_revisions; delete from employee_documents');
      await db.exec(fs.readFileSync(process.env.PRIVATE_DOC_SEED,'utf8'));
      await page.getByRole('button',{name:'REFRESH DOCUMENT',exact:true}).click();
      await page.getByText(/REVISION 1 · SAVED/).waitFor();
      await page.setViewportSize({width:1280,height:900});
      assert.ok((await page.locator('.employee-document-body').textContent()).includes('maintenance every weekend'));
      assert.equal(await page.locator('.employee-document-body img').count(),1);
      if(process.env.DOC_SOURCE_SCREENSHOT) await page.screenshot({path:process.env.DOC_SOURCE_SCREENSHOT});
    }
    assert.deepEqual(errors,[]);
    console.log('PASS: Employee/Overseer login flows, preserved request form, rich text/undo/redo, safe paste, PostgreSQL save/reload, Employee updates, cancel, offline draft, conflicts, history/restore, mobile layout.');
  } finally {await browser.close(); await new Promise(r=>server.close(r)); await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
