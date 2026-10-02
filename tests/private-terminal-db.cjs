/* Real local PostgreSQL checks; never connect to production. */
const {PGlite} = require('@electric-sql/pglite');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const admin = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
(async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      create table public.overseers(user_id uuid); insert into public.overseers values ('${admin}');
      create table public.login_calls(code text); create table public.maintenance(enabled boolean); insert into public.maintenance values(false);
      create function public.get_maintenance_mode() returns boolean language sql as $$ select enabled from public.maintenance $$;
      create function public.use_access_code(input_code text) returns jsonb language plpgsql as $$ begin
        insert into public.login_calls values(input_code);
        return jsonb_build_object('success', input_code='valid-code' and not public.get_maintenance_mode()); end $$;
      grant usage on schema public,auth to anon,authenticated;
      alter default privileges in schema public grant execute on functions to anon,authenticated;
      create table public.existing_data(value text); insert into public.existing_data values('preserve');`);
    const old = fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260922_privacy_preview.sql'),'utf8');
    const upgrade = fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261003_private_terminal.sql'),'utf8');
    await db.exec(old); await db.exec(upgrade);
    async function as(role, uid, sql, params=[]) {
      await db.exec('set role '+role); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid || '']);
      try {return (await db.query(sql,params)).rows;} finally {await db.exec('reset role');}
    }
    const status = () => as('anon',null,'select public.privacy_preview_status() as enabled');
    assert.equal((await status())[0].enabled,false);
    for (const [role,id] of [['anon',null],['authenticated',user]]) {
      for (const sql of ['select public.privacy_preview_set_enabled(true)',"select public.privacy_preview_set_destination('example.com',true)",
        'update public.privacy_preview_settings set enabled=true','select * from public.privacy_preview_sessions','select public.privacy_preview_config()']) {
        await assert.rejects(as(role,id,sql));
      }
    }
    await as('authenticated',admin,'select public.privacy_preview_set_enabled(true)');
    await as('authenticated',admin,"select public.privacy_preview_set_destination('example.com',true)");
    assert.equal((await status())[0].enabled,true);
    // Reapplying either migration must preserve existing enabled state and destinations.
    await db.exec(old); await db.exec(upgrade);
    assert.equal((await status())[0].enabled,true);
    const config = (await as('authenticated',admin,'select public.privacy_preview_config() as result'))[0].result;
    assert.deepEqual(config.hosts,['example.com']);
    assert.equal((await db.query('select * from public.existing_data')).rows[0].value,'preserve');
    const denied = (await as('anon',null,"select public.privacy_preview_login('invalid') as result"))[0].result;
    assert.equal(denied.success,false); assert(!denied.preview_token);
    const login = (await as('anon',null,"select public.privacy_preview_login('valid-code') as result"))[0].result;
    assert.match(login.preview_token,/^[a-f0-9]{64}$/);
    assert.equal((await db.query("select count(*)::int as n from public.login_calls where code='valid-code'")).rows[0].n,1);
    const authorize = () => as('anon',null,'select public.privacy_preview_authorize($1) as result',[login.preview_token]);
    assert.equal((await authorize())[0].result.enabled,true);
    await assert.rejects(as('anon',null,'select public.privacy_preview_authorize($1)', ['0'.repeat(64)]));
    await as('authenticated',admin,'select public.privacy_preview_set_enabled(false)');
    assert.equal((await authorize())[0].result.enabled,false);
    await as('authenticated',admin,'select public.privacy_preview_set_enabled(true)');
    assert.equal((await authorize())[0].result.enabled,true);
    await db.exec('update public.maintenance set enabled=true'); await assert.rejects(authorize());
    await db.exec('update public.maintenance set enabled=false');
    await as('anon',null,'select public.privacy_preview_logout($1)',[login.preview_token]); await assert.rejects(authorize());
    const second = (await as('anon',null,"select public.privacy_preview_login('valid-code') as result"))[0].result;
    await db.exec("update public.privacy_preview_sessions set expires_at=now()-interval '1 second'");
    await assert.rejects(as('anon',null,'select public.privacy_preview_authorize($1)',[second.preview_token]));
    console.log('PASS: Overseer JWT permissions, anon/employee/user denial, persistence, safe migrations, single code consumption, session expiry/revocation, maintenance and disable/re-enable.');
  } finally {await db.close();}
})().catch(e => {console.error(e);process.exitCode=1;});
