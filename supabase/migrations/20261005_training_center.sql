-- v1.3: additive; does not alter existing Hub tables, Auth users or privileges.
begin;
create table public.training_profiles (
 user_id uuid primary key references auth.users(id) on delete cascade,
 callsign text not null check (callsign ~ '^[A-Za-z0-9_-]{3,24}$'),
 joined_at timestamptz not null default now(), disabled boolean not null default false,
 xp integer not null default 0 check(xp>=0), valid_after timestamptz not null default 'epoch'
);
create unique index training_callsign on public.training_profiles(lower(callsign));
create table public.training_sets (
 id uuid primary key default gen_random_uuid(), title text not null check(length(title) between 1 and 120),
 subject text not null check(length(subject) between 1 and 80), unit text not null check(length(unit) between 1 and 80),
 topic text not null default '', description text not null default '', source_url text not null default ''
 check(source_url='' or source_url ~ '^https?://[^[:space:]]+$'),
 archived boolean not null default false, featured boolean not null default false,
 revision integer not null default 1, created_at timestamptz not null default now(),
 check(not(archived and featured)), check(length(description)<=4000 and length(topic)<=120 and length(source_url)<=2048)
);
create unique index training_one_featured on public.training_sets(featured) where featured;
create table public.training_questions (
 id uuid primary key default gen_random_uuid(), set_id uuid not null references public.training_sets on delete cascade,
 kind text not null check(kind in ('term','mc','tf','typed')), prompt text not null check(length(prompt) between 1 and 2000),
 answer text not null check(length(answer) between 1 and 2000), choices jsonb not null default '[]',
 active boolean not null default true, position integer not null default 0,
 check(jsonb_typeof(choices)='array' and jsonb_array_length(choices)<=6)
);
create table public.training_runs (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.training_profiles on delete cascade,
 set_id uuid references public.training_sets on delete cascade, mode text not null check(mode in ('quiz','reactor','terminal','vault','caps')),
 snapshot jsonb not null, started_at timestamptz not null default now(), finished_at timestamptz,
 result jsonb, invalidated boolean not null default false
);
create index training_runs_player on public.training_runs(user_id,started_at);
create table public.training_progress (
 user_id uuid references public.training_profiles on delete cascade, set_id uuid references public.training_sets on delete cascade,
 best_xp integer not null default 0, known uuid[] not null default '{}', practice uuid[] not null default '{}',
 primary key(user_id,set_id)
);
create table public.training_resets (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.training_profiles on delete cascade,
 code_hash text not null, expires_at timestamptz not null, state text not null default 'WAITING FOR USER',
 issued_at timestamptz not null default now(), claimed_at timestamptz, issued_by uuid references auth.users on delete set null,
 check(state in ('WAITING FOR USER','PROCESSING','PASSWORD RESET COMPLETED','RESET REVOKED','RESET FAILED'))
);
create table public.training_limits (key text primary key, window_at timestamptz not null default now(), attempts integer not null default 1);

