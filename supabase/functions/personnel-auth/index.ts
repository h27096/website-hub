import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const url = Deno.env.get('SUPABASE_URL')!;
const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const publicKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const mode = Deno.env.get('PERSONNEL_CORS_MODE') || 'public';
const origins = (Deno.env.get('PERSONNEL_ALLOWED_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean);
const hash = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');
const checked = (r: any) => { if(r.error) throw Error('Backend operation failed. Check deployment and account configuration.'); return r.data; };
const passwordOK = (p: unknown) => typeof p==='string' && p.length>=12 && p.length<=128;

Deno.serve(async (req) => {
 const origin=req.headers.get('origin') || '';
 const configured=['public','restricted'].includes(mode) && (mode!=='restricted' || origins.length>0);
 const allowed=configured && (mode==='public' || !origin || origins.includes(origin));
 const headers={'Access-Control-Allow-Origin':mode==='public' || req.method==='GET'?'*':allowed?origin:'',
 'Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info',
 'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Content-Type':'application/json','Cache-Control':'no-store',Vary:'Origin'};
 const reply=(data: unknown,status=200)=>new Response(JSON.stringify(data),{status,headers});
 if(!configured) return reply({error:'Invalid personnel CORS configuration.'},503);
 if(!allowed) return reply({error:'Origin is not allowed. Update PERSONNEL_ALLOWED_ORIGINS.'},403);
 if(req.method==='OPTIONS') return new Response(null,{status:204,headers});
 if(!url || !service || !publicKey) return reply({error:'Personnel backend environment incomplete.'},503);
 if(req.method==='GET') return reply({ready:true,function:'personnel-auth',cors:mode});
 if(req.method!=='POST') return reply({error:'POST required'},405);
 const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
 const login=createClient(url,publicKey,{auth:{persistSession:false,autoRefreshToken:false}});
 try {
 const raw=await req.text(); if(raw.length>16384) return reply({error:'Request too large'},413);
 const b=JSON.parse(raw);
 const ip=req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
 if(!checked(await admin.rpc('personnel_rate_limit',{p_key:await hash('personnel-ip:'+ip),p_max:120})) ||
 !checked(await admin.rpc('personnel_rate_limit',{p_key:await hash('personnel-target:'+String(b.employee_id || b.action)),p_max:['login','temporary-use'].includes(b.action)?15:60}))) return reply({error:'Too many attempts; wait 15 minutes.'},429);
 if(b.action==='login') {
 if(!passwordOK(b.password)) return reply({error:'Invalid employee or password.'},400);
 const p=checked(await admin.from('personnel').select('user_id,status,auth_epoch').eq('id',b.employee_id).maybeSingle());
 if(!p || p.status!=='active') return reply({error:'Invalid employee or password, or login disabled.'},403);
 const u=checked(await admin.auth.admin.getUserById(p.user_id)).user;
 const signed=await login.auth.signInWithPassword({email:u.email,password:b.password});
 if(signed.error || !signed.data.session) return reply({error:'Invalid employee or password.'},403);
 // Status/epoch are checked again by the JWT-backed RPC; a concurrent reset/disable fails closed.
 const userClient=createClient(url,publicKey,{global:{headers:{Authorization:'Bearer '+signed.data.session.access_token}},auth:{persistSession:false,autoRefreshToken:false}});
 const valid=await userClient.rpc('personnel_action',{p_action:'profile',p_data:{}});
 if(valid.error) return reply({error:'Employee login disabled or credentials need an Overseer reset.'},403);
 return reply({session:signed.data.session});
 }
 if(b.action==='temporary-use') {
 if(typeof b.code!=='string' || !/^[a-f0-9]{64}$/i.test(b.code.trim())) return reply({error:'Invalid, used, revoked or expired code.'},403);
 if(!checked(await admin.rpc('personnel_claim_temporary',{p_hash:await hash(b.code.trim().toLowerCase())}))) return reply({error:'Invalid, used, revoked or expired code.'},403);
 // One snapshot, no JWT/account or further capabilities. Read through public projections only.
 return reply({scope:'READ_ONLY_DIRECTORY_SNAPSHOT',sites:checked(await login.rpc('get_enabled_managed_websites')),announcements:checked(await login.rpc('get_visible_announcements'))});
 }
 const jwt=(req.headers.get('authorization') || '').replace(/^Bearer /i,'');
 const auth=await admin.auth.getUser(jwt);
 if(auth.error || !auth.data.user) return reply({error:'Authentication required'},403);
 const actor=auth.data.user;
 const userClient=createClient(url,publicKey,{global:{headers:{Authorization:'Bearer '+jwt}},auth:{persistSession:false,autoRefreshToken:false}});
 if(b.action==='document-view') {
 // RPC authorizes the owner and permission or actual Overseer before returning any path.
 const isAdmin=checked(await admin.from('overseers').select('user_id').eq('user_id',actor.id).maybeSingle());
 const d=checked(await userClient.rpc('personnel_action',{p_action:isAdmin?'admin-document-path':'document-path',p_data:{id:b.id}}));
 if(d.status==='pending') return reply({error:'Upload is not complete.'},400);
 return reply(checked(await admin.storage.from('personnel-paperwork').createSignedUrl(d.path,60)));
 }
 const overseer=checked(await admin.from('overseers').select('user_id').eq('user_id',actor.id).maybeSingle());
 if(!overseer) return reply({error:'Overseer access denied'},403);
 if(b.action==='create') {
 if(!passwordOK(b.password) || typeof b.callsign!=='string' || b.callsign.trim().length<1 || b.callsign.length>80 || !Array.isArray(b.permissions) || b.permissions.some((x: unknown)=>typeof x!=='string' || !/^[a-z][a-z0-9.]{0,63}$/.test(x))) return reply({error:'Use a name, valid permissions and a 12–128 character password.'},400);
 const epoch=crypto.randomUUID();
 const u=checked(await admin.auth.admin.createUser({email:crypto.randomUUID()+'@personnel.invalid',password:b.password,email_confirm:true,app_metadata:{robco_personnel_epoch:epoch}})).user;
 const created=await admin.from('personnel').insert({user_id:u.id,callsign:b.callsign.trim(),title:b.title || '',permissions:b.permissions,join_date:b.join_date || new Date().toISOString().slice(0,10),auth_epoch:epoch}).select('id').single();
 if(created.error) {
 const cleanup=await admin.auth.admin.deleteUser(u.id);
 return reply({error:cleanup.error?'Employee creation failed and Auth cleanup failed. Ask the operator to remove the unlinked personnel.invalid identity before retrying.':'Employee creation failed; callsign may already exist or fields may be invalid.'},400);
 }
 return reply({id:created.data.id});
 }
 if(b.action==='reset-password') {
 if(!passwordOK(b.password)) return reply({error:'Use a 12–128 character password.'},400);
 const p=checked(await admin.from('personnel').select('user_id').eq('id',b.employee_id).single());
 const epoch=checked(await userClient.rpc('personnel_action',{p_action:'admin-invalidate-auth',p_data:{employee_id:b.employee_id}}));
 checked(await admin.auth.admin.updateUserById(p.user_id,{password:b.password,app_metadata:{robco_personnel_epoch:epoch}}));
 checked(await userClient.rpc('personnel_action',{p_action:'admin-complete-reset',p_data:{employee_id:b.employee_id,epoch}}));
 return reply({message:'Password reset. Existing employee sessions are invalid.'});
 }
 if(b.action==='temporary-create') {
 const code=[...crypto.getRandomValues(new Uint8Array(32))].map(n=>n.toString(16).padStart(2,'0')).join('');
 const info=checked(await admin.rpc('personnel_issue_temporary',{p_actor:actor.id,p_hash:await hash(code)}));
 return reply({...info,code});
 }
 if(b.action==='document-upload') {
 if(!Number.isInteger(b.bytes) || b.bytes<1 || b.bytes>20000000 || typeof b.name!=='string' || !/\.pdf$/i.test(b.name) || b.name.length>180) return reply({error:'PDF only, maximum 20 MB.'},400);
 const d=checked(await userClient.rpc('personnel_action',{p_action:'admin-document-begin',p_data:{employee_id:b.employee_id,name:b.name,bytes:b.bytes,replaces:b.replaces || null}}));
 // Unique immutable object path. No upsert, replacement always preserves original.
 const token=checked(await admin.storage.from('personnel-paperwork').createSignedUploadUrl(d.path,{upsert:false}));
 return reply({id:d.id,path:d.path,token:token.token});
 }
 if(b.action==='document-finish') {
 const d=checked(await userClient.rpc('personnel_action',{p_action:'admin-document-path',p_data:{id:b.id}}));
 if(d.status!=='pending') return reply({error:'No pending upload'},400);
 const blob=checked(await admin.storage.from('personnel-paperwork').download(d.path));
 if(blob.size!==d.bytes || blob.size>20000000 || blob.type!=='application/pdf' || !(await blob.slice(0,5).text()).startsWith('%PDF-')) return reply({error:'Stored file is missing or invalid. Original document remains unchanged.'},400);
 checked(await admin.rpc('personnel_finish_document',{p_actor:actor.id,p_id:d.id}));
 return reply({message:'PDF assigned.'});
 }
 return reply({error:'Unknown personnel operation'},400);
 } catch { return reply({error:'Personnel operation failed. Verify migration, function deployment, permissions and Storage configuration; retry if a service is unavailable.'},400); }
});
