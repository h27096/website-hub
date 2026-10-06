/* Execute the real Edge handler + real SQL. Auth and Storage transport are local fixtures. */
const {personnelSetup,admin,user,other,epoch}=require('./personnel-db.cjs');
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {stripTypeScriptTypes}=require('node:module');
(async()=>{
 const {db,as,fn,eid,oid}=await personnelSetup();let handler;
 const users=new Map([[admin,{id:admin,email:'admin@test.invalid',app_metadata:{}}],[user,{id:user,email:'user@test.invalid',app_metadata:{robco_personnel_epoch:epoch}}],[other,{id:other,email:'other@test.invalid',app_metadata:{robco_personnel_epoch:epoch}}]]);
 const passwords=new Map([[user,'old-password-123'],[other,'other-password-123']]),sessions=new Map([['admin-jwt',{uid:admin,epoch:null}],['user-jwt',{uid:user,epoch}],['other-jwt',{uid:other,epoch}]]);
 const objects=new Map(),controls={failReset:false,failInsert:false,failCleanup:false};let signedViews=0;
 function from(table){let data,filters=[],cols='*',single=false;const b={select(c='*'){cols=c;return b},insert(d){data=d;return b},eq(k,v){filters.push([k,v]);return b},single(){single=true;return b},maybeSingle(){single=true;return b},then(resolve,reject){return(async()=>{try{if(data&&controls.failInsert)throw Error('insert failed');const values=[];let sql;if(data){const keys=Object.keys(data);values.push(...Object.values(data));sql=`insert into public.${table}(${keys})values(${keys.map((_,i)=>'$'+(i+1))}) returning ${cols}`;}else{sql=`select ${cols} from public.${table}`;if(filters.length)sql+=' where '+filters.map(([k,v])=>{values.push(v);return k+'=$'+values.length}).join(' and ');}const rows=(await db.query(sql,values)).rows;return{data:single?rows[0]||null:rows,error:null};}catch(error){return{data:null,error};}})().then(resolve,reject)}};return b;}
 const auth={getUser:async jwt=>({data:{user:users.get(sessions.get(jwt)?.uid)},error:sessions.has(jwt)?null:Error('Unauthorized')}),admin:{
 getUserById:async uid=>({data:{user:users.get(uid)},error:null}),
 createUser:async d=>{const id=crypto.randomUUID();const u={id,email:d.email,app_metadata:d.app_metadata};users.set(id,u);passwords.set(id,d.password);await db.query('insert into auth.users(id)values($1)',[id]);return{data:{user:u},error:null}},
 deleteUser:async uid=>{if(controls.failCleanup)return{error:Error('cleanup failed')};users.delete(uid);passwords.delete(uid);await db.query('delete from auth.users where id=$1',[uid]);return{error:null}},
 updateUserById:async(uid,d)=>{if(controls.failReset)return{error:Error('Reset failed')};Object.assign(users.get(uid),{app_metadata:d.app_metadata});passwords.set(uid,d.password);return{data:{user:users.get(uid)},error:null}}},
 signInWithPassword:async d=>{const u=[...users.values()].find(u=>u.email===d.email);if(!u||passwords.get(u.id)!==d.password)return{data:{session:null},error:Error('Wrong password')};const jwt=crypto.randomUUID();sessions.set(jwt,{uid:u.id,epoch:u.app_metadata.robco_personnel_epoch});return{data:{session:{access_token:jwt,refresh_token:'refresh',user:u}},error:null}}};
 function createClient(url,key,options={}){const jwt=options.global?.headers.Authorization?.replace('Bearer ','');return{auth,from,rpc:async(name,args={})=>{try{let data;if(name==='personnel_action'){const s=sessions.get(jwt);data=await as('authenticated',s?.uid,name==='personnel_action'?args.p_action:name,args.p_data,s?.epoch);}else if(['get_enabled_managed_websites','get_visible_announcements'].includes(name))data=[];else data=await fn('service_role',null,name,Object.values(args));return{data,error:null};}catch(error){return{data:null,error};}},storage:{from:()=>({createSignedUploadUrl:async path=>({data:{token:'signed-upload-'+path},error:null}),createSignedUrl:async path=>{signedViews++;return{data:{signedUrl:'https://storage.test/'+path+'?signed=60s'},error:null}},download:async path=>({data:objects.get(path),error:objects.has(path)?null:Error('Missing object')})})}};}
 const source=fs.readFileSync(__dirname+'/../supabase/functions/personnel-auth/index.ts','utf8').replace(/^import .*;\n/,'');
 const env={SUPABASE_URL:'https://fixture.test',SUPABASE_SERVICE_ROLE_KEY:'service-secret',SUPABASE_ANON_KEY:'public-key'};
 vm.runInNewContext(stripTypeScriptTypes(source),{createClient,Deno:{env:{get:k=>env[k]},serve:fn=>handler=fn},crypto:crypto.webcrypto,TextEncoder,Response,URL,Date,Blob});
 async function call(body,jwt=''){await db.exec('delete from public.training_limits');const res=await handler(new Request('https://fixture.test',{method:'POST',headers:{origin:'https://hub.test',authorization:'Bearer '+jwt,'Content-Type':'application/json'},body:JSON.stringify(body)}));return{status:res.status,body:await res.json()};}
 try{
 assert.equal((await handler(new Request('https://fixture.test'))).status,200);assert.equal((await handler(new Request('https://fixture.test',{method:'OPTIONS',headers:{origin:'https://hub.test'}}))).status,204);
 assert.equal((await call({action:'create',callsign:'Hacker',password:'valid-password-123',permissions:[]},'user-jwt')).status,403);
 const created=await call({action:'create',callsign:'New Person',title:'Technician',password:'initial-password-123',permissions:['notes','documents','website.submit'],join_date:'2026-10-06'},'admin-jwt');assert.equal(created.status,200);
 const id=created.body.id;
 assert.equal((await call({action:'login',employee_id:id,password:'wrong-password-123'})).status,403);
 const login=await call({action:'login',employee_id:id,password:'initial-password-123'});assert.equal(login.status,200);const jwt=login.body.session.access_token;
 const before=(await db.query('select * from public.personnel where id=$1',[id])).rows[0];assert.equal(before.callsign,'New Person');assert.equal(Object.keys(before).includes('password'),false);
 assert.equal((await call({action:'reset-password',employee_id:id,password:'new-password-123'},'admin-jwt')).status,200);
 assert.equal((await call({action:'login',employee_id:id,password:'initial-password-123'})).status,403);assert.equal((await call({action:'login',employee_id:id,password:'new-password-123'})).status,200);
 await assert.rejects(as('authenticated',before.user_id,'profile',{},sessions.get(jwt).epoch));
 const upload=await call({action:'document-upload',employee_id:eid,name:'Form.pdf',bytes:10},'admin-jwt');assert.equal(upload.status,200);
 assert.equal((await call({action:'document-finish',id:upload.body.id},'admin-jwt')).status,400);
 objects.set(upload.body.path,new Blob(['bad-content'],{type:'application/pdf'}));assert.equal((await call({action:'document-finish',id:upload.body.id},'admin-jwt')).status,400);
 objects.set(upload.body.path,new Blob(['%PDF-test!'],{type:'application/pdf'}));assert.equal((await call({action:'document-finish',id:upload.body.id},'admin-jwt')).status,200);
 assert.equal((await call({action:'document-view',id:upload.body.id},'other-jwt')).status,400);assert.equal(signedViews,0);
 const view=await call({action:'document-view',id:upload.body.id},'user-jwt');assert.equal(view.status,200);assert.match(view.body.signedUrl,/signed=60s/);assert.equal(signedViews,1);
 assert.equal((await call({action:'document-upload',employee_id:eid,name:'bad.html',bytes:100},'admin-jwt')).status,400);
 assert.equal((await call({action:'document-upload',employee_id:eid,name:'Big.pdf',bytes:20000001},'admin-jwt')).status,400);
 const code=await call({action:'temporary-create'},'admin-jwt');assert.equal(code.status,200);assert.equal(code.body.code.length,64);const row=(await db.query('select * from public.personnel_temporary_access where id=$1',[code.body.id])).rows[0];assert.notEqual(row.code_hash,code.body.code);assert.equal(Date.parse(row.expires_at)-Date.parse(row.created_at),300000);
 assert.equal((await call({action:'temporary-use',code:code.body.code})).status,200);assert.equal((await call({action:'temporary-use',code:code.body.code})).status,403);
 assert.equal((await call({action:'document-view',id:upload.body.id},code.body.code)).status,403);
 const code2=await call({action:'temporary-create'},'admin-jwt');await as('authenticated',admin,'admin-temp-revoke',{id:code2.body.id});assert.equal((await call({action:'temporary-use',code:code2.body.code})).status,403);
 const code3=await call({action:'temporary-create'},'admin-jwt');await db.query("update public.personnel_temporary_access set expires_at=now()-interval '1 second' where id=$1",[code3.body.id]);assert.equal((await call({action:'temporary-use',code:code3.body.code})).status,403);
 controls.failInsert=true;const userCount=users.size;assert.equal((await call({action:'create',callsign:'Fail',password:'new-password-123',permissions:[]},'admin-jwt')).status,400);assert.equal(users.size,userCount);controls.failInsert=false;
 controls.failReset=true;assert.equal((await call({action:'reset-password',employee_id:id,password:'fail-password-123'},'admin-jwt')).status,400);assert.equal((await call({action:'login',employee_id:id,password:'new-password-123'})).status,403);controls.failReset=false;
 env.PERSONNEL_CORS_MODE='restricted';env.PERSONNEL_ALLOWED_ORIGINS='https://allowed.test';vm.runInNewContext(stripTypeScriptTypes(source),{createClient,Deno:{env:{get:k=>env[k]},serve:fn=>handler=fn},crypto:crypto.webcrypto,TextEncoder,Response,URL,Date,Blob});
 assert.equal((await handler(new Request('https://fixture.test',{method:'OPTIONS',headers:{origin:'https://blocked.test'}}))).status,403);
 const failed=await call({action:'create',password:'service-secret'+'x'.repeat(12)});assert(!JSON.stringify(failed).includes('service-secret'));
 console.log('personnel Edge: real handler Auth creation/login/reset, rollback/fail-closed reset, document validation/signing/IDOR, one-use/revoked/expired codes, CORS and secret sanitization passed');
 }finally{await db.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
