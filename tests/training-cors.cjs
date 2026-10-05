/* Native browser CORS over real local HTTP, real Edge handler + PostgreSQL.
   Supabase Auth transport is isolated; no requests/write tests hit production. */
const {chromium} = require('playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), http = require('node:http'), path = require('node:path');
const {setupEdge} = require('./training-auth-fixture.cjs');
const {check} = require('../tools/check-training-endpoint.cjs');
const root = path.resolve(__dirname,'..');
const listen = server => new Promise(r=>server.listen(0,'127.0.0.1',r));
const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'apikey,content-type,authorization'};
const sdkFixture = `window.supabase={createClient:(u,k,o={})=>({auth:{getSession:async()=>({data:{session:JSON.parse(localStorage.getItem(o.auth?.storageKey||'hub-test')||'null')}}),setSession:async(s)=>{localStorage.setItem(o.auth.storageKey,JSON.stringify(s));return{};},signOut:async()=>{localStorage.removeItem(o.auth.storageKey);return{};}}})};`;
(async () => {
  const publicFixture = await setupEdge();
  let fixture = publicFixture, mode = 'normal', queue = Promise.resolve();
  const calls = [], fixtures = [fixture], hubs = [];
  const edge = http.createServer((req,res) => {
    const run = async () => {
      calls.push({method:req.method, path:req.url, origin:req.headers.origin,
        authorization:!!req.headers.authorization, apikey:!!req.headers.apikey, contentType:!!req.headers['content-type']});
      assert.equal(req.headers.cookie,undefined,'Cookie-free transport');
      const reply = (body,status=200,headers=cors) => {res.writeHead(status,{'Content-Type':'application/json',...headers});res.end(JSON.stringify(body));};
      if (req.url === '/functions/v1/training-auth') {
        if (mode === 'missing') return reply({code:'NOT_FOUND',message:'Requested function was not found'},404);
        if (mode === 'unreachable') return req.socket.destroy();
        if (mode === 'authorization') return reply({code:'401',message:'Missing authorization header'},401);
        if (mode === 'preflight' && req.method === 'OPTIONS') return reply({code:'ORIGIN_NOT_CONFIGURED'},403,{});
        if (mode === 'blocked-get' && req.method === 'GET') return reply({ready:true},200,{});
        let body=''; for await (const chunk of req) body+=chunk;
        const r = await fixture.handler(new Request(edgeURL+req.url, {method:req.method,headers:req.headers,...(body ? {body} : {})}));
        if(mode==='post-response' && req.method==='POST') r.headers.delete('Access-Control-Allow-Origin');
        res.writeHead(r.status,Object.fromEntries(r.headers)); res.end(await r.text()); return;
      }
      if (req.method === 'OPTIONS') return reply({},204);
      let raw='';for await(const chunk of req) raw+=chunk;
      const body = JSON.parse(raw||'{}'), name = req.url.split('/').pop();
      if (name === 'use_access_code') return reply({success:body.input_code==='hub-password'});
      if (name === 'training_catalog') return reply(await fixture.as('anon',null,'training_catalog',[false]));
      if (name === 'training_profile') {
        const token = (req.headers.authorization||'').replace(/^Bearer /,'');
        const uid = token.startsWith('token-') ? token.slice(6) : null;
        return reply(await fixture.as(uid?'authenticated':'anon',uid,'training_profile'));
      }
      return reply([]);
    };
    queue = queue.then(run).catch(e=>{if(!res.headersSent) res.writeHead(400,{'Content-Type':'application/json',...cors});res.end(JSON.stringify({code:e.code||'TEST_ERROR',message:e.message}));});
  });
  await listen(edge);
  const edgeURL = `http://127.0.0.1:${edge.address().port}`, url=edgeURL+'/functions/v1/training-auth';
  function hub() {
    const server = http.createServer((req,res)=>{
      if(req.url==='/test-supabase-sdk.js') {res.setHeader('Content-Type','text/javascript');res.end(sdkFixture);return;}
      const file=path.resolve(root,'.'+(req.url==='/'?'/index.html':req.url.split('?')[0]));
      if(!file.startsWith(root+path.sep)||!fs.existsSync(file)) return res.writeHead(404).end();
      res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');
      let source=fs.readFileSync(file,'utf8');
      // Test-only serving substitution. Production frontend/config stays intact.
      if(file.endsWith('index.html')) source=source.replace(/const SUPABASE_URL\s*=\s*"[^"]+"/,`const SUPABASE_URL = "${edgeURL}"`)
        .replace(/https:\/\/cdn\.jsdelivr\.net\/[^"']+supabase[^"']*/g, '/test-supabase-sdk.js');
      res.end(source);
    }); hubs.push(server);return server;
  }
  const first=hub(), second=hub();await listen(first);await listen(second);
  const origins=[`http://127.0.0.1:${first.address().port}`,`http://localhost:${second.address().port}`];
  const browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{})});
  try {
    const report=await check({url,origin:origins[0]});assert.equal(report.result,'READY');
    assert.equal(report.requests[1].status,204);
    const health=await fetch(url,{headers:{Origin:origins[0]}});
    assert.equal(health.headers.get('access-control-allow-origin'),'*');
    assert.equal(health.headers.get('access-control-allow-credentials'),null);
    assert.equal((await publicFixture.db.query('select count(*)::int n from public.training_limits')).rows[0].n,0);
    for (const origin of origins) {
      const context=await browser.newContext(), page=await context.newPage();
      // No Playwright routing/interception: Chromium must enforce native CORS.
      await context.addCookies([{name:'must-not-be-sent',value:'fixture',url:edgeURL}]);
      await page.goto(origin);
      await page.locator('#accessCode').fill('hub-password');await page.evaluate(()=>login());
      await page.getByRole('button',{name:'ROBCO TRAINING CENTER',exact:true}).click();
      const d=page.getByRole('dialog',{name:'ROBCO TRAINING CENTER'}),status=d.locator('.training-status');
      await d.getByRole('button',{name:'PERSONNEL FILE',exact:true}).click();
      const name=origin===origins[0]?'FirstDomain':'MovedDomain';
      async function fill(password='a-long-fixture-password') {await d.getByLabel('Callsign',{exact:true}).fill(name);await d.getByLabel('Password (12–128 characters)').fill(password);}
      const create=()=>d.getByRole('button',{name:'CREATE PERSONNEL FILE',exact:true}).click();
      const login=()=>d.getByRole('button',{name:'SIGN INTO PERSONNEL FILE',exact:true}).click();
      async function diagnostic(pattern) {
        try {await page.waitForFunction(p=>new RegExp(p).test(document.querySelector('.training-status')?.textContent||''),pattern.source);}
        catch(e) {throw Error(e.message+'; status='+await status.textContent()+'; requests='+JSON.stringify(calls.slice(-8)));}
        assert.match(await status.textContent(),pattern);
      }
      await fill();
      if(origin===origins[0]) {
        mode='missing';const before=calls.filter(c=>c.method==='POST'&&c.path.includes('training-auth')).length;
        const oldProbe = await page.evaluate(url=>fetch(url,{headers:{apikey:'public-fixture'},credentials:'omit'}).then(r=>r.status).catch(()=>null),url);
        assert.equal(oldProbe,null,'Old custom-header GET hides the missing function behind failed preflight');
        await create();await diagnostic(/FUNCTION NOT DEPLOYED.*HTTP 404.*NOT_FOUND/);
        assert.equal(calls.filter(c=>c.method==='POST'&&c.path.includes('training-auth')).length,before);
        mode='preflight';await create();await diagnostic(/CORS PREFLIGHT FAILED.*Suspected preflight/);
        assert.equal(calls.filter(c=>c.method==='POST'&&c.path.includes('training-auth')).length,before);
        assert.equal((await check({url,origin})).result,'CORS_PREFLIGHT_FAILED');
        mode='blocked-get';await create();await diagnostic(/CORS RESPONSE BLOCKED.*unconfirmed/);
        mode='unreachable';await create();await diagnostic(/FUNCTION UNREACHABLE.*unconfirmed/);
        mode='authorization';await create();await diagnostic(/AUTHORIZATION FAILED.*HTTP 401/);
        assert.equal((await check({url,origin})).result,'AUTHORIZATION_FAILED');
        mode='normal';
      }
      if(origin===origins[0]) {
        mode='post-response';await create();await diagnostic(/CORS PREFLIGHT FAILED.*Account creation status is unknown/);
        assert.equal((await publicFixture.db.query('select count(*)::int n from public.training_profiles where callsign=$1',[name])).rows[0].n,1);
        mode='normal';await login();
      } else await create();
      await d.getByText(`${name} // TRAINEE // 0 TRAINING XP`,{exact:true}).waitFor();
      await d.getByRole('button',{name:'SIGN OUT',exact:true}).click();
      await fill('incorrect-password');await login();await diagnostic(/INVALID_CREDENTIALS/);
      await fill();await create();await diagnostic(/CALLSIGN_UNAVAILABLE/);
      await login();await d.getByText(`${name} // TRAINEE // 0 TRAINING XP`,{exact:true}).waitFor();
      await page.reload();await page.locator('#accessCode').fill('hub-password');await page.evaluate(()=>login());
      await page.getByRole('button',{name:'ROBCO TRAINING CENTER',exact:true}).click();
      await d.getByRole('button',{name:'PERSONNEL FILE',exact:true}).click();
      await d.getByText(`${name} // TRAINEE // 0 TRAINING XP`,{exact:true}).waitFor();
      await context.close();
    }
    const readinessCalls=calls.filter(c=>c.path.includes('training-auth')&&c.method==='GET');
    assert(readinessCalls.length);assert(readinessCalls.every(c=>!c.authorization&&!c.apikey&&!c.contentType));
    assert(calls.some(c=>c.path.includes('training-auth')&&c.method==='OPTIONS'));
    assert(calls.some(c=>c.path.includes('training-auth')&&c.method==='POST'&&c.apikey&&c.contentType));
    const denied=await fetch(url,{method:'POST',headers:{...{'Content-Type':'application/json'},Origin:origins[0]},body:JSON.stringify({action:'issue-reset',user_id:publicFixture.user})});
    assert.equal(denied.status,403,'Wildcard CORS does not grant Overseer authorization');
    fixture=await setupEdge({TRAINING_CORS_MODE:'restricted',TRAINING_ALLOWED_ORIGINS:origins[0]});fixtures.push(fixture);
    assert.equal((await check({url,origin:origins[0]})).result,'READY');
    assert.equal((await check({url,origin:origins[1]})).result,'CORS_PREFLIGHT_FAILED');
    const badOrigin=await fetch(url,{headers:{Origin:origins[1]}});assert.equal(badOrigin.status,403);assert.equal(badOrigin.headers.get('access-control-allow-origin'),'*');
    fixture=await setupEdge({TRAINING_CORS_MODE:'restricted',TRAINING_ALLOWED_ORIGINS:''});fixtures.push(fixture);
    const badConfig=await fetch(url);assert.equal(badConfig.status,503);assert.equal((await badConfig.json()).code,'BACKEND_CONFIGURATION');
    // The standalone probe can prove unavailable transport without pretending an
    // opaque browser response is a successful deployed function.
    assert.equal((await check({url,origin:origins[0],fetchImpl:async()=>{throw Error('offline');}})).result,'FUNCTION_UNREACHABLE');
    console.log('PASS native CORS: OPTIONS/GET/POST, two Hub origins, real-handler create/sign-in/logout/refresh + own XP/profile, no readiness preflight/key/cookies, missing deployment, preflight denied/no POST, opaque/unreachable/auth diagnostics, public admin denial, restricted/config failure');
  } finally {
    await browser.close();edge.close();hubs.forEach(s=>s.close());await queue;
    for(const f of fixtures)await f.db.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
