-- v1.4 additive personnel network. Apply AFTER the v1.3 Training migration.
begin;
create table public.personnel (
 id uuid primary key default gen_random_uuid(), user_id uuid unique not null references auth.users(id),
 callsign text not null check(length(trim(callsign)) between 1 and 80), title text not null default '' check(length(title)<=120),
 status text not null default 'active' check(status in ('active','inactive','archived')),
 permissions text[] not null default '{}', join_date date not null default current_date,
 created_at timestamptz not null default now(), reset_started_at timestamptz, auth_epoch uuid not null default gen_random_uuid(),
 check(cardinality(permissions)<=50)
);
create unique index personnel_callsign on public.personnel(lower(callsign));
create table public.personnel_notes (
 id uuid primary key default gen_random_uuid(), employee_id uuid not null references public.personnel(id),
 title text not null check(length(title) between 1 and 120), body text not null default '' check(length(body)<=20000),
 updated_at timestamptz not null default now()
);
create table public.personnel_admin_notes (
 id uuid primary key default gen_random_uuid(), employee_id uuid not null references public.personnel(id),
 body text not null check(length(body) between 1 and 20000), visible boolean not null default false,
 created_at timestamptz not null default now(), actor uuid not null references auth.users(id)
);
create table public.personnel_events (
 id uuid primary key default gen_random_uuid(), employee_id uuid not null references public.personnel(id),
 event text not null, created_at timestamptz not null default now(), actor uuid references auth.users(id)
);
create table public.personnel_documents (
 id uuid primary key default gen_random_uuid(), employee_id uuid not null references public.personnel(id),
 name text not null check(length(name) between 1 and 180), path text not null unique,
 bytes integer not null check(bytes between 1 and 20000000), status text not null default 'pending' check(status in ('pending','active','archived')),
 replaces uuid references public.personnel_documents(id), created_at timestamptz not null default now()
);
create table public.personnel_training_requests (
 id uuid primary key default gen_random_uuid(), employee_id uuid not null references public.personnel(id),
 source_id uuid references public.training_sets(id) on delete set null,
 request_kind text not null check(request_kind in ('new','edit')), base_revision integer, before_data jsonb,
 data jsonb not null, questions jsonb not null,
 status text not null default 'draft' check(status in ('draft','pending','approved','denied')),
 created_at timestamptz not null default now(), submitted_at timestamptz, reviewed_at timestamptz,
 response text not null default '' check(length(response)<=2000), published_id uuid references public.training_sets(id) on delete set null
);
create table public.personnel_temporary_access (
 id uuid primary key default gen_random_uuid(), code_hash text not null unique check(code_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(), expires_at timestamptz not null default(now()+interval '5 minutes'),
 used_at timestamptz, revoked boolean not null default false, actor uuid not null references auth.users(id)
);
alter table public.website_requests add column if not exists employee_id uuid references public.personnel(id);
alter table public.website_requests add column if not exists employee_label text;
alter table public.website_requests add column if not exists response text not null default '' check(length(response)<=2000);
-- Legacy requests are deliberately left NULL/unassigned; a shared password cannot establish authorship.
create index personnel_website_history on public.website_requests(employee_id,created_at);
create index personnel_training_history on public.personnel_training_requests(employee_id,created_at);
create index personnel_note_owner on public.personnel_notes(employee_id);
create index personnel_document_owner on public.personnel_documents(employee_id);
do $$ declare t text; begin
 foreach t in array array['personnel','personnel_notes','personnel_admin_notes','personnel_events','personnel_documents','personnel_training_requests','personnel_temporary_access'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;

create function public.personnel_require(p_permission text default null) returns uuid language plpgsql security definer set search_path='' as $$
declare p public.personnel; claims jsonb:=nullif(current_setting('request.jwt.claims',true),'')::jsonb;
begin
 select * into p from public.personnel where user_id=auth.uid() for share;
 if p.id is null or p.status<>'active' or (claims->'app_metadata'->>'robco_personnel_epoch') is distinct from p.auth_epoch::text then
 raise exception 'Sign in to an active employee record again' using errcode='42501'; end if;
 if p_permission is not null and not(p_permission=any(p.permissions)) then raise exception 'Employee permission required: %',p_permission using errcode='42501'; end if;
 return p.id;
end $$;
create function public.personnel_selection() returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'callsign',callsign,'title',title) order by callsign),'[]') from public.personnel where status='active'
$$;
create function public.personnel_validate_training(p_data jsonb,p_questions jsonb) returns void language plpgsql set search_path='' as $$
declare q jsonb;
begin
 if jsonb_typeof(p_data) is distinct from 'object' or length(trim(p_data->>'title')) not between 1 and 120 or p_data->>'title' is null
 or length(trim(p_data->>'subject')) not between 1 and 80 or p_data->>'subject' is null
 or length(trim(p_data->>'unit')) not between 1 and 80 or p_data->>'unit' is null
 or length(coalesce(p_data->>'description',''))>4000 or length(coalesce(p_data->>'topic',''))>120
 or length(coalesce(p_data->>'source_url',''))>2048 or (coalesce(p_data->>'source_url','')<>'' and p_data->>'source_url' !~ '^https?://[^[:space:]]+$')
 or (p_data-'title'-'subject'-'unit'-'topic'-'description'-'source_url')<>'{}'::jsonb then raise exception 'Invalid study set metadata'; end if;
 if jsonb_typeof(p_questions) is distinct from 'array' or jsonb_array_length(p_questions) not between 1 and 500 then raise exception 'Use 1–500 questions'; end if;
 for q in select value from jsonb_array_elements(p_questions) loop
 if jsonb_typeof(q) is distinct from 'object' or q->>'kind' is null or q->>'kind' not in ('term','mc','tf','typed')
 or q->>'prompt' is null or length(trim(q->>'prompt')) not between 1 and 2000
 or q->>'answer' is null or length(trim(q->>'answer')) not between 1 and 2000
 or jsonb_typeof(q->'choices') is distinct from 'array' or jsonb_array_length(q->'choices')>6
 or (q-'id'-'kind'-'prompt'-'answer'-'choices'-'active'-'position'-'set_id')<>'{}'::jsonb then raise exception 'Invalid question'; end if;
 if exists(select 1 from jsonb_array_elements(q->'choices') c where jsonb_typeof(c)<>'string' or length(c#>>'{}') not between 1 and 2000) then raise exception 'Invalid choices'; end if;
 if q->>'kind'='mc' and (jsonb_array_length(q->'choices') not between 2 and 6 or not(q->'choices' @> jsonb_build_array(q->>'answer')) or (select count(distinct value) from jsonb_array_elements_text(q->'choices'))<>jsonb_array_length(q->'choices')) then raise exception 'Multiple choice requires distinct options including answer'; end if;
 if q->>'kind'='tf' and q->>'answer' not in ('True','False') then raise exception 'True/False answer required'; end if;
 end loop;
end $$;

-- The only browser entrypoint for private personnel/workflow data. No caller-supplied owner is trusted.
create function public.personnel_action(p_action text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare eid uuid; rid uuid; is_admin boolean; result jsonb; n public.personnel_notes;
 r public.personnel_training_requests; d public.personnel_documents; s public.training_sets; target public.personnel;
 meta jsonb; qs jsonb; desired text;
begin
 if octet_length(p_data::text)>2500000 then raise exception 'Request too large'; end if;
 is_admin:=exists(select 1 from public.overseers where user_id=auth.uid());
 if p_action like 'admin-%' then
 perform public.training_require_overseer();
 eid:=nullif(p_data->>'employee_id','')::uuid;
 else eid:=public.personnel_require(); end if;
 if p_action='profile' or p_action='admin-profile' then
 if not exists(select 1 from public.personnel where id=eid) then raise exception 'Employee not found'; end if;
 select (to_jsonb(p)-'user_id'-'auth_epoch'-'reset_started_at')||jsonb_build_object(
 'website_requests',coalesce((select jsonb_agg(to_jsonb(w)-'reviewed_by' order by created_at desc) from public.website_requests w where employee_id=eid),'[]'),
 'training_requests',coalesce((select jsonb_agg(to_jsonb(t)-'questions'-'before_data' order by created_at desc) from public.personnel_training_requests t where employee_id=eid),'[]'),
 'personnel_notes',coalesce((select jsonb_agg(to_jsonb(a)-'actor' order by created_at desc) from public.personnel_admin_notes a where employee_id=eid and (is_admin or visible)),'[]'),
 'documents',coalesce((select jsonb_agg(to_jsonb(x)-'path' order by created_at desc) from public.personnel_documents x where employee_id=eid and (is_admin or (x.status='active' and 'documents'=any(p.permissions)))),'[]'),
 'history',coalesce((select jsonb_agg(to_jsonb(e)-'actor' order by created_at desc) from public.personnel_events e where employee_id=eid),'[]'))
 into result from public.personnel p where id=eid; return result;
 elsif p_action='admin-directory' then
 return coalesce((select jsonb_agg(to_jsonb(p)-'user_id'-'auth_epoch'-'reset_started_at' order by callsign) from public.personnel p where callsign ilike '%'||left(coalesce(p_data->>'search',''),80)||'%' and (coalesce(p_data->>'status','all')='all' or status=p_data->>'status')),'[]');
 elsif p_action='admin-update' then
 select * into target from public.personnel where id=eid for update;
 if target.id is null then raise exception 'Employee not found'; end if;
 update public.personnel set title=coalesce(p_data->>'title',title),status=coalesce(p_data->>'status',status),
 permissions=case when p_data ? 'permissions' then array(select jsonb_array_elements_text(p_data->'permissions')) else permissions end,
 auth_epoch=case when p_data->>'status' in ('inactive','archived') or (p_data->>'status'='active' and target.status<>'active') then gen_random_uuid() else auth_epoch end where id=eid;
 insert into public.personnel_events(employee_id,event,actor) values(eid,'Personnel role/permissions/status updated: '||coalesce(p_data->>'status',target.status),auth.uid());
 return 'true';
 elsif p_action='admin-invalidate-auth' then
 select * into target from public.personnel where id=eid for update;
 if target.reset_started_at>now()-interval '5 minutes' then raise exception 'Password reset in progress; retry after five minutes'; end if;
 update public.personnel set auth_epoch=gen_random_uuid(),reset_started_at=now() where id=eid returning auth_epoch into rid;
 if rid is null then raise exception 'Employee not found'; end if;
 insert into public.personnel_events(employee_id,event,actor) values(eid,'Employee credentials invalidated for password reset / reactivation',auth.uid());
 return to_jsonb(rid);
 elsif p_action='admin-complete-reset' then
 update public.personnel set reset_started_at=null where id=eid and auth_epoch=(p_data->>'epoch')::uuid;
 if not found then raise exception 'Reset changed; retry'; end if; return 'true';
 elsif p_action='admin-note' then
 insert into public.personnel_admin_notes(employee_id,body,visible,actor) values(eid,p_data->>'body',coalesce((p_data->>'visible')::boolean,false),auth.uid()) returning id into rid; return to_jsonb(rid);
 elsif p_action='notes' then
 perform public.personnel_require('notes');
 return coalesce((select jsonb_agg(to_jsonb(x) order by updated_at desc) from public.personnel_notes x where employee_id=eid),'[]');
 elsif p_action='save-note' then
 perform public.personnel_require('notes'); rid:=nullif(p_data->>'id','')::uuid;
 if rid is null then insert into public.personnel_notes(employee_id,title,body) values(eid,p_data->>'title',coalesce(p_data->>'body','')) returning id into rid;
 else update public.personnel_notes set title=p_data->>'title',body=coalesce(p_data->>'body',''),updated_at=now() where id=rid and employee_id=eid;
 if not found then raise exception 'Note unavailable' using errcode='42501'; end if; end if; return to_jsonb(rid);
 elsif p_action='delete-note' then
 perform public.personnel_require('notes'); delete from public.personnel_notes where id=(p_data->>'id')::uuid and employee_id=eid;
 if not found then raise exception 'Note unavailable' using errcode='42501'; end if; return 'true';
 elsif p_action='website-submit' then
 perform public.personnel_require('website.submit');
 insert into public.website_requests(employee_id,employee_label,name,url,description)
 select eid,callsign,trim(p_data->>'name'),trim(p_data->>'url'),coalesce(p_data->>'description','') from public.personnel where id=eid returning id into rid;
 return to_jsonb(rid);
 elsif p_action='admin-website-list' then
 return coalesce((select jsonb_agg(to_jsonb(w)||jsonb_build_object('employee',coalesce(w.employee_label,'LEGACY / UNASSIGNED')) order by created_at desc) from public.website_requests w),'[]');
 elsif p_action='admin-website-review' then
 perform public.overseer_review_website_request((p_data->>'id')::uuid,p_data->>'decision');
 update public.website_requests set response=coalesce(p_data->>'response','') where id=(p_data->>'id')::uuid; return 'true';
 elsif p_action='training-list' or p_action='admin-training-list' then
 return coalesce((select jsonb_agg(to_jsonb(t)||jsonb_build_object('employee',p.callsign) order by t.created_at desc) from public.personnel_training_requests t join public.personnel p on p.id=t.employee_id where (p_action='admin-training-list' and t.status<>'draft') or (p_action='training-list' and t.employee_id=eid)),'[]');
 elsif p_action='training-create' then
 perform public.personnel_require('training.draft');
 rid:=nullif(p_data->>'source_id','')::uuid;
 if rid is not null then
 perform public.personnel_require('training.edit');
 select * into s from public.training_sets where id=rid and not archived;
 if s.id is null then raise exception 'Source set unavailable'; end if;
 meta:=to_jsonb(s)-'id'-'revision'-'created_at'-'archived'-'featured';
 select coalesce(jsonb_agg(to_jsonb(q) order by position,id),'[]') into qs from public.training_questions q where set_id=rid;
 else meta:=p_data->'data'; qs:=p_data->'questions'; end if;
 perform public.personnel_validate_training(meta,qs);
 insert into public.personnel_training_requests(employee_id,source_id,request_kind,base_revision,before_data,data,questions)
 values(eid,rid,case when rid is null then 'new' else 'edit' end,s.revision,case when rid is null then null else jsonb_build_object('data',meta,'questions',qs) end,meta,qs) returning id into rid; return to_jsonb(rid);
 elsif p_action='training-save' or p_action='training-submit' then
 perform public.personnel_require('training.draft');
 select * into r from public.personnel_training_requests where id=(p_data->>'id')::uuid and employee_id=eid and status='draft' for update;
 if r.id is null then raise exception 'Private editable draft unavailable'; end if;
 if r.request_kind='edit' then perform public.personnel_require('training.edit'); end if;
 if p_action='training-submit' then perform public.personnel_require('training.submit'); end if;
 meta:=coalesce(p_data->'data',r.data); qs:=coalesce(p_data->'questions',r.questions);
 perform public.personnel_validate_training(meta,qs);
 update public.personnel_training_requests set data=meta,questions=qs,
 status=case when p_action='training-submit' then 'pending' else 'draft' end,
 submitted_at=case when p_action='training-submit' then now() else null end where id=r.id; return 'true';
 elsif p_action='admin-training-review' then
 select * into r from public.personnel_training_requests where id=(p_data->>'id')::uuid and status='pending' for update;
 if r.id is null then raise exception 'Pending proposal unavailable'; end if;
 desired:=p_data->>'decision';
 if desired not in ('approved','denied') or desired is null then raise exception 'Invalid decision'; end if;
 if desired='approved' then
 perform public.personnel_validate_training(r.data,r.questions);
 if r.request_kind='edit' then
 select * into s from public.training_sets where id=r.source_id for update;
 if s.id is null or s.revision is distinct from r.base_revision then raise exception 'CONFLICT: source set changed or was deleted; review a new proposal' using errcode='40001'; end if;
 end if;
 -- Preserve administrative archived/featured flags; employees cannot propose these controls.
 meta:=r.data||jsonb_build_object('archived',coalesce(s.archived,false),'featured',coalesce(s.featured,false));
 rid:=public.training_save_set(r.source_id,meta,r.questions,r.base_revision);
 end if;
 update public.personnel_training_requests set status=desired,response=coalesce(p_data->>'response',''),reviewed_at=now(),published_id=rid where id=r.id; return to_jsonb(rid);
 elsif p_action='documents' or p_action='admin-documents' then
 if p_action='documents' then perform public.personnel_require('documents'); end if;
 return coalesce((select jsonb_agg(to_jsonb(x)-'path' order by created_at desc) from public.personnel_documents x where employee_id=eid and (is_admin or status='active')),'[]');
 elsif p_action='admin-document-begin' then
 rid:=gen_random_uuid();
 if nullif(p_data->>'replaces','') is not null and not exists(select 1 from public.personnel_documents where id=(p_data->>'replaces')::uuid and employee_id=eid and status='active') then raise exception 'Replacement unavailable'; end if;
 insert into public.personnel_documents(id,employee_id,name,path,bytes,replaces) values(rid,eid,p_data->>'name',eid::text||'/'||rid::text||'.pdf',(p_data->>'bytes')::integer,nullif(p_data->>'replaces','')::uuid) returning * into d; return to_jsonb(d);
 elsif p_action='admin-document-archive' then
 update public.personnel_documents set status='archived' where id=(p_data->>'id')::uuid;
 if not found then raise exception 'Document unavailable'; end if; return 'true';
 elsif p_action='document-path' or p_action='admin-document-path' then
 if p_action='document-path' then perform public.personnel_require('documents'); end if;
 select * into d from public.personnel_documents where id=(p_data->>'id')::uuid and (is_admin or (employee_id=eid and status='active'));
 if d.id is null then raise exception 'Document unavailable' using errcode='42501'; end if;
 return to_jsonb(d);
 elsif p_action='admin-temp-list' then
 return coalesce((select jsonb_agg(jsonb_build_object('id',id,'expires_at',expires_at,'state',case when revoked then 'REVOKED' when used_at is not null then 'USED / INVALID' when expires_at<=now() then 'EXPIRED' else 'AVAILABLE' end) order by created_at desc) from public.personnel_temporary_access),'[]');
 elsif p_action='admin-temp-revoke' then
 update public.personnel_temporary_access set revoked=true where id=(p_data->>'id')::uuid; return 'true';
 elsif p_action='shared-document' then
 return (select jsonb_build_object('content',content,'revision',revision,'updated_at',updated_at) from public.employee_documents where id='employee');
 end if;
 raise exception 'Unknown personnel action';
end $$;

-- Edge-only code operations; caller identity is checked independently of the service JWT.
create function public.personnel_issue_temporary(p_actor uuid,p_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.personnel_temporary_access;
begin
 if not exists(select 1 from public.overseers where user_id=p_actor) then raise exception 'Overseer access denied' using errcode='42501'; end if;
 insert into public.personnel_temporary_access(actor,code_hash) values(p_actor,p_hash) returning * into r;
 return jsonb_build_object('id',r.id,'expires_at',r.expires_at);
end $$;
create function public.personnel_claim_temporary(p_hash text) returns boolean language plpgsql security definer set search_path='' as $$
begin
 update public.personnel_temporary_access set used_at=clock_timestamp() where code_hash=p_hash and used_at is null and not revoked and expires_at>clock_timestamp();
 return found;
end $$;
-- Completion is service-only AFTER actual Storage object size/type/content validation.
create function public.personnel_finish_document(p_actor uuid,p_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare d public.personnel_documents;
begin
 if not exists(select 1 from public.overseers where user_id=p_actor) then raise exception 'Overseer access denied' using errcode='42501'; end if;
 select * into d from public.personnel_documents where id=p_id and status='pending' for update;
 if d.id is null then raise exception 'Pending document unavailable'; end if;
 if d.replaces is not null then
 perform 1 from public.personnel_documents where id=d.replaces and employee_id=d.employee_id and status='active' for update;
 if not found then raise exception 'Replacement changed; original is preserved'; end if;
 update public.personnel_documents set status='archived' where id=d.replaces;
 end if;
 update public.personnel_documents set status='active' where id=d.id;
 insert into public.personnel_events(employee_id,event,actor) values(d.employee_id,'Personnel PDF assigned: '||d.name,p_actor);
end $$;
-- Reuse the existing private limiter store with a separate personnel namespace.
create function public.personnel_rate_limit(p_key text,p_max integer) returns boolean language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 if p_max not between 1 and 120 then raise exception 'Invalid rate limit'; end if;
 delete from public.training_limits where window_at<now()-interval '1 day';
 insert into public.training_limits(key) values(p_key) on conflict(key) do update set
 attempts=case when public.training_limits.window_at<now()-interval '15 minutes' then 1 else public.training_limits.attempts+1 end,
 window_at=case when public.training_limits.window_at<now()-interval '15 minutes' then now() else public.training_limits.window_at end returning attempts into n;
 return n<=p_max;
end $$;
-- Browser access is RPC-only; all helpers deny default PUBLIC EXECUTE.
do $$ declare f record; begin
 for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname like 'personnel_%' loop
 execute format('revoke all on function %s from public,anon,authenticated',f.sig);
 end loop;
end $$;
grant execute on function public.personnel_selection() to anon,authenticated;
grant execute on function public.personnel_action(text,jsonb) to authenticated;
grant execute on function public.personnel_rate_limit(text,integer) to service_role;
grant execute on function public.personnel_issue_temporary(uuid,text),public.personnel_claim_temporary(text),public.personnel_finish_document(uuid,uuid) to service_role;
-- Stop the old unowned submission mechanism; preserve its function/data for audit/compatibility.
revoke execute on function public.submit_website_request(text,text,text,text) from public,anon,authenticated;

-- Private Storage. No object privileges/policies for browser roles; signed tokens are minted by authorized Edge code.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('personnel-paperwork','personnel-paperwork',false,20000000,array['application/pdf'])
on conflict(id) do update set public=false,file_size_limit=20000000,allowed_mime_types=array['application/pdf'];
-- Restrictive guards also deny personnel objects if an installation has broad pre-existing Storage policies.
create policy personnel_storage_read_guard on storage.objects as restrictive for select to anon,authenticated using(bucket_id<>'personnel-paperwork');
create policy personnel_storage_insert_guard on storage.objects as restrictive for insert to anon,authenticated with check(bucket_id<>'personnel-paperwork');
create policy personnel_storage_update_guard on storage.objects as restrictive for update to anon,authenticated using(bucket_id<>'personnel-paperwork') with check(bucket_id<>'personnel-paperwork');
create policy personnel_storage_delete_guard on storage.objects as restrictive for delete to anon,authenticated using(bucket_id<>'personnel-paperwork');
notify pgrst,'reload schema';
commit;
