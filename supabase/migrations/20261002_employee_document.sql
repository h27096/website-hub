-- Additive migration. Run as postgres in the existing Supabase SQL Editor.
-- Initial private content is supplied separately; NEVER commit employee codes.
begin;

create or replace function public.employee_document_valid_node(n jsonb, depth integer default 0)
returns boolean language plpgsql immutable set search_path = '' as $$
declare kind text; child jsonb;
begin
  if n is null or depth > 16 or jsonb_typeof(n) <> 'object' then return false; end if;
  kind := n->>'type';
  if kind = 'text' then
    return (n - 'type' - 'text') = '{}'::jsonb
      and jsonb_typeof(n->'text') = 'string' and length(n->>'text') <= 100000;
  elsif kind in ('br','logo') then
    return (n - 'type') = '{}'::jsonb;
  elsif kind in ('doc','p','h1','h2','h3','strong','em','u','ul','ol','li','a') then
    if kind = 'a' then
      if (n - 'type' - 'children' - 'href') <> '{}'::jsonb
        or jsonb_typeof(n->'href') is distinct from 'string'
        or length(n->>'href') > 2048
        or not (n->>'href' ~* '^https?://[^[:space:][:cntrl:]]+$')
        or position(chr(92) in n->>'href') > 0 then return false; end if;
    elsif (n - 'type' - 'children') <> '{}'::jsonb then return false;
    end if;
    if jsonb_typeof(n->'children') is distinct from 'array' then return false; end if;
    for child in select value from jsonb_array_elements(n->'children') loop
      if not coalesce(public.employee_document_valid_node(child, depth + 1),false) then return false; end if;
      if child->>'type' = 'doc' then return false; end if;
    end loop;
    return true;
  end if;
  return false;
end;
$$;

create table if not exists public.employee_documents (
  id text primary key check (id = 'employee'),
  content jsonb not null check (
    octet_length(content::text) <= 500000 and content->>'type' = 'doc'
    and coalesce(public.employee_document_valid_node(content), false)
  ),
  revision integer not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
create table if not exists public.employee_document_revisions (
  revision integer primary key,
  content jsonb not null,
  updated_at timestamptz not null,
  updated_by uuid references auth.users(id) on delete set null,
  restored_from integer
);
alter table public.employee_documents enable row level security;
alter table public.employee_document_revisions enable row level security;
-- No direct table grants or permissive policies: access is exclusively via RPC.
revoke all on public.employee_documents, public.employee_document_revisions from public, anon, authenticated;

create or replace function public.employee_document_require_overseer()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.overseers where user_id = auth.uid()
  ) then raise exception 'Overseer access denied' using errcode = '42501'; end if;
end;
$$;

create or replace function public.read_employee_document(employee_password text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if not exists (select 1 from public.overseers where user_id = auth.uid()) then
    if employee_password is null or not coalesce(public.employee_login(employee_password),false) then
      raise exception 'Employee access denied' using errcode = '42501';
    end if;
  end if;
  -- The employee response deliberately omits the editor's Auth user ID.
  select jsonb_build_object('content',d.content,'revision',d.revision,'updated_at',d.updated_at)
    into result from public.employee_documents d where id = 'employee';
  return result;
end;
$$;

create or replace function public.save_employee_document(p_content jsonb, p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.employee_documents;
begin
  perform public.employee_document_require_overseer();
  if p_content is null or octet_length(p_content::text) > 500000
    or p_content->>'type' is distinct from 'doc'
    or not coalesce(public.employee_document_valid_node(p_content),false) then
    raise exception 'Invalid document format';
  end if;
  select * into d from public.employee_documents where id = 'employee' for update;
  if not found then raise exception 'Document not initialized. Run the private seed SQL.'; end if;
  if p_expected_revision is distinct from d.revision then
    raise exception 'Document changed. Reopen the latest version before saving.' using errcode = '40001';
  end if;
  insert into public.employee_document_revisions(revision,content,updated_at,updated_by)
    values(d.revision,d.content,d.updated_at,d.updated_by) on conflict (revision) do nothing;
  update public.employee_documents set content=p_content, revision=d.revision+1,
    updated_at=clock_timestamp(), updated_by=auth.uid() where id='employee' returning * into d;
  insert into public.employee_document_revisions(revision,content,updated_at,updated_by)
    values(d.revision,d.content,d.updated_at,d.updated_by);
  return jsonb_build_object('content',d.content,'revision',d.revision,'updated_at',d.updated_at);
end;
$$;

create or replace function public.list_employee_document_revisions(p_before integer default null)
returns table(revision integer, updated_at timestamptz, updated_by uuid, restored_from integer)
language plpgsql security definer set search_path = '' as $$
begin
  perform public.employee_document_require_overseer();
  return query select r.revision,r.updated_at,r.updated_by,r.restored_from
    from public.employee_document_revisions r
    where p_before is null or r.revision < p_before order by r.revision desc limit 50;
end;
$$;

create or replace function public.read_employee_document_revision(p_revision integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  perform public.employee_document_require_overseer();
  select to_jsonb(r) into result from public.employee_document_revisions r where revision=p_revision;
  if result is null then raise exception 'Revision not found'; end if;
  return result;
end;
$$;

create or replace function public.restore_employee_document_revision(p_revision integer, p_expected_revision integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare previous jsonb; result jsonb;
begin
  perform public.employee_document_require_overseer();
  previous := public.read_employee_document_revision(p_revision);
  result := public.save_employee_document(previous->'content',p_expected_revision);
  update public.employee_document_revisions set restored_from=p_revision
    where revision=(result->>'revision')::integer;
  return result;
end;
$$;

revoke all on function public.employee_document_valid_node(jsonb,integer) from public,anon,authenticated;
revoke all on function public.employee_document_require_overseer() from public,anon,authenticated;
revoke all on function public.read_employee_document(text) from public,anon,authenticated;
revoke all on function public.save_employee_document(jsonb,integer) from public,anon,authenticated;
revoke all on function public.list_employee_document_revisions(integer) from public,anon,authenticated;
revoke all on function public.read_employee_document_revision(integer) from public,anon,authenticated;
revoke all on function public.restore_employee_document_revision(integer,integer) from public,anon,authenticated;
grant execute on function public.read_employee_document(text) to anon,authenticated;
grant execute on function public.save_employee_document(jsonb,integer) to authenticated;
grant execute on function public.list_employee_document_revisions(integer) to authenticated;
grant execute on function public.read_employee_document_revision(integer) to authenticated;
grant execute on function public.restore_employee_document_revision(integer,integer) to authenticated;
notify pgrst, 'reload schema';
commit;
