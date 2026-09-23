/* Run: npm install --no-save playwright && node tests/radio.cjs
   Uses isolated mocked Supabase responses; never writes to the live service. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req,res) => {
  const file = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true, ...(process.env.BROWSER_CHANNEL ? {channel:process.env.BROWSER_CHANNEL} : {})});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://cdn.jsdelivr.net/**', route => route.fulfill({contentType:'text/javascript', body:'window.supabase={createClient:()=>({})};'}));
    await page.route('https://*.supabase.co/**', route => {
      const url = route.request().url();
      let data = [];
      if (url.includes('use_access_code')) data = {success:true};
      if (url.includes('employee_login')) data = true;
      if (url.includes('/auth/v1/token')) data = {user:{id:'test'}, access_token:'test-token'};
      if (url.includes('/overseers?')) data = [{user_id:'test'}];
      return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(url);
    await page.locator('#accessCode').fill('test-only');
    await page.evaluate(() => login());
    assert(await page.locator('#dashboard').isVisible());
    await page.evaluate(() => showUserPage('radio'));
    assert.equal(await page.locator('#radioStations button').count(),3);
    assert.equal(await page.locator('#radioPlaylist button').count(),3);
    await page.locator('#radioPlay').click();
    await page.waitForFunction(() => robcoState === 'ON AIR');
    // Render through real Web Audio offline and confirm a finite, non-silent signal.
    const signal = await page.evaluate(async () => {
      const savedAudio = robcoAudio, savedMaster = robcoMaster;
      const offline = new OfflineAudioContext(1,44100,44100);
      robcoAudio = offline; robcoMaster = offline.createGain(); robcoMaster.connect(offline.destination);
      for (const event of buildRadioScore(radioTrack()).filter(e => e.time < .8)) scheduleRadioNote(event,event.time);
      robcoAudio = savedAudio; robcoMaster = savedMaster;
      const samples = (await offline.startRendering()).getChannelData(0);
      return {peak:Math.max(...samples.map(Math.abs)), finite:samples.every(Number.isFinite)};
    });
    assert(signal.finite && signal.peak > .001 && signal.peak < 1);
    await page.waitForFunction(() => radioPosition() > .25);
    await page.locator('#radioPlay').click();
    const paused = await page.evaluate(() => radioPosition());
    assert.equal(await page.evaluate(() => robcoState),'PAUSED');
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => radioPosition()),paused);
    await page.evaluate(() => seekRobcoRadio(10));
    assert.equal(await page.evaluate(() => radioPosition()),10);
    await page.locator('#radioPlay').click();
    await page.waitForFunction(() => robcoState === 'ON AIR');
    await page.locator('#radioMute').click();
    assert.equal(await page.locator('#radioMute').getAttribute('aria-pressed'),'true');
    await page.evaluate(() => setRobcoVolume(35));
    assert.equal(await page.locator('#radioVolumeValue').textContent(),'35%');
    await page.getByRole('button',{name:'Next track',exact:true}).click();
    await page.waitForFunction(() => robcoState === 'ON AIR');
    assert.equal(await page.locator('#radioTitle').textContent(),'After Hours Assembly');
    await page.getByRole('button',{name:'Previous track',exact:true}).click();
    await page.waitForFunction(() => robcoState === 'ON AIR');
    assert.equal(await page.locator('#radioTitle').textContent(),'Lunch Break at Relay Nine');
    await page.evaluate(() => seekRobcoRadio(radioDuration() - .11));
    await page.waitForFunction(() => robcoTrack === 1 && robcoState === 'ON AIR');
    await page.locator('#radioStations button').nth(1).click();
    await page.waitForFunction(() => robcoState === 'ON AIR');
    assert.equal(await page.locator('#radioTitle').textContent(),'Atrium Lights');
    await page.locator('#radioPlaylist button').nth(2).click();
    assert.equal(await page.locator('#radioTitle').textContent(),'Original Vault Signal');
    await page.evaluate(() => { selectRobcoStation(0); selectRobcoStation(2); stopRobcoRadio(); });
    await page.waitForTimeout(100);
    assert(await page.evaluate(() => robcoState === 'OFFLINE' && robcoAudio === null && robcoRadioTimer === null));
    // Pending audio resume cannot resurrect playback after leaving Radio.
    await page.evaluate(() => {
      window.savedAudio = window.AudioContext;
      window.AudioContext = class { resume() { return new Promise(resolve => window.finishResume = resolve); } close() { return Promise.resolve(); } };
      playRobcoRadio(); stopRobcoRadio(); window.finishResume(); window.AudioContext = window.savedAudio;
    });
    assert.equal(await page.evaluate(() => robcoState),'OFFLINE');
    await page.evaluate(() => { window.AudioContext = undefined; window.webkitAudioContext = undefined; toggleRobcoRadio(); });
    assert.match(await page.locator('#radioDisplay').textContent(),/AUDIO UNAVAILABLE/);
    await page.evaluate(() => { window.AudioContext = class { constructor() { throw Error('device'); } }; toggleRobcoRadio(); });
    assert.match(await page.locator('#radioDisplay').textContent(),/AUDIO START FAILED/);
    await page.evaluate(() => { window.AudioContext = window.savedAudio; toggleRobcoRadio(); });
    await page.waitForFunction(() => robcoState === 'ON AIR');
    await page.evaluate(() => robcoAudio.suspend());
    await page.waitForFunction(() => robcoState === 'SIGNAL LOST');
    await page.locator('#radioPlay').click();
    await page.waitForFunction(() => robcoState === 'ON AIR');
    await page.evaluate(() => showUserPage('dashboard'));
    assert(await page.evaluate(() => robcoAudio === null));
    await page.evaluate(() => showUserPage('holotapes'));
    await page.locator('#holotapes .archive-card').first().click();
    assert.match(await page.locator('#holotapeReader').textContent(),/Morning Systems Check/);
    await page.evaluate(() => showUserPage('files'));
    await page.locator('#files .archive-card').first().click();
    assert.match(await page.locator('#fileReader').textContent(),/Terminal Operations Handbook/);
    await page.evaluate(() => { showUserPage('games'); startCodebreaker(); });
    const code = await page.evaluate(() => robcoGame.code);
    await page.locator('#gameOutput input').fill(code);
    await page.getByRole('button',{name:'TEST CODE'}).click();
    assert.match(await page.locator('#gameOutput').textContent(),/ACCESS GRANTED/);
    await page.evaluate(() => startSignalMatch());
    assert.equal(await page.locator('#gameOutput button').count(),4);
    for (const name of ['websites','announcements']) {
      await page.evaluate(name => showUserPage(name),name);
      assert(await page.locator('#hub').isVisible());
    }
    await page.evaluate(() => { showUserPage('radio'); selectRobcoStation(0); });
    await page.screenshot({path:path.join(root,'../radio-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({path:path.join(root,'../radio-mobile.png'),fullPage:true});
    await page.evaluate(() => logout());
    assert(await page.locator('#loginScreen').isVisible());
    await page.evaluate(() => showEmployeeLogin());
    await page.locator('#employeePassword').fill('test-only');
    await page.evaluate(() => employeeLogin());
    assert(await page.locator('#employeeWebsiteName').isVisible());
    await page.goto(url);
    await page.evaluate(() => showOverseerLogin());
    await page.locator('#overseerEmail').fill('test@example.com');
    await page.locator('#overseerPassword').fill('test-only');
    await page.evaluate(() => overseerLogin());
    assert.match(await page.locator('#loginScreen').textContent(),/ROBCO ADMINISTRATIVE CONTROL/);
    await page.evaluate(() => { openUserSide(); showUserPage('radio'); });
    await page.locator('#radioPlay').click();
    await page.waitForFunction(() => robcoState === 'ON AIR');
    await page.evaluate(() => returnToOverseer());
    assert(await page.evaluate(() => robcoAudio === null));
    assert.deepEqual(errors,[]);
    console.log('PASS: audio rendering, playback, pause, seek, navigation, queue advance, station switching, mute, errors, async cancellation, responsive layout, login, dashboard, archives, games, websites, announcements, employee and Overseer flows (mocked service).');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
