/* Browser integration tests with durable-in-test HTTP mocks, real generated WAV
   decoding, and no live Supabase traffic. Run with Playwright installed. */
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {randomUUID} = require('node:crypto');
const root = path.resolve(__dirname,'..');
const tracks = new Map(), objects = new Map();
let failPublish = false, failDelete = false, failFinish = false, offline = false;
const wav = Buffer.alloc(44 + 44100 * 2 * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length-8,4); wav.write('WAVEfmt ',8);
wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22);
wav.writeUInt32LE(44100,24); wav.writeUInt32LE(88200,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34);
wav.write('data',36); wav.writeUInt32LE(wav.length-44,40);
for (let i=0;i<(wav.length-44)/2;i++) wav.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*220/44100)*1000),44+i*2);
const server = http.createServer((req,res) => {
  const file = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!file.startsWith(root+path.sep) || !fs.existsSync(file)) {res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));
});
async function setup(page) {
  await page.route('https://cdn.jsdelivr.net/**',route => route.fulfill({contentType:'text/javascript',body:'window.supabase={createClient:()=>({})};'}));
  await page.route('https://*.supabase.co/**',async route => {
    const request=route.request(), url=new URL(request.url()), method=request.method();
    const reply=(data,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if (method === 'OPTIONS') return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'*'}});
    if (offline) return reply({message:'offline'},503);
    const authorized=request.headers().authorization==='Bearer overseer-test';
    if(url.pathname.includes('/auth/v1/token')) return reply({user:{id:'overseer'},access_token:'overseer-test'});
    if(url.pathname.includes('/overseers')) return reply([{user_id:'overseer'}]);
    if(url.pathname.includes('/rpc/use_access_code')) return reply({success:true});
    if(url.pathname.includes('/rpc/radio_')) {
      if (!authorized) return reply({message:'denied'},403);
      const name=url.pathname.split('/').pop(), body=JSON.parse(request.postData() || '{}');
      if(name==='radio_is_overseer') return reply(true);
      if(name==='radio_reserve_track') {
        const id=randomUUID(); const track={id,title:body.p_title,artist:body.p_artist,station:body.p_station.toUpperCase(),storage_path:id+'.'+body.p_extension,file_size:body.p_size,mime_type:body.p_mime,status:'pending'};
        tracks.set(id,track);return reply(track);
      }
      const track=tracks.get(body.p_id);
      if(name==='radio_finish_delete') {
        if(failFinish){failFinish=false;return reply({message:'Try removal again'},503);}
        if(track && objects.has(track.storage_path)) return reply({message:'File still exists'},400);
        tracks.delete(body.p_id);return reply(true);
      }
      if(!track) return reply(null);
      if(name==='radio_publish_track') {
        if(failPublish){failPublish=false;return reply({message:'Publication interrupted; finish pending upload'},503);}
        if(!objects.has(track.storage_path)) return reply({message:'Upload missing'},400);
        track.status='ready';return reply(track);
      }
      if(name==='radio_edit_track') {Object.assign(track,{title:body.p_title,artist:body.p_artist,station:body.p_station.toUpperCase()});return reply(track);}
      if(name==='radio_begin_delete'){track.status='deleting';return reply(track);}
    }
    if(url.pathname==='/rest/v1/radio_tracks') {
      const rows=[...tracks.values()].filter(track=>authorized || track.status==='ready');
      const offset=Number(url.searchParams.get('offset')||0);return reply(rows.slice(offset,offset+500));
    }
    if(url.pathname.startsWith('/storage/v1/object/sign/')) {
      const name=decodeURIComponent(url.pathname.split('/').pop());
      if(method==='POST') {
        if(!objects.has(name) || ![...tracks.values()].some(t=>t.storage_path===name && t.status==='ready')) return reply({message:'not found'},404);
        return reply({signedURL:'/object/sign/robco-radio/'+name+'?token=test'});
      }
      const file=objects.get(name);if(!file)return reply({message:'gone'},404);
      return route.fulfill({status:200,contentType:'audio/wav',body:file});
    }
    if(url.pathname.startsWith('/storage/v1/object/robco-radio')) {
      if(!authorized)return reply({message:'denied'},403);
      if(method==='POST') {objects.set(decodeURIComponent(url.pathname.split('/').pop()),request.postDataBuffer());return reply({Key:'saved'});}
      if(method==='DELETE') {
        if(failDelete){failDelete=false;return reply({message:'Storage temporarily unavailable. Retry removal.'},503);}
        for(const name of JSON.parse(request.postData()).prefixes)objects.delete(name);
        return reply([]);
      }
    }
    return reply([]);
  });
}
async function loginManager(page,url) {
  await page.goto(url);
  await page.evaluate(()=>showOverseerLogin());
  await page.locator('#overseerEmail').fill('test@example.com');
  await page.locator('#overseerPassword').fill('test');
  await page.evaluate(()=>overseerLogin());
  await page.getByRole('button',{name:'MANAGE RADIO MUSIC'}).click();
  await page.waitForSelector('#musicUploadForm');
}
async function fillUpload(page,title='Test Broadcast') {
  const form=page.locator('#musicUploadForm');
  await form.locator('[name=audio]').setInputFiles({name:'../../unsafe name.wav',mimeType:'audio/wav',buffer:wav});
  await form.locator('[name=title]').fill(title);
  await form.locator('[name=artist]').fill('Authorized Artist');
  await form.locator('[name=station]').fill('Archive Test');
  await form.locator('[name=rights]').check();
  await form.getByRole('button',{name:'UPLOAD SONG',exact:true}).click();
  await page.waitForFunction(()=>!musicManagerBusy);
}
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{})});
  try {
    const context=await browser.newContext(); const page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));await setup(page);
    const url=`http://127.0.0.1:${server.address().port}`;
    await loginManager(page,url);
    // Reject oversize, wrong extension and corrupt content before reserving a row.
    const validation=await page.evaluate(async()=>{
      const messages=[];
      for(const file of [new File(['hello'],'bad.exe'),new File(['bad'],'bad.wav'),new File([new Uint8Array(25*1024*1024+1)],'big.wav')]) {
        try{await validateMusicFile(file);}catch(e){messages.push(e.message);}
      }
      return messages;
    });
    assert.equal(validation.length,3);
    await fillUpload(page);
    assert.match(await page.locator('[data-music-status]').textContent(),/UPLOAD COMPLETE/);
    assert.equal(tracks.size,1);assert.equal(objects.size,1);
    const track=[...tracks.values()][0];assert.match(track.storage_path,/^[a-f\d-]{36}\.wav$/);
    assert(objects.get(track.storage_path).equals(wav));
    // An entirely new browser context can play without selecting the file again.
    const listenerContext=await browser.newContext();const listener=await listenerContext.newPage();await setup(listener);
    listener.on('pageerror',e=>errors.push(e.message));await listener.goto(url);
    await listener.locator('#accessCode').fill('guest');await listener.evaluate(()=>login());
    await listener.evaluate(()=>showUserPage('radio'));
    await listener.getByRole('button',{name:'ARCHIVE TEST Overseer broadcast archive'}).click();
    assert.equal(await listener.locator('#radioTitle').textContent(),'Test Broadcast');
    assert.equal(await listener.getByRole('button',{name:'UPLOAD SONG',exact:true}).count(),0);
    assert.equal(await listener.getByRole('button',{name:'DELETE SONG',exact:true}).count(),0);
    await listener.locator('#radioPlay').click();await listener.waitForFunction(()=>robcoState==='ON AIR');
    assert(await listener.evaluate(()=>radioDuration()>1));
    await listener.waitForFunction(()=>radioPosition()>.1);
    await listener.locator('#radioPlay').click();assert.equal(await listener.evaluate(()=>robcoState),'PAUSED');
    await listener.evaluate(()=>seekRobcoRadio(.5));assert.equal(await listener.evaluate(()=>radioPosition()),.5);
    await listener.locator('#radioPlay').click();await listener.waitForFunction(()=>robcoState==='ON AIR');
    await listener.locator('#radioMute').click();assert.equal(await listener.evaluate(()=>robcoMedia.muted),true);
    await listener.evaluate(()=>{setRobcoVolume(20);});assert.equal(await listener.evaluate(()=>robcoMedia.volume),.2);
    await listener.evaluate(()=>stopRobcoRadio());
    // Browsers that block delayed autoplay can retry using the cached signed URL.
    await listener.evaluate(()=>{
      window.realMediaPlay=HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play=function(){return Promise.reject(new DOMException('Gesture required','NotAllowedError'));};
    });
    await listener.locator('#radioPlay').click();await listener.waitForFunction(()=>robcoState==='SIGNAL LOST');
    assert.match(await listener.locator('#radioDisplay').textContent(),/PLAYBACK BLOCKED/);
    await listener.evaluate(()=>{HTMLMediaElement.prototype.play=window.realMediaPlay;});
    await listener.locator('#radioPlay').click();await listener.waitForFunction(()=>robcoState==='ON AIR');
    const beforeRepeat=await listener.evaluate(()=>robcoGeneration);
    await listener.evaluate(()=>seekRobcoRadio(radioDuration()-.11));
    await listener.waitForFunction(before=>robcoGeneration>before+2 && robcoState==='ON AIR' && radioPosition()<1,beforeRepeat);
    await listener.evaluate(()=>stopRobcoRadio());
    // Metadata edits cannot inject HTML and survive reload/re-login.
    const card=page.locator('.music-song').first();
    await card.locator('[name=title]').fill('<img src=x onerror=alert(1)>');
    await card.locator('[name=artist]').fill('Edited Artist');
    await card.getByRole('button',{name:'SAVE METADATA'}).click();await page.waitForFunction(()=>!musicManagerBusy);
    await loginManager(page,url);assert.equal(await page.locator('.music-song [name=title]').inputValue(),'<img src=x onerror=alert(1)>');
    assert.equal(await page.locator('#musicManager img').count(),0);
    // Lost publication response leaves a recoverable row, never an invisible orphan.
    failPublish=true;await fillUpload(page,'Pending Broadcast');
    assert.equal([...tracks.values()].filter(t=>t.status==='pending').length,1);
    await page.getByRole('button',{name:'FINISH PENDING UPLOAD'}).click();await page.waitForFunction(()=>!musicManagerBusy);
    assert.equal([...tracks.values()].filter(t=>t.status==='ready').length,2);
    // Storage failure preserves a deleting row and hides it from listeners.
    page.on('dialog',dialog=>dialog.accept());failDelete=true;
    await page.locator('.music-song').first().getByRole('button',{name:'DELETE SONG',exact:true}).click();
    await page.waitForFunction(()=>!musicManagerBusy);
    assert.equal(tracks.get(track.id).status,'deleting');assert(objects.has(track.storage_path));
    await listener.evaluate(()=>refreshRadioLibrary());
    assert.notEqual(await listener.locator('#radioTitle').textContent(),'<img src=x onerror=alert(1)>');
    failFinish=true;await page.getByRole('button',{name:'RETRY REMOVAL'}).click();await page.waitForFunction(()=>!musicManagerBusy);
    assert(!objects.has(track.storage_path));assert(tracks.has(track.id));
    await page.getByRole('button',{name:'RETRY REMOVAL'}).click();await page.waitForFunction(()=>!musicManagerBusy);
    assert(!tracks.has(track.id));
    // Missing or corrupt media reports an error and local broadcasts remain usable.
    const remaining=[...tracks.values()][0];objects.delete(remaining.storage_path);
    await listener.evaluate(()=>refreshRadioLibrary());
    await listener.getByRole('button',{name:'ARCHIVE TEST Overseer broadcast archive'}).click();
    await listener.locator('#radioPlay').click();await listener.waitForFunction(()=>robcoState==='SIGNAL LOST');
    assert.match(await listener.locator('#radioDisplay').textContent(),/TRACK UNAVAILABLE/);
    objects.set(remaining.storage_path,Buffer.from('not audio'));
    await listener.locator('#radioPlay').click();await listener.waitForFunction(()=>robcoState==='SIGNAL LOST');
    await listener.locator('#radioStations button').first().click();await listener.locator('#radioPlay').click();
    await listener.waitForFunction(()=>robcoState==='ON AIR');
    await listener.evaluate(()=>showUserPage('dashboard'));assert(await listener.evaluate(()=>robcoMedia===null && robcoAudio===null));
    offline=true;await listener.evaluate(()=>showUserPage('radio'));
    await listener.waitForFunction(()=>document.getElementById('radioLibraryStatus').textContent.includes('UNAVAILABLE'));offline=false;
    await page.screenshot({path:path.join(root,'../music-manager-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    await page.screenshot({path:path.join(root,'../music-manager-mobile.png'),fullPage:true});
    // A forged/missing frontend session cannot open management.
    await page.evaluate(()=>{window.overseerSession=null;return showMusicManager();});
    assert.equal(await page.locator('#musicUploadForm').count(),0);
    assert.deepEqual(errors,[]);
    console.log('PASS: validated upload, permanent catalog across fresh browser context, real WAV playback, pause/seek/mute/volume, safe metadata edits, refresh persistence, pending publication recovery, two-stage deletion retry, missing/corrupt audio, offline fallback, management isolation, responsive layout.');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>server.close());
