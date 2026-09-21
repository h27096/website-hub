-- Apply in the Supabase SQL Editor before deploying the v0.2 frontend.
-- Existing employee_login and create_managed_website RPCs remain intact.
begin;

create table if not exists public.website_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  url text not null check (char_length(url) between 8 and 2048 and url ~* '^https?://[^[:space:]]+$'),
  description text not null default '' check (char_length(description) <= 2000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id)
);
create index if not exists website_requests_pending_idx on public.website_requests (created_at) where status = 'pending';
alter table public.website_requests enable row level security;
revoke all on public.website_requests from public, anon, authenticated;

create or replace function public.submit_website_request(
  employee_password text, website_name text, website_url text, website_description text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  if not coalesce(public.employee_login(employee_password), false) then
    raise exception 'Employee access denied';
  end if;
  insert into public.website_requests (name, url, description)
  values (trim(website_name), trim(website_url), coalesce(trim(website_description), ''))
  returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.overseer_list_website_requests()
returns setof public.website_requests language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.overseers where user_id = auth.uid()) then
    raise exception 'Overseer access denied';
  end if;
  return query select r.* from public.website_requests r where r.status = 'pending' order by r.created_at;
end;
$$;

create or replace function public.overseer_review_website_request(request_id uuid, decision text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare r public.website_requests%rowtype;
begin
  if not exists (select 1 from public.overseers where user_id = auth.uid()) then
    raise exception 'Overseer access denied';
  end if;
  if decision not in ('approved', 'rejected') then
    raise exception 'Invalid decision';
  end if;
  select * into r from public.website_requests where id = request_id and status = 'pending' for update;
  if not found then raise exception 'Request is already reviewed or missing'; end if;
  if decision = 'approved' then
    perform public.create_managed_website(r.name, r.url, r.description);
  end if;
  update public.website_requests
    set status = decision, reviewed_at = now(), reviewed_by = auth.uid()
    where id = request_id;
  return true;
end;
$$;

revoke all on function public.submit_website_request(text,text,text,text) from public;
revoke all on function public.overseer_list_website_requests() from public;
revoke all on function public.overseer_review_website_request(uuid,text) from public;
grant execute on function public.submit_website_request(text,text,text,text) to anon, authenticated;
grant execute on function public.overseer_list_website_requests() to authenticated;
grant execute on function public.overseer_review_website_request(uuid,text) to authenticated;

-- Disable every overload of the old employee direct-publish endpoint. Do not
-- drop it: historical database objects may still depend on its definition.
do $$ declare old_rpc record; begin
  for old_rpc in
    select p.oid::regprocedure as signature from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'employee_add_website'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', old_rpc.signature);
  end loop;
end $$;
commit;
