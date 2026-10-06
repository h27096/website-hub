/* v1.4: isolated employee Auth session; all private data and permissions come from RPCs. */
(() => {
 'use strict';
 const permissions = {'website.submit':'Submit Website Requests','training.submit':'Submit Training Requests','training.draft':'Create Training Drafts','training.edit':'Propose Training Set Edits',documents:'Access Personal Documents',notes:'Use Personal Notes'};
 let client, profile, root, content, status, currentEmployee, temporaryTimer;
 const authClient = () => client ||= supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{auth:{storageKey:'robco-personnel-v14',persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
 const node=(tag,text)=>{const n=document.createElement(tag); if(text!==undefined)n.textContent=text; return n;};
 function safeError(e) { return String(e.message || e).replace(/Bearer\s+\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|sb_secret_\S+/g,'[REDACTED]').slice(0,500); }
 function message(text,error=false) { if(status){status.textContent=text;status.className=error?'personnel-error':'';} }
 function button(label,fn,parent=content) {
 const b=node('button',label);b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){message(safeError(e),true);}finally{b.disabled=false;}};parent.append(b);return b;
 }
 function field(label,value='',type='text',parent=content) {
 const l=node('label',label),n=node(type==='textarea'?'textarea':type==='select'?'select':'input');
 n.setAttribute('aria-label',label);
 if(!['textarea','select'].includes(type))n.type=type;
 if(type==='checkbox')n.checked=!!value;else n.value=value;
 l.append(n);parent.append(l);return n;
 }
 function select(label,options,value,parent=content) {const n=field(label,'','select',parent);options.forEach(([v,t])=>{const o=node('option',t);o.value=v;n.append(o);});n.value=value;return n;}
 function screen(title,admin=false) {
 const host=document.getElementById('loginScreen');host.classList.remove('hidden');document.getElementById('dashboard').classList.add('hidden');document.getElementById('hub').classList.add('hidden');
 host.replaceChildren();root=node('section');root.className='login personnel-shell';host.append(root);
 root.append(node('small','ROBCO INDUSTRIES // '+(admin?'OVERSEER ADMINISTRATION':'EMPLOYEE NETWORK')),node('h1',title));
 status=node('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');root.append(status);
 const nav=node('nav');root.append(nav);
 button('UPDATE LOG / VERSION HISTORY',()=>openVersionHistory(),nav);
 button(admin?'RETURN TO OVERSEER TERMINAL':'MY ROBCO',()=>admin?showOverseerPanel():dashboard(),nav);
 content=node('div');content.className='personnel-content';root.append(content);
 }
 async function rpc(action,data={}) {
 const session=window.overseerSession && action.startsWith('admin-')?window.overseerSession:(await authClient().auth.getSession()).data.session;
 return request('/rest/v1/rpc/personnel_action',{p_action:action,p_data:data},session?.access_token);
 }
 async function request(path,data,jwt) {
 let response;
 try {response=await fetch(SUPABASE_URL+path,{method:'POST',credentials:'omit',headers:{apikey:SUPABASE_KEY,'Content-Type':'application/json',...(jwt?{Authorization:'Bearer '+jwt}:{})},body:JSON.stringify(data)});}catch {throw Error('NETWORK / CORS: no readable response. Check personnel-auth deployment and allowed origin.');}
 let value;try{value=await response.json();}catch{throw Error('Backend returned a non-JSON response // HTTP '+response.status);}
 if(!response.ok)throw Error((response.status===404?'Function/RPC missing; SQL and Edge code require separate deployment. ':'')+(value.error || value.message || 'Operation failed')+' // HTTP '+response.status);
 return value;
 }
 async function edge(action,data={},admin=false) {
 const session=admin?window.overseerSession:(await authClient().auth.getSession()).data.session;
 return request('/functions/v1/personnel-auth',{action,...data},session?.access_token);
 }
 async function openLogin() {
 screen('SELECT PERSONNEL RECORD');root.querySelector('nav').replaceChildren();button('UPDATE LOG / VERSION HISTORY',()=>openVersionHistory(),root.querySelector('nav'));button('RETURN',()=>location.reload(),root.querySelector('nav'));
 message('LOADING PERSONNEL...');
 try {
 const records=await request('/rest/v1/rpc/personnel_selection',{});message('');
 if(!records.length)content.append(node('p','NO ACTIVE PERSONNEL. Ask an Overseer to add your record.'));
 records.forEach(p=>button(p.callsign+' — '+(p.title || 'EMPLOYEE'),()=>passwordScreen(p)));
 button('TEMPORARY LIMITED ACCESS',temporaryLogin);
 }catch(e){message(safeError(e),true);}
 }
 function passwordScreen(p) {
 screen('AUTHENTICATE: '+p.callsign);const password=field('PERSONAL PASSWORD','','password');password.autocomplete='current-password';password.maxLength=128;
 button('SIGN IN',async()=>{try{const r=await edge('login',{employee_id:p.id,password:password.value});password.value='';const saved=await authClient().auth.setSession(r.session);if(saved.error)throw saved.error;await dashboard();}finally{password.value='';}});
 button('BACK TO PERSONNEL',openLogin);password.focus();password.onkeydown=e=>{if(e.key==='Enter')content.querySelector('button').click();};
 }
 async function dashboard() {
 const p=await rpc('profile');profile=p;
 screen('WELCOME, '+p.callsign);content.append(node('p',p.title+' // ACTIVE PERSONNEL'));
 const menu=node('div');menu.className='personnel-grid';content.append(menu);
 if(p.permissions.includes('website.submit'))button('WEBSITE REQUESTS',websiteRequests,menu);
 if(p.permissions.some(x=>x.startsWith('training.')))button('TRAINING REQUESTS',trainingRequests,menu);
 if(p.permissions.includes('notes'))button('NOTES',notes,menu);
 if(p.permissions.includes('documents'))button('MY DOCUMENTS',()=>documents(p.id,false),menu);
 button('REQUEST HISTORY',()=>personnelFile(p,false),menu);
 button('MY PERSONNEL FILE',async()=>personnelFile(await rpc('profile'),false),menu);
 button('EMPLOYEE HANDBOOK',async()=>{const r=await rpc('shared-document');screen('EMPLOYEE HANDBOOK');if(r)content.append(RobcoDocument.renderNode(r.content));else content.append(node('p','No shared document initialized.'));},menu);
 button('ANNOUNCEMENTS',announcements,menu);
 button('SIGN OUT',async()=>{await authClient().auth.signOut();profile=null;await openLogin();},menu);
 message('Personal workspace. Passwords are managed by Supabase Auth.');
 }
 async function announcements() {
 screen('ANNOUNCEMENTS');const rows=await request('/rest/v1/rpc/get_visible_announcements',{});
 rows.forEach(r=>{content.append(node('h2',r.title),node('p',r.message));});
 }
 const pretty=value=>JSON.stringify(value,null,2);
 function card(parent=content) {const c=node('article');c.className='personnel-card';parent.append(c);return c;}
 function renderRequests(rows,type,parent=content) {
 if(!rows.length)parent.append(node('p','NO '+type+' REQUESTS.'));
 rows.forEach(r=>{const c=card(parent);c.append(node('h3',r.name || r.data?.title || 'Study set'),node('p',(r.status==='rejected'?'DENIED':r.status.toUpperCase())+' // '+(r.request_kind || type)),node('p','Created: '+r.created_at+(r.submitted_at?' // Submitted: '+r.submitted_at:'')+(r.reviewed_at?' // Reviewed: '+r.reviewed_at:'')));
 if(r.response)c.append(node('p','Overseer response: '+r.response));});
 }
 function personnelFile(p,admin) {
 if(admin)currentEmployee=p;
 screen(p.callsign+' // PERSONNEL FILE',admin);
 content.append(node('p','ID: '+p.id),node('p',p.title+' // '+p.status.toUpperCase()),node('p','Joined: '+p.join_date+' // Created: '+p.created_at),node('p','Permissions: '+p.permissions.join(', ')));
 const requests=[...p.website_requests,...p.training_requests];
 content.append(node('p',`Requests: ${requests.length} // Pending: ${requests.filter(r=>r.status==='pending').length} // Approved: ${requests.filter(r=>r.status==='approved').length} // Denied: ${requests.filter(r=>['denied','rejected'].includes(r.status)).length}`));
 if(admin) {
 const title=field('POSITION / TITLE',p.title),state=select('STATUS',[['active','ACTIVE'],['inactive','INACTIVE / LOGIN DISABLED'],['archived','ARCHIVED']],p.status),perms=permissionFields(p.permissions);
 button('SAVE ROLE / PERMISSIONS / STATUS',async()=>{if(state.value!==p.status && !confirm('Change personnel status? Active sessions will be invalidated. Reactivation requires a password reset.'))return;await rpc('admin-update',{employee_id:p.id,title:title.value,status:state.value,permissions:perms()});personnelFile(await rpc('admin-profile',{employee_id:p.id}),true);});
 const pw=field('NEW PASSWORD — RESET ONLY','','password');pw.autocomplete='new-password';
 button('RESET PASSWORD',async()=>{if(!confirm('Reset password and invalidate existing employee sessions?'))return;try{const r=await edge('reset-password',{employee_id:p.id,password:pw.value},true);message(r.message);}finally{pw.value='';}});
 const body=field('OVERSEER PERSONNEL NOTE','','textarea'),visible=field('VISIBLE TO EMPLOYEE',false,'checkbox');
 button('ADD PERSONNEL NOTE',async()=>{await rpc('admin-note',{employee_id:p.id,body:body.value,visible:visible.checked});personnelFile(await rpc('admin-profile',{employee_id:p.id}),true);});
 }
 button(admin?'PERSONNEL DOCUMENTS':'MY DOCUMENTS',()=>documents(p.id,admin));
 content.append(node('h2','OVERSEER PERSONNEL NOTES'));
 p.personnel_notes.forEach(n=>content.append(node('p',(n.visible?'VISIBLE TO EMPLOYEE':'OVERSEER ONLY')+' // '+n.created_at+' // '+n.body)));
 content.append(node('h2','WEBSITE REQUEST HISTORY'));renderRequests(p.website_requests,'WEBSITE');
 content.append(node('h2','TRAINING REQUEST HISTORY'));renderRequests(p.training_requests,'TRAINING');
 content.append(node('h2','WORKFLOW HISTORY'));p.history.forEach(e=>content.append(node('p',e.created_at+' // '+e.event)));
 }
 function permissionFields(existing=[]) {const fs=node('fieldset');fs.append(node('legend','EMPLOYEE PERMISSIONS'));content.append(fs);const checks=Object.entries(permissions).map(([id,label])=>[id,field(label,existing.includes(id),'checkbox',fs)]);return ()=>[...checks.filter(([,n])=>n.checked).map(([id])=>id),...existing.filter(id=>!Object.hasOwn(permissions,id))];}
 async function directory() {
 screen('EMPLOYEE DIRECTORY',true);button('+ ADD EMPLOYEE',addEmployee);
 const search=field('SEARCH CALLSIGN'),state=select('FILTER',[['all','ALL'],['active','ACTIVE'],['inactive','INACTIVE'],['archived','ARCHIVED']],'all');
 const list=node('div');content.append(list);
 async function load(){const rows=await rpc('admin-directory',{search:search.value,status:state.value});list.replaceChildren();rows.forEach(p=>button(p.callsign+' — '+p.title+' // '+p.status.toUpperCase(),async()=>personnelFile(await rpc('admin-profile',{employee_id:p.id}),true),list));if(!rows.length)list.append(node('p','NO MATCHES.'));}
 button('SEARCH / REFRESH',load);await load();
 }
 function addEmployee() {
 screen('+ ADD EMPLOYEE',true);const name=field('NAME / CALLSIGN'),title=field('POSITION / TITLE'),date=field('JOIN DATE',new Date().toISOString().slice(0,10),'date'),pw=field('INITIAL PASSWORD (12–128 characters)','','password'),perms=permissionFields();pw.autocomplete='new-password';
 button('CREATE PERSONNEL RECORD',async()=>{try{const p=await edge('create',{callsign:name.value,title:title.value,join_date:date.value,password:pw.value,permissions:perms()},true);personnelFile(await rpc('admin-profile',{employee_id:p.id}),true);}finally{pw.value='';}});
 }
 async function notes() {
 const rows=await rpc('notes');screen('MY NOTES');button('+ NEW NOTE',()=>editNote({}));
 rows.forEach(n=>{const c=card();c.append(node('h3',n.title),node('p','Updated: '+n.updated_at));button('OPEN / EDIT',()=>editNote(n),c);});
 }
 function editNote(n) {
 screen(n.id?'EDIT EMPLOYEE NOTE':'NEW EMPLOYEE NOTE');const title=field('TITLE',n.title || ''),body=field('NOTE',n.body || '','textarea');
 button('SAVE',async()=>{await rpc('save-note',{id:n.id || null,title:title.value,body:body.value});await notes();});
 if(n.id)button('DELETE NOTE',async()=>{if(confirm('Delete this personal note?')){await rpc('delete-note',{id:n.id});await notes();}});
 }
 async function websiteRequests() {
 const p=await rpc('profile');screen('WEBSITE REQUESTS');const name=field('WEBSITE NAME'),url=field('HTTPS / HTTP URL','','url'),description=field('DESCRIPTION','','textarea');
 button('SUBMIT REQUEST',async()=>{await rpc('website-submit',{name:name.value,url:url.value,description:description.value});await websiteRequests();});
 renderRequests(p.website_requests,'WEBSITE');
 }
 async function adminWebsiteRequests() {
 screen('WEBSITE REQUESTS',true);const rows=await rpc('admin-website-list');
 rows.forEach(r=>{const c=card();c.append(node('h3',r.name),node('p',r.employee+' // '+(r.status==='rejected'?'DENIED':r.status.toUpperCase())),node('p',r.url),node('p',r.description),node('p','Submitted: '+r.created_at));if(r.status==='pending'){const response=field('OVERSEER RESPONSE','','textarea',c);['approved','rejected'].forEach(decision=>button(decision==='approved'?'APPROVE & PUBLISH':'DENY',async()=>{if(!confirm('Review website request: '+decision+'?'))return;await rpc('admin-website-review',{id:r.id,decision,response:response.value});await adminWebsiteRequests();},c));}else c.append(node('p',r.response));});
 }
 async function trainingRequests() {
 const rows=await rpc('training-list');screen('TRAINING REQUESTS');
 if(profile.permissions.includes('training.draft'))button('CREATE NEW STUDY SET PROPOSAL',()=>trainingEditor(null));
 if(profile.permissions.includes('training.draft') && profile.permissions.includes('training.edit')) {
 const sets=await request('/rest/v1/rpc/training_catalog',{p_admin:false});const choice=select('PROPOSE EDIT TO EXISTING SET',sets.map(s=>[s.id,s.title]),sets[0]?.id || '');
 button('CREATE PRIVATE EDIT DRAFT',async()=>{await rpc('training-create',{source_id:choice.value});await trainingRequests();});
 }
 rows.forEach(r=>{const c=card();renderRequests([r],'TRAINING',c);button(r.status==='draft'?'OPEN / EDIT DRAFT':'VIEW PROPOSAL',()=>trainingEditor(r),c);});
 }
 function trainingEditor(r) {
 screen(r?'STUDY SET PROPOSAL: '+r.status.toUpperCase():'NEW PRIVATE STUDY SET DRAFT');const editable=!r || r.status==='draft';
 const inputs={};['title','subject','unit','topic','description','source_url'].forEach(key=>{inputs[key]=field(key.toUpperCase(),r?.data[key] || '',key==='description'?'textarea':'text');inputs[key].disabled=!editable;});
 let questions=structuredClone(r?.questions || []);const bank=node('div');content.append(bank);
 function renderBank(){bank.replaceChildren();questions.forEach((q,i)=>{const c=card(bank);c.append(node('h3','QUESTION '+(i+1)));const kind=select('TYPE',[['term','TERM / DEFINITION'],['mc','MULTIPLE CHOICE'],['tf','TRUE / FALSE'],['typed','TYPED ANSWER']],q.kind,c),prompt=field('PROMPT',q.prompt,'textarea',c),answer=field('ANSWER',q.answer,'textarea',c),choices=field('MULTIPLE CHOICE OPTIONS (one per line)',(q.choices || []).join('\n'),'textarea',c),active=field('ACTIVE',q.active!==false,'checkbox',c);[kind,prompt,answer,choices,active].forEach(n=>n.disabled=!editable);const update=()=>Object.assign(q,{kind:kind.value,prompt:prompt.value,answer:answer.value,choices:choices.value.split('\n').filter(Boolean),active:active.checked});[kind,prompt,answer,choices,active].forEach(n=>n.oninput=update);if(editable)button('REMOVE QUESTION',()=>{questions.splice(i,1);renderBank();},c);});}
 renderBank();
 if(editable) {
 button('+ ADD QUESTION',()=>{questions.push({kind:'term',prompt:'',answer:'',choices:[],active:true});renderBank();});
 const paste=field('BULK PASTE / IMPORT — term | definition','','textarea'),delimiter=select('DELIMITER',[['|','PIPE'],['\t','TSV'],[',','CSV']],'|'),file=field('IMPORT CSV / TSV FILE','','file');file.accept='.csv,.tsv,.txt';file.onchange=async()=>{try{if(file.files[0].size>1000000)throw Error('Import maximum 1 MB.');paste.value=await file.files[0].text();}catch(e){message(safeError(e),true);}};
 button('PREVIEW IMPORT',()=>{const parsed=TrainingEngine.parseImport(paste.value,delimiter.value);if(parsed.errors.length)throw Error(parsed.errors.join(' '));const preview=card();preview.append(node('pre',pretty(parsed.questions)));button('ADD PREVIEWED QUESTIONS',()=>{if(questions.length+parsed.questions.length>500)throw Error('Maximum 500 questions.');questions.push(...parsed.questions);renderBank();preview.remove();},preview);});
 const payload=()=>({id:r?.id,data:Object.fromEntries(Object.entries(inputs).map(([k,n])=>[k,n.value])),questions});
 button('SAVE PRIVATE DRAFT',async()=>{if(r)await rpc('training-save',payload());else await rpc('training-create',payload());await trainingRequests();});
 if(r && profile.permissions.includes('training.submit') && (r.request_kind==='new' || profile.permissions.includes('training.edit')))button('SUBMIT FOR OVERSEER REVIEW',async()=>{if(!confirm('Submit draft? Live Training content changes only after Overseer approval.'))return;await rpc('training-submit',payload());await trainingRequests();});
 }
 if(r?.response)content.append(node('p','Overseer response: '+r.response));
 }
 async function adminTrainingRequests() {
 screen('TRAINING REQUESTS',true);const rows=await rpc('admin-training-list'),sets=await request('/rest/v1/rpc/training_catalog',{p_admin:true},window.overseerSession.access_token);
 rows.forEach(r=>{const c=card();c.append(node('h2',r.data.title),node('p',r.employee+' // '+r.request_kind.toUpperCase()+' // '+r.status.toUpperCase()),node('p','Submitted: '+r.submitted_at));
 const source=sets.find(s=>s.id===r.source_id);if(r.request_kind==='edit' && (!source || source.revision!==r.base_revision))c.append(node('p','CONFLICT: source changed/deleted. Approval is blocked; request a new proposal.'));
 const before=node('details');before.append(node('summary','BEFORE — source at draft creation'),node('pre',pretty(r.before_data)));c.append(before);
 const after=node('details');after.append(node('summary','AFTER — proposed metadata and questions'),node('pre',pretty({data:r.data,questions:r.questions})));c.append(after);
 if(r.status==='pending') {const response=field('OVERSEER RESPONSE','','textarea',c);['approved','denied'].forEach(decision=>button(decision.toUpperCase(),async()=>{if(!confirm(decision==='approved'?'Publish this proposal to canonical Training data?':'Deny proposal and leave live Training unchanged?'))return;await rpc('admin-training-review',{id:r.id,decision,response:response.value});await adminTrainingRequests();},c));}else c.append(node('p',r.response));});
 }
 async function documents(eid,admin) {
 screen(admin?'PERSONNEL DOCUMENTS':'MY DOCUMENTS',admin);const rows=await rpc(admin?'admin-documents':'documents',admin?{employee_id:eid}:{});
 if(admin)uploadForm(eid);
 rows.forEach(d=>{const c=card();c.append(node('h3',d.name),node('p',d.status.toUpperCase()+' // '+d.bytes+' bytes // '+d.created_at));
 if(d.status!=='pending')button('VIEW PDF (60-second authorized URL)',async()=>{const w=window.open('about:blank','_blank');try{const r=await edge('document-view',{id:d.id},admin);if(w){w.opener=null;w.location=r.signedUrl;}else{const a=node('a','OPEN AUTHORIZED PDF');a.href=r.signedUrl;a.target='_blank';a.rel='noopener noreferrer';c.append(a);}}catch(e){w?.close();throw e;}},c);
 if(admin){if(d.status==='pending')button('FINISH PENDING UPLOAD',async()=>{await edge('document-finish',{id:d.id},true);await documents(eid,true);},c);
 if(d.status==='active')button('REPLACE (preserve original)',()=>uploadForm(eid,d.id,c),c);
 if(d.status!=='archived')button('ARCHIVE',async()=>{if(confirm('Archive assigned document? Original file remains preserved.')){await rpc('admin-document-archive',{id:d.id});await documents(eid,true);}},c);}
 });
 }
 function uploadForm(eid,replaces=null,parent=content) {
 const file=field(replaces?'REPLACEMENT PDF':'UPLOAD PDF — MAXIMUM 20 MB','','file',parent);file.accept='application/pdf,.pdf';
 button('UPLOAD DOCUMENT',async()=>{const f=file.files[0];if(!f || f.size>20000000 || !/\.pdf$/i.test(f.name) || !(await f.slice(0,5).text()).startsWith('%PDF-'))throw Error('Choose a PDF, maximum 20 MB.');
 const r=await edge('document-upload',{employee_id:eid,name:f.name,bytes:f.size,replaces},true);
 const uploaded=await authClient().storage.from('personnel-paperwork').uploadToSignedUrl(r.path,r.token,f,{contentType:'application/pdf'});if(uploaded.error)throw Error('Storage upload failed. The pending entry can be finished or archived; original files are preserved.');
 await edge('document-finish',{id:r.id},true);await documents(eid,true);},parent);
 }
 async function temporaryAdmin() {
 screen('TEMPORARY LIMITED ACCESS',true);content.append(node('p','Five minutes to redeem once. Read-only directory/announcements snapshot. No employee identity, Training or administration.'));
 button('GENERATE TEMPORARY ACCESS',async()=>{
 const r=await edge('temporary-create',{},true);const c=card();c.append(node('p','CODE — displayed only now'),node('pre',r.code));const countdown=node('p');c.append(countdown);
 clearInterval(temporaryTimer);const tick=()=>{const remain=Math.max(0,Math.ceil((Date.parse(r.expires_at)-Date.now())/1000));countdown.textContent=remain?'EXPIRES IN: '+String(Math.floor(remain/60)).padStart(2,'0')+':'+String(remain%60).padStart(2,'0')+' // USES REMAINING: 1 (refresh status to verify)':'EXPIRED';if(!remain)clearInterval(temporaryTimer);};tick();temporaryTimer=setInterval(tick,1000);
 button('REVOKE',async()=>{await rpc('admin-temp-revoke',{id:r.id});clearInterval(temporaryTimer);countdown.textContent='REVOKED';},c);
 });
 button('REFRESH STATUS',temporaryAdmin);const rows=await rpc('admin-temp-list');rows.forEach(r=>{const c=card();c.append(node('p',r.state+' // '+r.expires_at));if(r.state==='AVAILABLE')button('REVOKE',async()=>{await rpc('admin-temp-revoke',{id:r.id});await temporaryAdmin();},c);});
 }
 function temporaryLogin() {
 screen('TEMPORARY LIMITED ACCESS');root.querySelector('nav').replaceChildren();button('RETURN',openLogin,root.querySelector('nav'));const code=field('ONE-USE CODE');
 button('REDEEM',async()=>{try{const r=await edge('temporary-use',{code:code.value});screen('READ-ONLY DIRECTORY SNAPSHOT');root.querySelector('nav').replaceChildren();button('EXIT',()=>location.reload(),root.querySelector('nav'));content.append(node('p','CODE USED / INVALID. No employee, Training or administration permissions. This snapshot does not persist after refresh.'));
 r.sites.forEach(s=>{const c=card();c.append(node('h2',s.name));if(RobcoDocument.safeURL(s.url)){const a=node('a',s.url);a.href=s.url;a.target='_blank';a.rel='noopener noreferrer';c.append(a);}});r.announcements.forEach(a=>content.append(node('h2',a.title),node('p',a.message)));}finally{code.value='';}});
 }
 // Reuse all existing administrative controls in nested categories and preserve their containers/handlers.
 const originalOverseer=window.showOverseerPanel;
 window.showOverseerPanel=function() {
 originalOverseer();const shell=document.querySelector('#loginScreen .login');shell.classList.add('personnel-shell');const all=[...shell.children],menu=node('div');menu.className='personnel-grid';const output=document.getElementById('overseerOutput');
 const categories={PERSONNEL:[],REQUESTS:[], 'TRAINING ADMINISTRATION':[],'WEBSITE ADMINISTRATION':[],'ACCESS & SECURITY':[],MEDIA:[],SYSTEM:[]};
 all.filter(e=>!['H1','P','HR'].includes(e.tagName) && e!==output).forEach(e=>{
 const handler=e.getAttribute('onclick') || e.querySelector('[onclick]')?.getAttribute('onclick') || '';
 const cat=/openEmployeeDocument/.test(handler)?'PERSONNEL':/showWebsiteRequests/.test(handler)?'REQUESTS':/openTraining/.test(handler)?'TRAINING ADMINISTRATION':/WebsiteManager|Announcement/.test(handler)?'WEBSITE ADMINISTRATION':/GuestCode|AccessCodes|Maintenance/.test(handler)?'ACCESS & SECURITY':/Music/.test(handler)?'MEDIA':'SYSTEM';categories[cat].push(e);e.remove();
 });
 const panes={};Object.entries(categories).forEach(([name,elements])=>{const pane=node('section');pane.hidden=true;pane.append(node('h2',name));elements.forEach(e=>pane.append(e));panes[name]=pane;shell.insertBefore(pane,output);button(name,()=>{Object.values(panes).forEach(p=>p.hidden=true);pane.hidden=false;menu.hidden=true;output.replaceChildren();},menu);});
 shell.insertBefore(menu,shell.querySelector('section'));
 const back=node('button','BACK / RETURN TO OVERSEER TERMINAL');back.onclick=()=>{Object.values(panes).forEach(p=>p.hidden=true);menu.hidden=false;output.replaceChildren();};shell.insertBefore(back,menu);
 button('EMPLOYEE DIRECTORY',directory,panes.PERSONNEL);button('+ ADD EMPLOYEE',addEmployee,panes.PERSONNEL);
 button('TRAINING REQUESTS',adminTrainingRequests,panes.REQUESTS);button('TEMPORARY LIMITED ACCESS',temporaryAdmin,panes['ACCESS & SECURITY']);
 // Replace the request entrypoint so personal/legacy history and reviewer responses are available.
 const websiteButton=panes.REQUESTS.querySelector('[onclick="showWebsiteRequests()"]');if(websiteButton)websiteButton.onclick=adminWebsiteRequests;
 };
 window.Personnel={openLogin,dashboard,directory,addEmployee,adminWebsiteRequests,adminTrainingRequests,temporaryAdmin};
 // Refresh restores only this dedicated employee session; never replaces Training or Overseer Auth.
 if(window.supabase?.createClient) authClient().auth.getSession().then(async r=>{if(r.data.session){try{await dashboard();}catch{await authClient().auth.signOut();}}}).catch(()=>{});
})();
