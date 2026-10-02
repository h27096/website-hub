-- v1.2 additive upgrade to the recovered privacy-preview model.
-- Apply 20260922_privacy_preview.sql first. Existing state/hosts are preserved.
begin;
create table if not exists public.privacy_preview_sessions (
  token_hash bytea primary key,
  expires_at timestamptz not null
);
alter table public.privacy_preview_sessions enable row level security;
revoke all on public.privacy_preview_sessions from public, anon, authenticated;

-- Public availability is not authority to browse or change settings.
create or replace function public.privacy_preview_status()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select enabled from public.privacy_preview_settings where id), false);
$$;

-- Calls the existing code validator exactly once, preserving its maintenance,
-- expiry and usage rules. Raw access codes are never persisted by this feature.
create or replace function public.privacy_preview_login(input_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb; session_token text;
begin
  result := public.use_access_code(input_code)::jsonb;
  if (result->>'success')::boolean is true then
    session_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    delete from public.privacy_preview_sessions where expires_at < now();
    insert into public.privacy_preview_sessions(token_hash,expires_at)
      values(sha256(convert_to(session_token,'UTF8')), now() + interval '1 hour');
    result := result || jsonb_build_object('preview_token',session_token);
  end if;
  return result;
end;
$$;

create or replace function public.privacy_preview_authorize(p_session text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_session is null or p_session !~ '^[a-f0-9]{64}$' or not exists (
    select 1 from public.privacy_preview_sessions
    where token_hash = sha256(convert_to(p_session,'UTF8')) and expires_at > now()
  ) then raise exception 'Private Terminal session expired. Sign in again.' using errcode='42501'; end if;
  if public.get_maintenance_mode() is distinct from false then
    raise exception 'Hub is in maintenance mode' using errcode='42501';
  end if;
  return jsonb_build_object(
    'enabled', public.privacy_preview_status(),
    'hosts', (select coalesce(jsonb_agg(hostname order by hostname),'[]'::jsonb) from public.privacy_preview_destinations)
  );
end;
$$;
create or replace function public.privacy_preview_logout(p_session text)
returns void language sql security definer set search_path = '' as $$
  delete from public.privacy_preview_sessions where token_hash = sha256(convert_to(p_session,'UTF8'));
$$;

-- Supabase may grant defaults explicitly to both roles: revoke them explicitly.
revoke all on function public.privacy_preview_config(), public.privacy_preview_set_enabled(boolean),
  public.privacy_preview_set_destination(text,boolean) from public, anon, authenticated;
grant execute on function public.privacy_preview_config(), public.privacy_preview_set_enabled(boolean),
  public.privacy_preview_set_destination(text,boolean) to authenticated;
revoke all on function public.privacy_preview_status(), public.privacy_preview_login(text),
  public.privacy_preview_authorize(text), public.privacy_preview_logout(text) from public, anon, authenticated;
grant execute on function public.privacy_preview_status(), public.privacy_preview_login(text),
  public.privacy_preview_authorize(text), public.privacy_preview_logout(text) to anon, authenticated;
commit;
