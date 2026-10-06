const {setup,admin,user,other}=require('./training-db.cjs');
const fs=require('node:fs'),assert=require('node:assert/strict');
const epoch='44444444-4444-4444-8444-444444444444';
async function personnelSetup(){
 const {db}=await setup();
 await db.exec(`create function public.employee_login(text) returns boolean language sql as $$select true$$;
 create table public.published_websites(name text,url text,description text);
 create function public.create_managed_website(text,text,text) returns void language sql as $$insert into public.published_websites values($1,$2,$3)$$;
 create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);alter table storage.objects enable row level security;
 grant usage on schema storage to anon,authenticated,service_role;grant all on storage.objects to anon,authenticated,service_role;
 create policy old_broad_policy on storage.objects for all to authenticated using(true) with check(true);`);
 for(const file of ['20260921_employee_website_requests.sql','20261002_employee_document.sql','20261006_personnel.sql']) await db.exec(fs.readFileSync(__dirname+'/../supabase/migrations/'+file,'utf8'));
 const p=(await db.query("insert into public.personnel(user_id,callsign,title,permissions,auth_epoch) values($1,'Aarav','Password Manager',$2,$3),($4,'Other','Employee',$2,$3) returning id,user_id",[user,['website.submit','training.submit','training.draft','training.edit','notes','documents'],epoch,other])).rows;
 const eid=p.find(x=>x.user_id===user).id,oid=p.find(x=>x.user_id===other).id;
 await db.exec(`insert into public.website_requests(name,url)values('Legacy','https://legacy.example');insert into public.employee_documents(id,content)values('employee','{"type":"doc","children":[]}');`);
 async function as(role,uid,action,data={},tokenEpoch=epoch){
 await db.exec('set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[uid || '',JSON.stringify({iat:Math.floor(Date.now()/1000)+5,app_metadata:{robco_personnel_epoch:tokenEpoch}})]);
 try{return (await db.query('select public.personnel_action($1,$2) as result',[action,JSON.stringify(data)])).rows[0].result;}finally{await db.exec('reset role');}}
 async function fn(role,uid,name,args=[]){await db.exec('set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid || '']);try{return(await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;}finally{await db.exec('reset role');}}
 return{db,as,fn,eid,oid};
}
module.exports={personnelSetup,admin,user,other,epoch};
if(require.main===module)(async()=>{
 const {db,as,fn,eid,oid}=await personnelSetup();let count=0;
 const check=()=>count++;
 const denied=async(p)=>{await assert.rejects(p);check();};
 try{
 const selection=(await db.query('select public.personnel_selection() as r')).rows[0].r;assert.equal(selection.length,2);assert.deepEqual(Object.keys(selection[0]).sort(),['callsign','id','title']);check();
 const self=await as('authenticated',user,'profile',{employee_id:oid});assert.equal(self.id,eid);assert.equal(self.auth_epoch,undefined);check();
 await denied(as('anon',null,'profile'));await denied(as('authenticated',user,'admin-directory'));await denied(as('authenticated',user,'profile',{},'bad-epoch'));
 const note=await as('authenticated',user,'save-note',{title:'Idea',body:'Private'});assert.equal((await as('authenticated',other,'notes')).length,0);check();
 await denied(as('authenticated',other,'save-note',{id:note,title:'Hijack',body:'bad'}));await denied(as('authenticated',other,'delete-note',{id:note}));
 await as('authenticated',user,'save-note',{id:note,title:'Edited',body:'Changed'});assert.equal((await as('authenticated',user,'notes'))[0].body,'Changed');check();
 await as('authenticated',admin,'admin-note',{employee_id:eid,body:'Secret',visible:false});await as('authenticated',admin,'admin-note',{employee_id:eid,body:'Visible',visible:true});
 assert.equal((await as('authenticated',user,'profile')).personnel_notes.length,1);assert.equal((await as('authenticated',admin,'admin-profile',{employee_id:eid})).personnel_notes.length,2);check();
 const wr=await as('authenticated',user,'website-submit',{employee_id:oid,name:'Site',url:'https://example.com',description:'Info'});
 assert.equal((await as('authenticated',user,'profile')).website_requests[0].employee_id,eid);assert.equal((await as('authenticated',other,'profile')).website_requests.length,0);check();
 await denied(as('authenticated',user,'admin-website-review',{id:wr,decision:'approved'}));await as('authenticated',admin,'admin-website-review',{id:wr,decision:'approved',response:'Approved!'});
 assert.equal((await as('authenticated',user,'profile')).website_requests[0].response,'Approved!');assert.equal((await db.query('select * from public.published_websites')).rows.length,1);check();
 const meta={title:'Test',subject:'Science',unit:'1',description:'',topic:'',source_url:''};const qs=[{kind:'term',prompt:'Q',answer:'A',choices:[],active:true}];
 const draft=await as('authenticated',user,'training-create',{data:meta,questions:qs});assert.equal((await db.query('select count(*)::int n from public.training_sets')).rows[0].n,0);check();
 assert.equal((await as('authenticated',admin,'admin-training-list')).length,0);assert.equal((await as('authenticated',other,'training-list')).length,0);check();
 await denied(as('authenticated',other,'training-save',{id:draft,data:meta,questions:qs}));await as('authenticated',user,'training-save',{id:draft,data:{...meta,title:'New'},questions:qs});
 await as('authenticated',user,'training-submit',{id:draft});await denied(as('authenticated',user,'admin-training-review',{id:draft,decision:'approved'}));
 const sid=await as('authenticated',admin,'admin-training-review',{id:draft,decision:'approved',response:'Good'});assert.equal((await db.query('select title from public.training_sets where id=$1',[sid])).rows[0].title,'New');check();
 const edit=await as('authenticated',user,'training-create',{source_id:sid});await as('authenticated',user,'training-submit',{id:edit});await db.query('update public.training_sets set revision=revision+1 where id=$1',[sid]);
 await denied(as('authenticated',admin,'admin-training-review',{id:edit,decision:'approved'}));await as('authenticated',admin,'admin-training-review',{id:edit,decision:'denied',response:'Stale'});assert.equal((await db.query('select title from public.training_sets where id=$1',[sid])).rows[0].title,'New');check();
 const fresh=await as('authenticated',user,'training-create',{source_id:sid});const freshRows=await as('authenticated',user,'training-list');const freshQ=freshRows.find(r=>r.id===fresh).questions;
 await as('authenticated',user,'training-submit',{id:fresh,data:{...meta,title:'Revised'},questions:freshQ});await as('authenticated',admin,'admin-training-review',{id:fresh,decision:'approved'});assert.equal((await db.query('select title from public.training_sets where id=$1',[sid])).rows[0].title,'Revised');check();
 await denied(as('authenticated',user,'training-create',{data:{...meta,featured:true},questions:qs}));await denied(as('authenticated',user,'training-create',{data:meta,questions:[{...qs[0],kind:'mc',choices:['B','C']}]}));
 const doc=await as('authenticated',admin,'admin-document-begin',{employee_id:eid,name:'Form.pdf',bytes:50});await fn('service_role',null,'personnel_finish_document',[admin,doc.id]);
 assert.equal((await as('authenticated',user,'document-path',{id:doc.id})).path,doc.path);await denied(as('authenticated',other,'document-path',{id:doc.id}));await denied(as('authenticated',other,'admin-document-path',{id:doc.id}));
 const replacement=await as('authenticated',admin,'admin-document-begin',{employee_id:eid,name:'New.pdf',bytes:60,replaces:doc.id});await fn('service_role',null,'personnel_finish_document',[admin,replacement.id]);assert.equal((await db.query('select status from public.personnel_documents where id=$1',[doc.id])).rows[0].status,'archived');check();
 await db.exec(`insert into storage.objects(bucket_id,name)values('personnel-paperwork','private.pdf'),('other','ok');set role authenticated;`);assert.equal((await db.query('select * from storage.objects')).rows.length,1);await assert.rejects(db.exec("insert into storage.objects(bucket_id,name)values('personnel-paperwork','bad')"));await db.exec('reset role');check();
 for(const table of ['personnel','personnel_notes','personnel_admin_notes','personnel_documents','personnel_training_requests','personnel_temporary_access']){await db.exec('set role authenticated');await assert.rejects(db.query('select * from public.'+table));await db.exec('reset role');check();}
 await as('authenticated',user,'delete-note',{id:note});assert.equal((await as('authenticated',user,'notes')).length,0);check();
 await as('authenticated',admin,'admin-update',{employee_id:oid,permissions:['training.draft']});
 const privateOnly=await as('authenticated',other,'training-create',{data:meta,questions:qs});await as('authenticated',other,'training-save',{id:privateOnly,data:meta,questions:qs});await denied(as('authenticated',other,'training-submit',{id:privateOnly}));
 await as('authenticated',admin,'admin-update',{employee_id:eid,permissions:[]});await denied(as('authenticated',user,'save-note',{title:'No',body:''}));await denied(as('authenticated',user,'website-submit',{name:'No',url:'https://example.com'}));await denied(as('authenticated',user,'document-path',{id:replacement.id}));assert.equal((await as('authenticated',user,'profile')).documents.length,0);check();
 await denied(as('authenticated',user,'admin-update',{employee_id:eid,permissions:['notes']}));
 const epoch2=await as('authenticated',admin,'admin-invalidate-auth',{employee_id:eid});await denied(as('authenticated',user,'profile'));await denied(as('authenticated',admin,'admin-invalidate-auth',{employee_id:eid}));await as('authenticated',admin,'admin-complete-reset',{employee_id:eid,epoch:epoch2});assert.equal((await as('authenticated',user,'profile',{},epoch2)).website_requests[0].id,wr);check();
 await as('authenticated',admin,'admin-update',{employee_id:eid,status:'inactive'});await denied(as('authenticated',user,'profile',{},epoch2));await as('authenticated',admin,'admin-update',{employee_id:eid,status:'archived'});assert.equal((await as('authenticated',admin,'admin-profile',{employee_id:eid})).website_requests.length,1);check();
 assert.equal((await db.query('select employee_id from public.website_requests where name=$1',['Legacy'])).rows[0].employee_id,null);check();
 const hash='a'.repeat(64);const temp=await fn('service_role',null,'personnel_issue_temporary',[admin,hash]);assert.equal(await fn('service_role',null,'personnel_claim_temporary',[hash]),true);assert.equal(await fn('service_role',null,'personnel_claim_temporary',[hash]),false);check();
 const expired='b'.repeat(64);await fn('service_role',null,'personnel_issue_temporary',[admin,expired]);await db.query("update public.personnel_temporary_access set expires_at=now()-interval '1 second' where code_hash=$1",[expired]);assert.equal(await fn('service_role',null,'personnel_claim_temporary',[expired]),false);check();
 const revoked='c'.repeat(64);const rev=await fn('service_role',null,'personnel_issue_temporary',[admin,revoked]);await as('authenticated',admin,'admin-temp-revoke',{id:rev.id});assert.equal(await fn('service_role',null,'personnel_claim_temporary',[revoked]),false);check();
 await denied(fn('authenticated',user,'personnel_claim_temporary',[hash]));await denied(fn('service_role',null,'personnel_issue_temporary',[user,'d'.repeat(64)]));
 console.log(`personnel DB: ${count} ownership, permissions, workflow, revision, archival, session and Storage assertions passed`);
 }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
