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
  const contexts=[];
  const errors=[];
  try {
    async function setup(mobile=false) {
      const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1280,height:900},hasTouch:mobile});contexts.push(context);
      await context.route('https://cdn.jsdelivr.net/**',r=>r.fulfill({contentType:'text/javascript',body:'window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}})}})};'}));
      await context.route('https://*.supabase.co/**',r=>{
        const request=r.request(), name=new URL(request.url()).pathname.split('/').pop();
        assert(!/privacy|proxy/i.test(request.url()), 'Canceled feature must make no service requests');
        const reply=(data,status=200)=>r.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
        if(name==='use_access_code') return reply({success:true});
        if(name==='token') return reply({user:{id:'admin'},access_token:'test-admin'});
        if(name==='overseers') return reply([{user_id:'admin'}]);
        return reply([]);
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
    // Removed screens and handlers cannot be reached by stale navigation.
    await page.evaluate(()=>showUserPage('dashboard'));
    assert.equal(await page.locator('#privateTerminal, #privacyHomeStatus').count(),0);
    assert.equal(await page.locator('[onclick]').evaluateAll(nodes=>nodes.filter(n=>/privacy|proxy/i.test(n.getAttribute('onclick'))).length),0);
    const before=await page.locator('#dashboard').isVisible();
    await page.evaluate(()=>showUserPage('privateTerminal'));
    assert.equal(await page.locator('#dashboard').isVisible(),before);
    assert.equal(await page.evaluate(()=>typeof showPrivacyPreview),'undefined');
    assert.equal(await page.evaluate(()=>typeof showPrivacyControl),'undefined');
    const other=await setup(true);
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
    assert.deepEqual(errors,[]);
    console.log('PASS: five games, keyboard/touch, cleanup, Dashboard, removed screen/handler checks and no console errors.');
  } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
