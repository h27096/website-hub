/* Combined browser release tests. Network responses are isolated fixtures. */
const {chromium}=require('playwright');
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), http=require('node:http');
const root=path.resolve(__dirname,'..');
const server=http.createServer((req,res)=>{
  const file=path.resolve(root,'.'+(req.url==='/'?'/index.html':req.url.split('?')[0]));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{})});
  let enabled=false, unavailable=false, migrationMissing=false, deniedChange=false, previewCalls=0;
  const contexts=[];
  const errors=[];
  try {
    async function setup(mobile=false) {
      const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},hasTouch:mobile});contexts.push(context);
      await context.route('https://cdn.jsdelivr.net/**',r=>r.fulfill({contentType:'text/javascript',body:'window.supabase={createClient:()=>({})};'}));
      await context.route('https://*.supabase.co/**',r=>{
        const request=r.request(), name=new URL(request.url()).pathname.split('/').pop(), body=JSON.parse(request.postData()||'{}');
        const admin=request.headers().authorization==='Bearer test-admin';
        const reply=(data,status=200)=>r.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
        if(name==='privacy_preview_login') return migrationMissing?reply({code:'PGRST202'},404):reply({success:true,preview_token:'a'.repeat(64)});
        if(name==='use_access_code') return reply({success:true});
        if(name==='privacy_preview_status') return reply(enabled);
        if(name==='privacy_preview_config') return admin?reply({enabled,hosts:['example.com']}):reply({},403);
        if(name==='privacy_preview_set_enabled') {if(!admin||deniedChange)return reply({},403);enabled=body.new_enabled;return reply(null);}
        if(name==='privacy_preview_logout') return reply(null);
        if(name==='token') return reply({user:{id:'admin'},access_token:'test-admin'});
        if(name==='overseers') return reply([{user_id:'admin'}]);
        return reply([]);
      });
      await context.route('https://preview.example/**',async r=>{
        if(unavailable)return r.abort();
        const request=r.request();const reply=(data,status=200)=>r.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
        if(!request.headers()['x-robco-session']&&!request.headers().authorization) return reply({error:'Sign in required'},401);
        if(request.url().endsWith('/status'))return reply({enabled,hosts:['example.com']});
        previewCalls++;
        if(!enabled)return reply({error:'Preview disabled by Overseer'},403);
        const target=JSON.parse(request.postData()).url;
        if(new URL(target).hostname!=='example.com')return reply({error:'HTTPS destination is not approved'},400);
        await new Promise(r=>setTimeout(r,60));
        return reply({url:target,content:'<script>parent.hacked=true</script> Preview '+target});
      });
      const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.locator('#accessCode').fill('test');await page.evaluate(()=>login());return page;
    }
    const page=await setup();
    assert(await page.locator('#dashboard').isVisible());
    await page.evaluate(()=>showUserPage('games'));
    // Existing games: win, reset and delayed signal visibility.
    await page.getByRole('button',{name:'CODEBREAKER',exact:true}).click();
    const code=await page.evaluate(()=>robcoGame.code);await page.locator('#gameOutput input').fill(code);await page.locator('#gameOutput input').press('Enter');
    assert.match(await page.locator('#gameOutput').textContent(),/ACCESS GRANTED/);
    await page.getByRole('button',{name:'RESTART / RESET'}).click();assert.equal(await page.evaluate(()=>robcoGame.tries),0);
    await page.getByRole('button',{name:'SIGNAL MATCH',exact:true}).click();
    const symbols=(await page.locator('#gameOutput p').first().textContent()).split(': ')[1].split(' ');
    for(const symbol of symbols)await page.getByRole('button',{name:symbol,exact:true}).click();
    assert.match(await page.locator('#gameOutput').textContent(),/SIGNAL MATCHED/);
    await page.getByRole('button',{name:'RESTART / RESET'}).click();
    await page.evaluate(()=>showUserPage('dashboard'));assert.equal(await page.locator('#gameOutput').textContent(),'SELECT A GAME TO BEGIN.');
    await page.evaluate(()=>showUserPage('games'));
    // Fixed random fixture makes pair positions reproducible without inspecting private state.
    await page.evaluate(()=>{window.originalRandom=Math.random;Math.random=()=>.999;startMemoryBanks();Math.random=window.originalRandom;});
    const cards=page.locator('.memory-grid button');
    await cards.nth(0).click();await cards.nth(1).click();await page.waitForTimeout(1100);
    assert.equal(await cards.nth(0).textContent(),'?');
    for(let i=0;i<6;i++){await cards.nth(i).click();await cards.nth(i+6).click();}
    assert.match(await page.locator('#gameOutput').textContent(),/MEMORY RESTORED/);
    await page.getByRole('button',{name:'RESTART / RESET'}).click();assert.equal(await page.locator('.memory-grid button:disabled').count(),0);
    // Solve from the visible board using exhaustive 3x3 switch combinations.
    await page.getByRole('button',{name:'CIRCUIT GRID',exact:true}).click();
    const initial=await page.locator('.circuit-grid button').evaluateAll(bs=>bs.map(b=>b.textContent==='ON'));
    let solution;
    for(let mask=0;mask<512;mask++){
      const state=[...initial];for(let i=0;i<9;i++)if(mask&(1<<i))for(const j of [i,i>=3?i-3:-1,i<6?i+3:-1,i%3?i-1:-1,i%3<2?i+1:-1])if(j>=0)state[j]=!state[j];
      if(!state.some(Boolean)){solution=mask;break;}
    }
    assert.notEqual(solution,undefined);
    for(let i=0;i<9;i++)if(solution&(1<<i)){await page.locator('.circuit-grid button').nth(i).focus();await page.keyboard.press('Enter');}
    assert.match(await page.locator('#gameOutput').textContent(),/GRID STABILIZED/);
    await page.getByRole('button',{name:'RESTART / RESET'}).click();assert.match(await page.locator('#gameOutput').textContent(),/MOVES: 0/);
    await page.getByRole('button',{name:'REACTOR TIMING',exact:true}).click();await page.getByRole('button',{name:'ARM REACTOR',exact:true}).click();
    await page.getByRole('button',{name:'WAIT FOR SIGNAL',exact:true}).click();assert.match(await page.locator('#gameOutput').textContent(),/TOO EARLY/);
    await page.getByRole('button',{name:'RESTART / RESET'}).click();await page.getByRole('button',{name:'ARM REACTOR',exact:true}).click();
    await page.getByRole('button',{name:'DISCHARGE NOW',exact:true}).click();assert.match(await page.locator('#gameOutput').textContent(),/DISCHARGED IN/);
    // Timer/listener cancellation: detached buttons cannot start another timer.
    const cleanup=await page.evaluate(()=>{
      const set=window.setTimeout, clear=window.clearTimeout;let pending=new Set();
      window.setTimeout=(fn,ms)=>{const id=set(()=>{pending.delete(id);fn();},ms);pending.add(id);return id;};
      window.clearTimeout=id=>{pending.delete(id);clear(id);};
      startReactorTiming();const button=document.querySelector('.training-board button');button.click();const before=pending.size;
      stopRobcoGame();button.click();const after=pending.size;
      window.setTimeout=set;window.clearTimeout=clear;return {before,after};
    });assert.deepEqual(cleanup,{before:1,after:0});
    // Disabled state, setup state and unavailable backend.
    await page.evaluate(()=>showUserPage('dashboard'));await page.waitForFunction(()=>document.getElementById('privacyHomeStatus').textContent.includes('OFFLINE BY ORDER'));
    await page.evaluate(()=>showPrivacyPreview());await page.waitForFunction(()=>document.getElementById('privacyStatus').textContent.includes('OFFLINE BY ORDER'));
    assert(await page.locator('#privacyGo').isDisabled());
    enabled=true;await page.evaluate(()=>openPrivacyPage());await page.waitForFunction(()=>document.getElementById('privacyStatus').textContent.includes('BACKEND NOT CONFIGURED'));
    await page.evaluate(()=>{window.ROBCO_PROXY_URL='https://preview.example';openPrivacyPage();});await page.waitForFunction(()=>privacyAvailable);
    const prior=previewCalls;await page.evaluate(()=>loadPrivacyPreview('http://example.com'));assert.equal(previewCalls,prior);
    await page.evaluate(()=>loadPrivacyPreview('https://unapproved.example'));assert.match(await page.locator('#privacyStatus').textContent(),/not approved/);
    await page.locator('#privacyUrl').fill('https://example.com/one');await page.locator('#privacyGo').click();await page.waitForFunction(()=>privacyIndex===0);
    assert.equal(await page.evaluate(()=>window.hacked),undefined);
    assert.equal(await page.locator('#privacyFrame').getAttribute('sandbox'),'');
    await page.evaluate(()=>loadPrivacyPreview('https://example.com/two'));assert.equal(await page.evaluate(()=>privacyIndex),1);
    await page.locator('#privacyBack').click();await page.waitForFunction(()=>privacyIndex===0);assert.match(await page.locator('#privacyUrl').inputValue(),/one$/);
    await page.locator('#privacyForward').click();await page.waitForFunction(()=>privacyIndex===1);
    const beforeReload=previewCalls;await page.locator('#privacyReload').click();await page.waitForFunction(()=>privacyController===null);assert.equal(previewCalls,beforeReload+1);
    unavailable=true;await page.evaluate(()=>loadPrivacyPreview('https://example.com'));assert.match(await page.locator('#privacyStatus').textContent(),/unreachable/);unavailable=false;
    // Overseer controls and a second independent session observe the same setting.
    const other=await setup(true);await other.evaluate(()=>{window.ROBCO_PROXY_URL='https://preview.example';showPrivacyPreview();});await other.waitForFunction(()=>privacyAvailable);
    await page.evaluate(()=>{showUserPage('dashboard');returnToOverseer();window.overseerSession={access_token:'test-admin'};showOverseerPanel();showPrivacyControl();});
    await page.getByRole('button',{name:'DISABLE PRIVATE TERMINAL',exact:true}).waitFor();
    page.once('dialog',dialog=>dialog.accept());await page.locator('#privacyToggle').click();await page.getByRole('button',{name:'ENABLE PRIVATE TERMINAL',exact:true}).waitFor();
    assert.equal(enabled,false);await other.evaluate(()=>loadPrivacyPreview('https://example.com'));assert.match(await other.locator('#privacyStatus').textContent(),/disabled/);
    await other.evaluate(()=>openPrivacyPage());await other.waitForFunction(()=>document.getElementById('privacyStatus').textContent.includes('OFFLINE BY ORDER'));
    await page.evaluate(()=>showPrivacyControl());await page.getByRole('button',{name:'ENABLE PRIVATE TERMINAL',exact:true}).waitFor();
    deniedChange=true;await page.locator('#privacyToggle').click();await page.waitForFunction(()=>document.getElementById('privacyControlMessage').textContent.includes('rejected'));assert.equal(enabled,false);deniedChange=false;
    await page.locator('#privacyToggle').click();await page.getByRole('button',{name:'DISABLE PRIVATE TERMINAL',exact:true}).waitFor();
    await other.evaluate(()=>openPrivacyPage());await other.waitForFunction(()=>privacyAvailable);
    // Touch control and narrow viewport smoke checks.
    await other.evaluate(()=>showUserPage('games'));
    for(const name of ['MEMORY BANKS','CIRCUIT GRID','REACTOR TIMING']) {
      await other.getByRole('button',{name,exact:true}).tap();await other.locator('.training-board button').first().tap();
      for (const width of [320,390,768]) {
        await other.setViewportSize({width,height:844});
        assert(await other.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      }
      await other.setViewportSize({width:390,height:844});
      await other.getByRole('button',{name:'RESTART / RESET'}).tap();
    }
    await other.screenshot({path:path.join(root,'../v12-mobile.png'),fullPage:true});
    await other.evaluate(()=>{showPrivacyPreview();showUserPage('dashboard');});
    assert.equal(await other.evaluate(()=>privacyHistory.length),0);assert.equal(await other.evaluate(()=>privacyPoll),null);
    migrationMissing=true;await other.reload();await other.locator('#accessCode').fill('legacy');await other.evaluate(()=>login());assert(await other.locator('#dashboard').isVisible());assert.equal(await other.evaluate(()=>privacySession),null);
    assert.deepEqual(errors,[]);
    console.log('PASS: five games, wins/resets, keyboard/touch, timer/listener cleanup; Home, setup/offline/validation/loading, isolated content, history, Overseer toggle/error, second session, re-enable and legacy login fallback.');
  } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
