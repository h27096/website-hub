-- Overseer-only privacy preview configuration. Disabled until explicitly enabled.
begin;
create table if not exists public.privacy_preview_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false
);
insert into public.privacy_preview_settings (id, enabled) values (true, false) on conflict do nothing;
create table if not exists public.privacy_preview_destinations (
  hostname text primary key check (length(hostname) between 4 and 253 and hostname ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$')
);
alter table public.privacy_preview_settings enable row level security;
alter table public.privacy_preview_destinations enable row level security;
revoke all on public.privacy_preview_settings, public.privacy_preview_destinations from public, anon, authenticated;
create or replace function public.privacy_preview_config()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (select 1 from public.overseers where user_id = auth.uid()) then
    raise exception 'Overseer access denied';
  end if;
  return jsonb_build_object(
    'enabled', (select enabled from public.privacy_preview_settings where id = true),
    'hosts', (select coalesce(jsonb_agg(hostname order by hostname), '[]'::jsonb) from public.privacy_preview_destinations)
  );
end $$;
create or replace function public.privacy_preview_set_enabled(new_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (select 1 from public.overseers where user_id = auth.uid()) then
    raise exception 'Overseer access denied';
  end if;
  update public.privacy_preview_settings set enabled = new_enabled where id = true;
end $$;
create or replace function public.privacy_preview_set_destination(new_hostname text, new_approved boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare host text := lower(trim(new_hostname));
begin
  if auth.uid() is null or not exists (select 1 from public.overseers where user_id = auth.uid()) then
    raise exception 'Overseer access denied';
  end if;
  if host !~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' or length(host) > 253 then
    raise exception 'Enter a hostname, without scheme or path';
  end if;
  if new_approved then
    insert into public.privacy_preview_destinations (hostname) values (host) on conflict do nothing;
  else
    delete from public.privacy_preview_destinations where hostname = host;
  end if;
end $$;
revoke all on function public.privacy_preview_config(), public.privacy_preview_set_enabled(boolean), public.privacy_preview_set_destination(text,boolean) from public;
grant execute on function public.privacy_preview_config(), public.privacy_preview_set_enabled(boolean), public.privacy_preview_set_destination(text,boolean) to authenticated;
commit;
