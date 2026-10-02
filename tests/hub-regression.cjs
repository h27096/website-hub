/* Existing administrative flows against isolated fixtures; no live writes. */
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'..');
const server=http.createServer((req,res)=>{const file=path.resolve(root,'.'+(req.url==='/'?'/index.html':req.url.split('?')[0]));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{})});
  const sites=[],announcements=[],codes=[],requests=[{id:'request',name:'Requested site',url:'https://example.com',description:'Employee request'}];
  let maintenance=false;const errors=[],calls=[];
  try {
    const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
    page.on('dialog',d=>d.type()==='prompt'?d.accept(d.defaultValue()+' edited'):d.accept());
    await page.route('https://cdn.jsdelivr.net/**',r=>r.fulfill({contentType:'text/javascript',body:'window.supabase={createClient:()=>({})};'}));
    await page.route('https://*.supabase.co/**',r=>{
      const req=r.request(),name=new URL(req.url()).pathname.split('/').pop(),body=JSON.parse(req.postData()||'{}');
      const reply=data=>r.fulfill({contentType:'application/json',body:JSON.stringify(data)});
      calls.push(name);
      if(name==='token')return reply({user:{id:'admin'},access_token:'regression-admin'});
      if(name==='overseers')return reply([{user_id:'admin'}]);
      if(name==='privacy_preview_status')return reply(false);
      if(name==='websites')return reply([]);
      if(name==='get_enabled_managed_websites')return reply(sites.filter(s=>s.enabled));
      if(name==='get_visible_announcements')return reply(announcements);
      assert.equal(req.headers().authorization,'Bearer regression-admin',name);
      if(name==='overseer_view_websites')return reply(sites);
      if(name==='create_managed_website')sites.push({id:'site',name:body.website_name,url:body.website_url,description:body.website_description,enabled:true});
      if(name==='edit_managed_website')Object.assign(sites[0],{name:body.new_name,url:body.new_url,description:body.new_description});
      if(name==='set_managed_website_status')sites[0].enabled=body.enabled_status;
      if(name==='delete_managed_website')sites.length=0;
      if(name==='overseer_list_website_requests')return reply(requests);
      if(name==='overseer_review_website_request'){assert.equal(body.decision,'approved');requests.length=0;}
      if(name==='create_announcement')announcements.push({id:'announcement',title:body.announcement_title,message:body.announcement_message,created_at:new Date().toISOString()});
      if(name==='overseer_view_announcements')return reply(announcements);
      if(name==='edit_announcement')Object.assign(announcements[0],{title:body.new_title,message:body.new_message});
      if(name==='delete_announcement')announcements.length=0;
      if(name==='create_access_code'){codes.push({id:'code',access_code:'TEST-CODE',uses_remaining:100,active:true});return reply('TEST-CODE');}
      if(name==='overseer_view_codes')return reply(codes);
      if(name==='deactivate_access_code')codes[0].active=false;
      if(name==='reactivate_access_code')codes[0].active=true;
      if(name==='delete_access_code')codes.length=0;
      if(name==='get_maintenance_mode')return reply(maintenance);
      if(name==='set_maintenance_mode')maintenance=body.enabled;
      return reply(null);
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);await page.evaluate(()=>showOverseerLogin());
    await page.locator('#overseerEmail').fill('test@example.com');await page.locator('#overseerPassword').fill('test');await page.evaluate(()=>overseerLogin());
    await page.evaluate(()=>showWebsiteManager());await page.evaluate(()=>toggleAddWebsite());
    await page.locator('#websiteName').fill('Test site');await page.locator('#websiteURL').fill('https://example.com');await page.locator('#websiteDescription').fill('Fixture');await page.evaluate(()=>createManagedWebsite());
    await page.waitForFunction(()=>document.getElementById('managedWebsiteList').textContent.includes('Test site'));
    await page.evaluate(()=>editManagedWebsite('site'));assert.equal(sites[0].name,'Test site edited');
    await page.evaluate(()=>toggleManagedWebsite('site',true));assert.equal(sites[0].enabled,false);
    await page.evaluate(()=>toggleManagedWebsite('site',false));assert.equal(sites[0].enabled,true);
    await page.evaluate(()=>showWebsiteRequests());await page.getByRole('button',{name:'APPROVE & PUBLISH',exact:true}).click();await page.getByText('NO PENDING REQUESTS.',{exact:true}).waitFor();
    await page.evaluate(()=>toggleCreateAnnouncement());await page.locator('#announcementTitle').fill('Bulletin');await page.locator('#announcementMessage').fill('Message');await page.evaluate(()=>createAnnouncement());
    assert.equal(announcements.length,1);await page.evaluate(()=>loadAnnouncements());await page.evaluate(()=>editAnnouncement('announcement'));assert.equal(announcements[0].title,'Bulletin edited');
    await page.evaluate(()=>generateGuestCode());assert.match(await page.locator('#overseerOutput').textContent(),/TEST-CODE/);
    await page.evaluate(()=>viewAccessCodes());await page.evaluate(()=>deactivateCode('code'));assert.equal(codes[0].active,false);
    await page.evaluate(()=>reactivateCode('code'));assert.equal(codes[0].active,true);
    await page.evaluate(()=>toggleMaintenanceMode());assert.equal(maintenance,true);await page.evaluate(()=>toggleMaintenanceMode());assert.equal(maintenance,false);
    await page.evaluate(()=>{openUserSide();showUserPage('websites');});await page.getByText('Test site edited',{exact:true}).waitFor();
    await page.evaluate(()=>showUserPage('announcements'));await page.locator('#userAnnouncements').getByText(/Bulletin edited/).waitFor();
    await page.evaluate(()=>returnToOverseer());await page.evaluate(()=>showWebsiteManager());await page.evaluate(()=>deleteManagedWebsite('site'));assert.equal(sites.length,0);
    await page.evaluate(()=>deleteAnnouncement('announcement'));assert.equal(announcements.length,0);
    await page.evaluate(()=>deleteAccessCode('code'));assert.equal(codes.length,0);
    assert.deepEqual(errors,[]);
    for(const expected of ['create_access_code','set_maintenance_mode','overseer_review_website_request','edit_managed_website','edit_announcement'])assert(calls.includes(expected));
    console.log('PASS: existing Overseer JWT login, website CRUD/status, request approval, announcements CRUD/user view, access-code create/deactivate/reactivate/delete, maintenance on/off and user navigation.');
  } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
