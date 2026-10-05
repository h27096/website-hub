/* Real browser, isolated service fixtures; never writes live Supabase data. */
const {chromium} = require('playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const root = path.resolve(__dirname, '..');
(async () => {
  const server = http.createServer((req,res) => {
    const file = path.resolve(root, '.' + (req.url === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  });
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const browser = await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL ? {channel:process.env.BROWSER_CHANNEL} : {})});
  let edgeMode = 'missing', profileMode = 'okay', postCount = 0, catalogMode = 'okay';
  const logs = [], errors = [], actions = [];
  const session = {access_token:'private-access-fixture',refresh_token:'private-refresh-fixture'};
  try {
    const page = await browser.newPage();
    page.on('console', msg => {if (msg.type() === 'warning') logs.push(msg.text());});
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://cdn.jsdelivr.net/**', r => r.fulfill({contentType:'text/javascript',body:`window.supabase={createClient:(u,k,o={})=>({auth:{getSession:async()=>({data:{session:JSON.parse(localStorage.getItem(o.auth?.storageKey||'hub-fixture')||'null')}}),setSession:async(s)=>{if(window.fixtureSDKError)return{error:{code:'SESSION_INSTALL_FAILED',message:'Session installation failed'}};if(window.fixtureNoSession)return{};localStorage.setItem(o.auth.storageKey,JSON.stringify(s));return{};},signOut:async()=>{localStorage.removeItem(o.auth.storageKey);return{};}}})};`}));
    await page.route('https://*.supabase.co/**', async r => {
      const req = r.request(), name = new URL(req.url()).pathname.split('/').pop();
      const reply = (data,status=200) => r.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
      const b = JSON.parse(req.postData() || '{}');
      if (name === 'use_access_code') return reply({success:b.input_code === 'hub-password'});
      if (name === 'training-auth') {
        if (req.method() === 'GET') {
          assert(!req.postData()); assert(!req.headers().authorization);
          if (edgeMode === 'missing') return reply({code:'NOT_FOUND',message:'Requested function was not found'},404);
          if (edgeMode === 'network') return r.abort('failed');
          return reply({ready:true});
        }
        postCount++; actions.push(b.action);
        if (edgeMode === 'wrong') return reply({code:'INVALID_CREDENTIALS',operation:'Auth password exchange',error:'Invalid callsign or password.'},400);
        if (edgeMode === 'duplicate') return reply({code:'CALLSIGN_UNAVAILABLE',error:'Callsign unavailable.'},400);
        if (edgeMode === 'disabled') return reply({code:'ACCOUNT_DISABLED',error:'Personnel File disabled. Contact an Overseer.'},400);
        if (edgeMode === 'partial') return reply({code:'unexpected_failure',upstream_status:503,operation:'Auth password exchange after account creation',error:'Personnel File was created. Sign in with the same callsign/password; do not create another account.'},503);
        return reply({session});
      }
      if (name === 'training_profile') {
        assert.equal(req.headers().authorization, 'Bearer ' + session.access_token);
        if (profileMode === 'denied') return reply({code:'42501',message:'permission denied for function training_profile'},403);
        if (profileMode === 'secret') return reply({code:'42501',message:'private-access-fixture private-refresh-fixture a-long-fixture-password recovery_code='+'a'.repeat(64)},403);
        if (profileMode === 'missing') return reply({code:'PGRST202',message:'Could not find public.training_profile without parameters in the schema cache'},404);
        return reply({callsign:'Fixture',rank:'TRAINEE',xp:0,joined_at:'2026-10-05',statistics:[],progress:[],runs:[]});
      }
      if (name === 'training_catalog') {
        if (catalogMode === 'failed') return reply({code:'42P01',message:'relation training_sets does not exist'},400);
        return reply([]);
      }
      return reply([]);
    });
    async function hubLogin() {
      await page.locator('#accessCode').fill('hub-password');
      await page.evaluate(() => login());
      await page.getByRole('button',{name:'ROBCO TRAINING CENTER',exact:true}).click();
    }
    const d = page.getByRole('dialog',{name:'ROBCO TRAINING CENTER'});
    const status = d.locator('.training-status');
    async function fill() {
      await d.getByLabel('Callsign',{exact:true}).fill('Fixture');
      await d.getByLabel('Password (12–128 characters)').fill('a-long-fixture-password');
    }
    const create = () => d.getByRole('button',{name:'CREATE PERSONNEL FILE',exact:true}).click();
    const login = () => d.getByRole('button',{name:'SIGN INTO PERSONNEL FILE',exact:true}).click();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await hubLogin();
    await d.getByRole('button',{name:'PERSONNEL FILE',exact:true}).click();
    await fill(); await create();
    await assertText(/availability failed.*HTTP 404.*NOT_FOUND.*Deploy the training-auth/);
    assert.equal(postCount,0);
    edgeMode='network'; await login(); await assertText(/NETWORK_OR_CORS.*No readable Supabase response/);
    for (const [mode,code] of [['wrong','INVALID_CREDENTIALS'],['duplicate','CALLSIGN_UNAVAILABLE'],['disabled','ACCOUNT_DISABLED'],['partial','unexpected_failure']]) {
      edgeMode=mode; await create(); await assertText(new RegExp(code));
    }
    assert.match(await status.textContent(),/upstream HTTP 503.*Personnel File was created/);
    edgeMode='okay';
    await page.evaluate(()=>{window.fixtureSDKError=true;}); await create();
    await assertText(/Session installation.*Personnel File created.*Auth succeeded.*SESSION_INSTALL_FAILED/);
    await page.evaluate(()=>{window.fixtureSDKError=false;window.fixtureNoSession=true;}); await create();
    await assertText(/Auth succeeded.*SESSION_MISSING/);
    await page.evaluate(()=>{window.fixtureNoSession=false;});
    await d.getByRole('button',{name:'SIGN OUT / CHANGE PERSONNEL FILE',exact:true}).click();
    await fill(); profileMode='denied'; await create();
    await assertText(/Personnel File created\. Auth succeeded; Training profile loading failed.*HTTP 403.*42501/);
    assert.equal(await d.getByRole('button',{name:'CREATE PERSONNEL FILE',exact:true}).count(),0);
    profileMode='missing'; await d.getByRole('button',{name:'RETRY PROFILE',exact:true}).click();
    await assertText(/PGRST202.*Required RPC\/table\/signature is missing/);
    profileMode='secret'; await d.getByRole('button',{name:'RETRY PROFILE',exact:true}).click();
    await assertText(/REDACTED/);
    const output=await status.textContent();
    for (const secret of [session.access_token,session.refresh_token,'a-long-fixture-password','a'.repeat(64)]) {
      assert(!output.includes(secret)); assert(!logs.join('\n').includes(secret));
    }
    profileMode='okay'; await d.getByRole('button',{name:'RETRY PROFILE',exact:true}).click();
    await d.getByText('Fixture // TRAINEE // 0 TRAINING XP',{exact:true}).waitFor();
    await d.getByRole('button',{name:'SIGN OUT',exact:true}).click();
    assert.equal(await page.evaluate(()=>localStorage.getItem('robco-training-auth')),null);
    await fill(); await login();
    await d.getByText('Fixture // TRAINEE // 0 TRAINING XP',{exact:true}).waitFor();
    await page.reload(); await hubLogin();
    await d.getByRole('button',{name:'PERSONNEL FILE',exact:true}).click();
    await d.getByText('Fixture // TRAINEE // 0 TRAINING XP',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>localStorage.getItem('hub-fixture')),null);
    catalogMode='failed'; await d.getByRole('button',{name:'TRAINING HOME',exact:true}).click();
    await assertText(/RPC training_catalog failed.*42P01/);
    assert.deepEqual(errors,[]); assert(actions.includes('signup') && actions.includes('login'));
    console.log('PASS Training browser: missing function/no POST, network/CORS, wrong password, duplicate, disabled, partial creation, profile denial/missing RPC, secret redaction, create, sign out/in, refresh, XP/rank, isolated session and catalog diagnostics');
    async function assertText(pattern) {
      await page.waitForFunction(({pattern}) => new RegExp(pattern).test(document.querySelector('.training-status')?.textContent||''), {pattern:pattern.source});
      assert.match(await status.textContent(),pattern);
    }
  } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