-- No browser table access, including for Overseers. Narrow RPC projections only.
do $$ declare t text; begin
 foreach t in array array['training_profiles','training_sets','training_questions','training_runs','training_progress','training_resets','training_limits'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
create function public.training_rank(x integer) returns text language sql immutable set search_path='' as $$
 select case when x>=5000 then 'ROBCO SPECIALIST' when x>=2000 then 'SENIOR TECHNICIAN' when x>=750 then 'TECHNICIAN' when x>=200 then 'JUNIOR TECHNICIAN' else 'TRAINEE' end
$$;
create function public.training_require_overseer() returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not exists(select 1 from public.overseers where user_id=auth.uid()) then raise exception 'Overseer access denied' using errcode='42501'; end if;
end $$;
create function public.training_require_player() returns uuid language plpgsql security definer set search_path='' as $$
declare p public.training_profiles; issued timestamptz;
begin
 select * into p from public.training_profiles where user_id=auth.uid() for update;
 issued := to_timestamp(coalesce((nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'iat')::bigint,0));
 if p.user_id is null or p.disabled or issued < p.valid_after then raise exception 'Sign in to an enabled Personnel File again' using errcode='42501'; end if;
 return p.user_id;
end $$;
create function public.training_catalog(p_admin boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if p_admin then perform public.training_require_overseer(); end if;
 return coalesce((select jsonb_agg(to_jsonb(s) order by featured desc,subject,unit,title) from public.training_sets s where p_admin or not archived),'[]');
end $$;
create function public.training_study(p_set uuid,p_admin boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if p_admin then perform public.training_require_overseer(); end if;
 if not exists(select 1 from public.training_sets where id=p_set and (p_admin or not archived)) then raise exception 'Study set unavailable'; end if;
 return coalesce((select jsonb_agg(to_jsonb(q) order by position,id) from public.training_questions q where set_id=p_set and (p_admin or active)),'[]');
end $$;
create function public.training_save_set(p_set uuid,p_data jsonb,p_questions jsonb,p_revision integer default null) returns uuid language plpgsql security definer set search_path='' as $$
declare sid uuid:=coalesce(p_set,gen_random_uuid()); q jsonb; oldrev integer; pos integer:=0; qid uuid; kept uuid[]:='{}';
begin
 perform public.training_require_overseer();
 if jsonb_typeof(p_questions) is distinct from 'array' or jsonb_array_length(p_questions)>500 then raise exception 'Use at most 500 questions'; end if;
 if p_set is not null then
 select revision into oldrev from public.training_sets where id=p_set for update;
 if oldrev is null or oldrev is distinct from p_revision then raise exception 'Study set changed; reopen before saving'; end if;
 end if;
 if coalesce((p_data->>'featured')::boolean,false) then update public.training_sets set featured=false,revision=revision+1 where featured and id<>sid; end if;
 insert into public.training_sets(id,title,subject,unit,topic,description,source_url,archived,featured)
 values(sid,trim(p_data->>'title'),trim(p_data->>'subject'),trim(p_data->>'unit'),coalesce(p_data->>'topic',''),coalesce(p_data->>'description',''),coalesce(p_data->>'source_url',''),coalesce((p_data->>'archived')::boolean,false),coalesce((p_data->>'featured')::boolean,false))
 on conflict(id) do update set title=excluded.title,subject=excluded.subject,unit=excluded.unit,topic=excluded.topic,description=excluded.description,source_url=excluded.source_url,archived=excluded.archived,featured=excluded.featured,revision=public.training_sets.revision+1;
 for q in select value from jsonb_array_elements(p_questions) loop
 if q->>'kind' not in ('term','mc','tf','typed') or q->>'kind' is null then raise exception 'Unknown question type at item %',pos+1; end if;
 if q->>'kind'='mc' and (jsonb_typeof(q->'choices') is distinct from 'array' or jsonb_array_length(q->'choices') not between 2 and 6 or not (q->'choices' @> jsonb_build_array(q->>'answer')) or (select count(distinct value) from jsonb_array_elements_text(q->'choices'))<>jsonb_array_length(q->'choices')) then raise exception 'Multiple choice needs 2–6 distinct options including the answer at item %',pos+1; end if;
 if exists(select 1 from jsonb_array_elements(coalesce(q->'choices','[]')) c where jsonb_typeof(c)<>'string' or length(c#>>'{}') not between 1 and 2000) then raise exception 'Invalid choices'; end if;
 if q->>'kind'='tf' and q->>'answer' not in ('True','False') then raise exception 'True/False answer must be True or False'; end if;
 if q->>'id' is not null and exists(select 1 from public.training_questions where id=(q->>'id')::uuid and set_id<>sid) then raise exception 'Question belongs to another set'; end if;
 qid:=coalesce((q->>'id')::uuid,gen_random_uuid());
 if qid=any(kept) then raise exception 'Duplicate question identifier'; end if;
 kept:=array_append(kept,qid);
 insert into public.training_questions(id,set_id,kind,prompt,answer,choices,active,position)
 values(qid,sid,q->>'kind',trim(q->>'prompt'),trim(q->>'answer'),coalesce(q->'choices','[]'),coalesce((q->>'active')::boolean,true),pos)
 on conflict(id) do update set kind=excluded.kind,prompt=excluded.prompt,answer=excluded.answer,choices=excluded.choices,active=excluded.active,position=excluded.position;
 pos:=pos+1;
 end loop;
 -- Removed editor rows are deleted; existing runs retain their immutable snapshot.
 delete from public.training_questions where set_id=sid and not(id=any(kept));
 return sid;
end $$;
create function public.training_delete_set(p_set uuid,p_confirmation text) returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.training_require_overseer();
 if p_confirmation is distinct from 'DELETE STUDY SET' then raise exception 'Confirmation required'; end if;
 delete from public.training_sets where id=p_set;
 update public.training_profiles p set xp=coalesce((select sum(best_xp) from public.training_progress where user_id=p.user_id),0);
end $$;
create function public.training_statistics(p_user uuid) returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(x),'[]') from (
 select r.set_id,s.title,r.mode,count(*) as runs,sum((result->>'correct')::integer) as correct,
 sum((result->>'answered')::integer) as answered,max((result->>'score')::integer) as high_score,
 (array_agg(r.id order by (result->>'score')::integer desc,r.finished_at desc))[1] as best_run
 from public.training_runs r join public.training_sets s on s.id=r.set_id
 where r.user_id=p_user and r.finished_at is not null and not r.invalidated
 group by r.set_id,s.title,r.mode order by s.title,r.mode) x
$$;
create function public.training_profile() returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=public.training_require_player(); result jsonb;
begin
 select jsonb_build_object('callsign',callsign,'joined_at',joined_at,'xp',xp,'rank',public.training_rank(xp),
 'statistics',public.training_statistics(uid),
 'progress',coalesce((select jsonb_agg(to_jsonb(g)-'user_id') from public.training_progress g where user_id=uid),'[]'),
 'runs',coalesce((select jsonb_agg(to_jsonb(r)-'snapshot'-'user_id') from (select * from public.training_runs where user_id=uid and finished_at is not null order by finished_at desc limit 100) r),'[]')) into result from public.training_profiles where user_id=uid;
 return result;
end $$;
create function public.training_flash_progress(p_set uuid,p_known uuid[],p_practice uuid[]) returns void language plpgsql security definer set search_path='' as $$
declare uid uuid:=public.training_require_player();
begin
 if cardinality(p_known)>500 or cardinality(p_practice)>500 or p_known && p_practice or exists(select 1 from unnest(p_known||p_practice) x where not exists(select 1 from public.training_questions where id=x and set_id=p_set and active)) then raise exception 'Invalid flashcard progress'; end if;
 insert into public.training_progress(user_id,set_id,known,practice) values(uid,p_set,p_known,p_practice) on conflict(user_id,set_id) do update set known=excluded.known,practice=excluded.practice;
end $$;
create function public.training_start(p_set uuid,p_mode text) returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=public.training_require_player(); qs jsonb; rid uuid;
begin
 if (select count(*) from public.training_runs where user_id=uid and started_at>now()-interval '1 hour')>=60 then raise exception 'Training session limit; try later'; end if;
 perform public.training_study(p_set);
 select jsonb_agg(to_jsonb(q)) into qs from (select * from public.training_questions where set_id=p_set and active order by random() limit 20) q;
 if qs is null then raise exception 'This set has no active questions'; end if;
 insert into public.training_runs(user_id,set_id,mode,snapshot) values(uid,p_set,p_mode,qs) returning id into rid;
 return jsonb_build_object('id',rid,'questions',qs,'mode',p_mode);
end $$;
create function public.training_finish(p_run uuid,p_answers jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=public.training_require_player(); r public.training_runs; q jsonb; a jsonb; n integer; idx integer:=0; correct integer:=0; streak integer:=0; score integer:=0; energy integer:=0; hull integer:=100; shield integer:=0; defense integer:=0; utility integer:=0; xp_award integer; total integer; good boolean; action text; computed jsonb;
begin
 select * into r from public.training_runs where id=p_run and user_id=uid for update;
 if r.id is null then raise exception 'Run not found'; end if;
 if r.finished_at is not null then raise exception 'Run already submitted'; end if;
 if r.started_at<now()-interval '4 hours' then raise exception 'Run expired'; end if;
 n:=jsonb_array_length(r.snapshot);
 if jsonb_typeof(p_answers) is distinct from 'array' or jsonb_array_length(p_answers)>n or jsonb_array_length(p_answers)=0 then raise exception 'Invalid answer count'; end if;
 for a in select value from jsonb_array_elements(p_answers) loop
 q:=r.snapshot->idx; action:=coalesce(a->>'action','');
 if (a-'answer'-'action')<>'{}'::jsonb or jsonb_typeof(a->'answer') is distinct from 'string' or length(a->>'answer')>2000 then raise exception 'Malformed answer'; end if;
 if hull<=0 then raise exception 'Run already ended'; end if;
 if action<>'' then
 if r.mode='vault' and action in ('repair','shield','defense') and energy>=3 then
 energy:=energy-3;
 if action='repair' then hull:=least(100,hull+25); elsif action='shield' then shield:=shield+20; else defense:=defense+3; end if;
 elsif r.mode='terminal' and action in ('skip','eliminate') and utility>0 then utility:=utility-1;
 elsif r.mode='caps' and action in ('left','right') then null;
 else raise exception 'Invalid or unaffordable action'; end if;
 end if;
 good:=lower(trim(a->>'answer'))=lower(trim(q->>'answer')) and action<>'skip';
 if good then correct:=correct+1; streak:=streak+1; else streak:=0; end if;
 if r.mode='quiz' then if good then score:=score+100; end if;
 elsif r.mode='reactor' then if good then score:=score+100+least(streak,5)*10; hull:=least(100,hull+5); else hull:=hull-25; end if;
 elsif r.mode='terminal' then if good then score:=score+120; if streak%3=0 then utility:=least(3,utility+1); end if; elsif action<>'skip' then hull:=hull-20; end if;
 elsif r.mode='vault' then
 if good then energy:=energy+2; score:=score+100; end if;
 if (idx+1)%3=0 then total:=greatest(0,15+((idx+1)/3)*5-defense-shield); shield:=0; hull:=hull-total; if hull>0 then score:=score+50; end if; end if;
 elsif r.mode='caps' then if good then score:=score+50*least(streak,4)+case when (idx%2=0 and action='left') or (idx%2=1 and action='right') then 20 else 0 end; else hull:=hull-20; end if;
 end if;
 idx:=idx+1;
 end loop;
 if idx<n and hull>0 then raise exception 'Complete the run before submitting'; end if;
 xp_award:=floor(100.0*correct/n)::integer+case when idx=n then 25 else 0 end;
 insert into public.training_progress(user_id,set_id,best_xp) values(uid,r.set_id,xp_award)
 on conflict(user_id,set_id) do update set best_xp=greatest(public.training_progress.best_xp,excluded.best_xp);
 update public.training_profiles set xp=(select coalesce(sum(best_xp),0) from public.training_progress where user_id=uid) where user_id=uid;
 computed:=jsonb_build_object('score',score,'correct',correct,'incorrect',idx-correct,'questions',n,'answered',idx,'accuracy',round(100.0*correct/idx),'completed',idx=n,'performance_xp',xp_award);
 update public.training_runs set result=computed,finished_at=now() where id=p_run;
 return computed;
end $$;
create function public.training_leaderboard(p_set uuid default null,p_mode text default null) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if p_set is null then return coalesce((select jsonb_agg(x) from (select callsign,xp as score,public.training_rank(xp) as rank from public.training_profiles where not disabled order by xp desc,callsign limit 50)x),'[]'); end if;
 return coalesce((select jsonb_agg(x) from (select p.callsign,max((r.result->>'score')::integer) as score,public.training_rank(p.xp) as rank from public.training_runs r join public.training_profiles p on p.user_id=r.user_id where r.set_id=p_set and r.mode=p_mode and not r.invalidated and not p.disabled and r.finished_at is not null group by p.user_id order by score desc,p.callsign limit 50)x),'[]');
end $$;
create function public.training_personnel(p_search text default '') returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.training_require_overseer();
 return coalesce((select jsonb_agg(x) from (select user_id,callsign,joined_at,disabled,xp,public.training_rank(xp) as rank,public.training_statistics(p.user_id) as statistics,
 (select jsonb_build_object('id',z.id,'state',case when z.state='WAITING FOR USER' and z.expires_at<now() then 'RESET EXPIRED' else z.state end,'expires_at',z.expires_at) from public.training_resets z where z.user_id=p.user_id order by issued_at desc limit 1) as reset,
 coalesce((select jsonb_agg(to_jsonb(r)-'snapshot'-'user_id') from (select * from public.training_runs where user_id=p.user_id and finished_at is not null order by finished_at desc limit 100)r),'[]') as runs
 from public.training_profiles p where callsign ilike '%'||left(p_search,24)||'%' order by callsign limit 50)x),'[]');
end $$;
create function public.training_personnel_runs(p_user uuid,p_offset integer default 0) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.training_require_overseer();
 if p_offset<0 then raise exception 'Invalid offset'; end if;
 return coalesce((select jsonb_agg(to_jsonb(x)-'snapshot'-'user_id') from (select * from public.training_runs where user_id=p_user and finished_at is not null order by finished_at desc,id limit 100 offset p_offset)x),'[]');
end $$;
create function public.training_moderate(p_user uuid,p_action text,p_value text default '') returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.training_require_overseer();
 if p_action='disable' then update public.training_profiles set disabled=true,valid_after=clock_timestamp() where user_id=p_user;
 elsif p_action='enable' then update public.training_profiles set disabled=false where user_id=p_user;
 elsif p_action='callsign' then update public.training_profiles set callsign=p_value where user_id=p_user;
 elsif p_action='revoke' then update public.training_resets set state='RESET REVOKED' where user_id=p_user and state='WAITING FOR USER';
 elsif p_action='invalidate' then
 update public.training_runs set invalidated=true where id=p_value::uuid and user_id=p_user;
 update public.training_progress g set best_xp=coalesce((select max((result->>'performance_xp')::integer) from public.training_runs where user_id=p_user and set_id=g.set_id and not invalidated),0) where user_id=p_user;
 update public.training_profiles set xp=(select coalesce(sum(best_xp),0) from public.training_progress where user_id=p_user) where user_id=p_user;
 else raise exception 'Unknown moderation action'; end if;
end $$;
-- Edge-only operations. Random code generation and SHA-256 hashing occur in Web Crypto.
create function public.training_issue_reset(p_user uuid,p_hash text,p_actor uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare rid uuid;
begin
 if not exists(select 1 from public.overseers where user_id=p_actor) then raise exception 'Overseer access denied'; end if;
 perform 1 from public.training_profiles where user_id=p_user for update;
 -- Do not race an in-flight Auth password update with a second reset. A crashed
 -- worker can be recovered by issuing another code after five minutes.
 if exists(select 1 from public.training_resets where user_id=p_user and state='PROCESSING' and claimed_at>now()-interval '5 minutes') then raise exception 'Password reset in progress; retry later'; end if;
 update public.training_resets set state='RESET FAILED' where user_id=p_user and state='PROCESSING';
 update public.training_resets set state='RESET REVOKED' where user_id=p_user and state='WAITING FOR USER';
 insert into public.training_resets(user_id,code_hash,expires_at,issued_by) values(p_user,p_hash,now()+interval '45 minutes',p_actor) returning id into rid;
 return rid;
end $$;
create function public.training_claim_reset(p_callsign text,p_hash text) returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid; rid uuid;
begin
 select user_id into uid from public.training_profiles where lower(callsign)=lower(p_callsign) and not disabled for update;
 select id into rid from public.training_resets where user_id=uid and code_hash=p_hash and state='WAITING FOR USER' and expires_at>now() for update;
 if rid is null then raise exception 'Invalid or expired recovery code'; end if;
 update public.training_resets set state='PROCESSING',claimed_at=clock_timestamp() where id=rid;
 update public.training_profiles set valid_after=clock_timestamp() where user_id=uid;
 return uid;
end $$;
create function public.training_rate_limit(p_key text) returns boolean language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 delete from public.training_limits where window_at<now()-interval '1 day';
 insert into public.training_limits(key) values(p_key) on conflict(key) do update set
 attempts=case when public.training_limits.window_at<now()-interval '15 minutes' then 1 else public.training_limits.attempts+1 end,
 window_at=case when public.training_limits.window_at<now()-interval '15 minutes' then now() else public.training_limits.window_at end returning attempts into n;
 return n<=15;
end $$;
-- Deny PUBLIC's default function EXECUTE, including helpers; explicitly grant entrypoints.
do $$ declare f record; begin for f in select oid::regprocedure as sig from pg_proc where pronamespace='public'::regnamespace and proname like 'training_%' loop execute format('revoke all on function %s from public,anon,authenticated',f.sig); end loop; end $$;
grant execute on function public.training_catalog(boolean),public.training_study(uuid,boolean),public.training_leaderboard(uuid,text) to anon,authenticated;
grant execute on function public.training_profile(),public.training_flash_progress(uuid,uuid[],uuid[]),public.training_start(uuid,text),public.training_finish(uuid,jsonb),public.training_personnel(text),public.training_moderate(uuid,text,text),public.training_save_set(uuid,jsonb,jsonb,integer),public.training_delete_set(uuid,text) to authenticated;
grant execute on function public.training_issue_reset(uuid,text,uuid),public.training_claim_reset(text,text),public.training_rate_limit(text) to service_role;
grant execute on function public.training_personnel_runs(uuid,integer) to authenticated;
notify pgrst,'reload schema';
commit;
