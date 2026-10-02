const {PGlite} = require('@electric-sql/pglite');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const overseer = '11111111-1111-4111-8111-111111111111';
const member = '22222222-2222-4222-8222-222222222222';
const initial = {type:'doc',children:[{type:'logo'},{type:'h2',children:[{type:'text',text:'Employee instructions'}]},{type:'p',children:[{type:'text',text:'Original document.'}]}]};
async function createDB() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table public.overseers(user_id uuid references auth.users(id));
    insert into auth.users values ('${overseer}'),('${member}');
    insert into public.overseers values ('${overseer}');
    create function public.employee_login(employee_password text) returns boolean language sql as $$ select employee_password = 'test-employee' $$;
    create function public.create_managed_website(text,text,text) returns void language sql as $$ select $$;
    grant usage on schema public,auth to anon,authenticated;
    create table public.unrelated_data(value text); insert into public.unrelated_data values ('keep me');`);
  const migration = fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261002_employee_document.sql'),'utf8');
  await db.exec(migration); await db.exec(migration);
  await db.exec(fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260921_employee_website_requests.sql'),'utf8'));
  await db.query("insert into public.employee_documents(id,content) values('employee',$1)",[initial]);
  await db.exec('insert into public.employee_document_revisions(revision,content,updated_at,updated_by) select revision,content,updated_at,updated_by from public.employee_documents');
  // Serialize role changes, just as separate database connections would isolate them.
  let queue = Promise.resolve();
  const as = (role,uid,sql,args=[]) => {
    const task = queue.then(async () => {
      await db.exec('set role '+role);
      await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid || '']);
      try { return await db.query(sql,args); } finally { await db.exec('reset role'); }
    });
    queue = task.catch(() => {}); return task;
  };
  return {db,as,migration};
}
module.exports = {createDB,overseer,member,initial};
if (require.main === module) (async () => {
  const {db,as,migration} = await createDB();
  try {
    const saved = async (role,uid,content,rev) => (await as(role,uid,'select public.save_employee_document($1,$2) as doc',[content,rev])).rows[0].doc;
    assert.equal((await as('anon',null,"select public.read_employee_document('test-employee') as doc")).rows[0].doc.revision,1);
    assert.equal((await as('authenticated',overseer,'select public.read_employee_document() as doc')).rows[0].doc.revision,1);
    await assert.rejects(as('anon',null,"select public.read_employee_document('bad')"),/Employee access denied/);
    await assert.rejects(as('authenticated',member,'select public.read_employee_document()'),/Employee access denied/);
    for (const [role,uid] of [['anon',null],['authenticated',member],['authenticated',overseer]]) {
      for (const table of ['employee_documents','employee_document_revisions']) {
        await assert.rejects(as(role,uid,`select * from public.${table}`),/permission denied/);
        await assert.rejects(as(role,uid,`delete from public.${table}`),/permission denied/);
        await assert.rejects(as(role,uid,`update public.${table} set content='{}'`),/permission denied/);
      }
    }
    for (const [role,uid] of [['anon',null],['authenticated',member]]) {
      await assert.rejects(saved(role,uid,initial,1),/permission denied|Overseer access denied/);
      for (const call of ['list_employee_document_revisions()','read_employee_document_revision(1)','restore_employee_document_revision(1,1)']) {
        await assert.rejects(as(role,uid,'select public.'+call),/permission denied|Overseer access denied/);
      }
    }
    for (const node of [
      {type:'script',children:[]}, {type:'p',children:[],onclick:'alert(1)'},
      {type:'a',href:'javascript:alert(1)',children:[]}, {type:'a',href:'data:text/html,x',children:[]},
      {type:'a',href:'https://safe.test\nattack',children:[]}, {type:'a',href:'https://safe.test\\evil',children:[]},
      {type:'text'}, {type:'logo',src:'https://tracker.test'}, {type:'p',children:[{type:'doc',children:[]}]}]) {
      await assert.rejects(saved('authenticated',overseer,{type:'doc',children:[node]},1),/Invalid document/);
    }
    const updated = {type:'doc',children:[{type:'p',children:[{type:'text',text:'Saved across devices <script>alert(1)</script>'}]}]};
    assert.equal((await saved('authenticated',overseer,updated,1)).revision,2);
    await assert.rejects(saved('authenticated',overseer,initial,1),/Document changed/);
    assert.deepEqual((await as('anon',null,"select public.read_employee_document('test-employee') as doc")).rows[0].doc.content,updated);
    const revisions = (await as('authenticated',overseer,'select * from public.list_employee_document_revisions()')).rows;
    assert.deepEqual(revisions.map(r=>r.revision),[2,1]); assert.equal(revisions[0].updated_by,overseer);
    assert.deepEqual((await as('authenticated',overseer,'select public.read_employee_document_revision(1) as doc')).rows[0].doc.content,initial);
    const restored = (await as('authenticated',overseer,'select public.restore_employee_document_revision(1,2) as doc')).rows[0].doc;
    assert.deepEqual(restored.content,initial); assert.equal(restored.revision,3);
    assert.equal((await as('authenticated',overseer,'select * from public.list_employee_document_revisions()')).rows[0].restored_from,1);
    await as('anon',null,"select public.submit_website_request('test-employee','Example','https://example.com','Request preserved')");
    assert.equal((await as('authenticated',overseer,'select * from public.overseer_list_website_requests()')).rows.length,1);
    await db.exec(migration);
    assert.equal((await db.query('select revision from employee_documents')).rows[0].revision,3);
    assert.equal((await db.query('select value from unrelated_data')).rows[0].value,'keep me');
    if (process.env.PRIVATE_DOC_SEED) {
      await db.exec('delete from employee_document_revisions; delete from employee_documents');
      const seed = fs.readFileSync(process.env.PRIVATE_DOC_SEED,'utf8');
      await db.exec(seed); await db.exec(seed);
      assert.equal((await db.query('select count(*)::int as n from employee_documents')).rows[0].n,1);
      assert.equal((await db.query('select count(*)::int as n from employee_document_revisions')).rows[0].n,1);
    }
    console.log('PASS: employee reads, Overseer writes, RLS/grants, malicious JSON, revisions/restore, stale saves, idempotency, private seed, existing website requests.');
  } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
