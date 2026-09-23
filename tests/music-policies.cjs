/* Local PostgreSQL policy tests. npm install --no-save @electric-sql/pglite
   Storage HTTP size/MIME enforcement must also be checked against Supabase. */
const { PGlite } = require('@electric-sql/pglite');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const db = new PGlite();
  const overseer = '11111111-1111-4111-8111-111111111111';
  const member = '22222222-2222-4222-8222-222222222222';
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table public.overseers(user_id uuid primary key references auth.users(id));
    insert into auth.users values ('${overseer}'),('${member}');
    insert into public.overseers values ('${overseer}');
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text,metadata jsonb);
    alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to anon,authenticated;
    grant all on storage.objects to anon,authenticated;
    -- Simulate a dangerously broad pre-existing policy: radio's restrictive
    -- guards must still protect its bucket while leaving other buckets alone.
    create policy unrelated_broad_policy on storage.objects for all to anon,authenticated using(true) with check(true);
  `);
  const migration = fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260923_radio_music.sql'),'utf8');
  await db.exec(migration);
  await db.exec(migration); // Setup can be rerun without destroying songs.
  const sizeMigration = fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260924_radio_500mb.sql'),'utf8');
  await db.exec(sizeMigration);
  await db.exec(sizeMigration);
  assert.equal(Number((await db.query("select file_size_limit from storage.buckets where id='robco-radio'")).rows[0].file_size_limit),500000000);
  async function as(role,uid,sql,args=[]) {
    await db.exec('set role ' + role);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid || '']);
    try { return await db.query(sql,args); } finally { await db.exec('reset role'); }
  }
  const rpc = "select * from public.radio_reserve_track('Song','Artist','Radio','mp3',100,'audio/mpeg')";
  await assert.rejects(as('anon',null,rpc),/permission denied/);
  await assert.rejects(as('authenticated',member,rpc),/Overseer access denied/);
  for (const [name,args] of [['radio_publish_track',`'${member}'`],['radio_edit_track',`'${member}','x','x','x'`],['radio_begin_delete',`'${member}'`],['radio_finish_delete',`'${member}'`]]) {
    await assert.rejects(as('authenticated',member,`select public.${name}(${args})`),/Overseer access denied/);
    await assert.rejects(as('anon',null,`select public.${name}(${args})`),/permission denied/);
  }
  await assert.rejects(as('authenticated',overseer,"select public.radio_reserve_track('x','x','x','exe',100,'audio/mpeg')"),/Unsupported/);
  await assert.rejects(as('authenticated',overseer,"select public.radio_reserve_track('x','x','x','mp3',500000001,'audio/mpeg')"),/check constraint/);
  const large = (await as('authenticated',overseer,"select * from public.radio_reserve_track('Large','Artist','Radio','mp3',500000000,'audio/mpeg')")).rows[0];
  await as('authenticated',overseer,'select public.radio_begin_delete($1)',[large.id]);
  await as('authenticated',overseer,'select public.radio_finish_delete($1)',[large.id]);
  const track = (await as('authenticated',overseer,rpc)).rows[0];
  assert.match(track.storage_path,/^[\da-f-]{36}\.mp3$/);
  assert.equal((await as('anon',null,'select * from public.radio_tracks')).rows.length,0);
  await assert.rejects(as('authenticated',member,'update public.radio_tracks set title=$1 where id=$2',['evil',track.id]),/permission denied/);
  await assert.rejects(as('authenticated',overseer,'delete from public.radio_tracks where id=$1',[track.id]),/permission denied/);
  const upload = "insert into storage.objects(bucket_id,name,metadata) values('robco-radio',$1,'{\"size\":100,\"mimetype\":\"audio/mpeg\"}')";
  await assert.rejects(as('anon',null,upload,[track.storage_path]),/row-level security/);
  await assert.rejects(as('authenticated',member,upload,[track.storage_path]),/row-level security/);
  await assert.rejects(as('authenticated',overseer,upload,['unreserved.mp3']),/row-level security/);
  await assert.rejects(as('authenticated',overseer,'select public.radio_publish_track($1)',[track.id]),/missing or incomplete/);
  await as('authenticated',overseer,upload,[track.storage_path]);
  assert.equal((await as('anon',null,"select * from storage.objects where bucket_id='robco-radio'")).rows.length,0);
  await as('authenticated',overseer,'select public.radio_publish_track($1)',[track.id]);
  assert.equal((await as('anon',null,'select * from public.radio_tracks')).rows.length,1);
  assert.equal((await as('anon',null,"select * from storage.objects where bucket_id='robco-radio'")).rows.length,1);
  assert.equal((await as('authenticated',member,"delete from storage.objects where name=$1 returning *",[track.storage_path])).rows.length,0);
  assert.equal((await as('authenticated',overseer,"update storage.objects set name='changed.mp3' where name=$1 returning *",[track.storage_path])).rows.length,0);
  assert.equal((await as('authenticated',overseer,"delete from storage.objects where name=$1 returning *",[track.storage_path])).rows.length,0);
  await as('authenticated',overseer,"select public.radio_edit_track($1,'Edited','Artist','New Station')",[track.id]);
  assert.equal((await as('anon',null,'select title,station from public.radio_tracks')).rows[0].station,'NEW STATION');
  await as('authenticated',overseer,'select public.radio_begin_delete($1)',[track.id]);
  assert.equal((await as('anon',null,'select * from public.radio_tracks')).rows.length,0);
  assert.equal((await as('anon',null,"select * from storage.objects where bucket_id='robco-radio'")).rows.length,0);
  await assert.rejects(as('authenticated',overseer,'select public.radio_finish_delete($1)',[track.id]),/still exists/);
  await assert.rejects(as('authenticated',overseer,'select public.radio_publish_track($1)',[track.id]),/unavailable/);
  // Emulate the Storage service deleting its object metadata after binary removal.
  assert.equal((await as('authenticated',overseer,'delete from storage.objects where name=$1 returning *',[track.storage_path])).rows.length,1);
  await as('authenticated',overseer,'select public.radio_finish_delete($1)',[track.id]);
  assert.equal((await db.query('select * from public.radio_tracks')).rows.length,0);
  await as('authenticated',overseer,'select public.radio_finish_delete($1)',[track.id]);
  // The guard must not change another bucket's access policy.
  await as('anon',null,"insert into storage.objects(bucket_id,name) values('other','unchanged')");
  assert.equal((await as('anon',null,"select * from storage.objects where bucket_id='other'")).rows.length,1);
  // Revoking membership immediately revokes RPC and Storage write authorization.
  await db.query('delete from public.overseers where user_id=$1',[overseer]);
  await assert.rejects(as('authenticated',overseer,rpc),/Overseer access denied/);
  console.log('PASS: migration/re-run, grants, RLS, anon/non-Overseer denial, restrictive Storage guards, validation, publication, edit, two-stage deletion, idempotent cleanup, membership revocation.');
  await db.close();
})().catch(error => { console.error(error); process.exitCode=1; });
