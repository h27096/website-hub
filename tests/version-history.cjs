/* Public history and role integration; all backend responses are isolated mocks.
   Run with Playwright installed: node tests/version-history.cjs */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const data = vm.runInNewContext(fs.readFileSync(path.join(root, 'version-history-data.js'), 'utf8') + '\nJSON.stringify(ROBCO_VERSION_HISTORY)');
const history = JSON.parse(data);
assert.equal(history.releases[0].version, 'v1.4');
assert.deepEqual(history.releases.map(r => r.version), ['v1.4','v1.3','v1.2','v1.1','v1.0','v0.5','v0.4','v0.3','v0.2','v0.1']);
assert.deepEqual(history.roadmap.map(r=>r.version), ['v1.5']);
assert.match(history.roadmap[0].title, /RobCo Live Training/);
const versions = new Set();
for (const release of history.releases) {
  assert.match(release.version, /^v\d+\.[0-9]$/);
  assert(!versions.has(release.version)); versions.add(release.version);
  assert(release.changes.length);
}
for (const item of history.roadmap) assert(!versions.has(item.version));
const instructions = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
assert.match(instructions, /MUST review and update/);
assert.match(instructions, /v1\.9 -> v2\.0/);
const server = http.createServer((req,res) => {
  const file = path.resolve(root, '.' + (req.url === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const browser = await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{})});
  try {
    const page = await browser.newPage();
    const errors = []; let requests = 0;
    page.on('pageerror',error => errors.push(error.message));
    await page.route('https://cdn.jsdelivr.net/**',r => r.fulfill({contentType:'text/javascript',body:'window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:window.testEmployeeSession||null}}),setSession:async s=>{window.testEmployeeSession=s;return{};}}})};'}));
    await page.route('https://*.supabase.co/**',r => {
      requests++;
      const url = r.request().url(); let data = [];
      if (url.includes('use_access_code')) data = {success:true};
      if(url.includes('personnel_selection')) data=[{id:'test-person',callsign:'Test Person',title:'Employee'}];
      if(url.includes('personnel-auth')) data={session:{access_token:'employee-jwt',refresh_token:'refresh'}};
      if(url.includes('personnel_action'))data={id:'test-person',callsign:'Test Person',title:'Employee',permissions:['website.submit'],website_requests:[]};
      if (url.includes('/auth/v1/token')) data = {user:{id:'test'},access_token:'test-token'};
      if (url.includes('/overseers?')) data = [{user_id:'test'}];
      return r.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    let canonicalText;
    async function checkHistory(button, label) {
      await button.click();
      const dialog = page.getByRole('dialog', {name:'VERSION / UPDATE LOG'});
      assert(await dialog.isVisible());
      assert.equal(await dialog.locator('.version-history-current').textContent(), 'ROBCO WEBSITE HUB // VERSION v1.4');
      const sections = dialog.locator('section');
      assert.equal(await sections.nth(0).locator('article').count(), history.releases.length);
      for (const release of history.releases) {
        const entry = sections.nth(0).locator('article').filter({has:page.getByRole('heading',{name:new RegExp('^'+release.version.replace('.', '\\.')+' //')})});
        assert.deepEqual(await entry.locator('li').allTextContents(), release.changes);
      }
      assert(!/v1\.5/.test((await sections.nth(0).getByRole('heading').allTextContents()).join(' ')));
      assert.match(await sections.nth(1).textContent(), /RobCo Live Training/);
      assert.equal(await sections.nth(1).locator('article').count(), 1);
      const text = await dialog.textContent();
      if (canonicalText) assert.equal(text,canonicalText); else canonicalText = text;
      assert.equal(await dialog.locator('input,textarea,[contenteditable=true]').count(),0);
      for (const width of [1280,390,320]) {
        await page.setViewportSize({width,height:800});
        assert(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
      if (label === 'user') await page.screenshot({path:path.join(root,'../version-history-mobile.png')});
      await page.setViewportSize({width:1280,height:800});
      if (label === 'user') await page.screenshot({path:path.join(root,'../version-history-desktop.png')});
      await page.keyboard.press('Escape');
      assert(!(await dialog.isVisible()));
      assert(await button.evaluate(el => el === document.activeElement));
      await button.click();
      await dialog.getByRole('button',{name:'CLOSE VERSION HISTORY'}).click();
      assert(!(await dialog.isVisible()));
    }
    await page.goto(url);
    await checkHistory(page.locator('.header .version-history-link'), 'public');
    await page.locator('#accessCode').fill('test-only'); await page.evaluate(() => login());
    await checkHistory(page.locator('#dashboard').getByRole('button',{name:'UPDATE LOG / VERSION HISTORY'}), 'user');
    await page.goto(url); await page.evaluate(() => showEmployeeLogin());
    await page.getByRole('button',{name:'Test Person — Employee'}).click();await page.getByLabel('PERSONAL PASSWORD').fill('employee-password-123');await page.getByRole('button',{name:'SIGN IN',exact:true}).click();await page.getByRole('button',{name:'WEBSITE REQUESTS',exact:true}).click();await page.getByLabel('WEBSITE NAME').fill('Preserve my request');
    await checkHistory(page.locator('#loginScreen').getByRole('button',{name:'UPDATE LOG / VERSION HISTORY'}), 'employee');
    assert.equal(await page.getByLabel('WEBSITE NAME').inputValue(),'Preserve my request');
    await page.goto(url); await page.evaluate(() => showOverseerLogin());
    await page.locator('#overseerEmail').fill('test@example.com');
    await page.locator('#overseerPassword').fill('test-only'); await page.evaluate(() => overseerLogin());
    await page.getByRole('button',{name:'SYSTEM',exact:true}).click();await checkHistory(page.locator('#loginScreen').getByRole('button',{name:'UPDATE LOG / VERSION HISTORY'}), 'overseer');
    assert.deepEqual(errors,[]);
    // History remains usable even if every external dependency is unavailable.
    await page.route('https://**',r => r.abort());
    await page.goto(url);
    const before = requests;
    await checkHistory(page.locator('.header .version-history-link'), 'offline-backend');
    assert.equal(requests,before);
    console.log('PASS: canonical data, public/three-role access, combined v1.4/history/v1.5 planned roadmap, no editor/backend dependency, preserved form, Escape/close/focus, desktop/mobile layout.');
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;}).finally(() => server.close());
