'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'test';
process.env.HUB_ORIGIN = 'https://hub.example.com';
const { publicAddress, parseTarget, server } = require('../proxy/server.cjs');
test('blocks local and reserved addresses', () => {
  for (const ip of ['127.0.0.1','10.1.1.1','192.168.1.1','169.254.169.254','100.64.1.1','0.0.0.0','::1','::ffff:127.0.0.1']) assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true);
});
test('all special ranges, IP spellings and credential-bearing URLs fail closed', () => {
  for (const ip of ['172.16.0.1','172.31.255.255','169.254.1.1','192.0.0.1','192.0.2.1','192.88.99.1','198.18.0.1','198.19.1.1','198.51.100.1','203.0.113.1','224.1.1.1','255.255.255.255','::','fc00::1','fe80::1','2002:7f00:1::','2001:4860:4860::8888']) assert.equal(publicAddress(ip),false,ip);
  for (const url of ['https://2130706433','https://0x7f000001','https://127.1','https://[::1]','https://example.com/#fragment','https://example.com/\\evil','https://example.com/\nsecret']) {
    assert.throws(() => parseTarget(url,['example.com','127.0.0.1','[::1]']));
  }
});
test('DNS checks every IPv4 answer and rejects rebinding to an internal address', async () => {
  const dns = require('node:dns').promises, original = dns.lookup;
  const {approvedAddresses} = require('../proxy/server.cjs');
  try {
    dns.lookup = async () => [{address:'93.184.216.34',family:4},{address:'10.0.0.1',family:4}];
    await assert.rejects(approvedAddresses('example.com'),/blocked/);
    dns.lookup = async () => []; await assert.rejects(approvedAddresses('example.com'),/blocked/);
    dns.lookup = async (_,opts) => {assert.equal(opts.family,4);return [{address:'93.184.216.34',family:4}];};
    assert.equal((await approvedAddresses('example.com'))[0].address,'93.184.216.34');
    dns.lookup = async () => [{address:'127.0.0.1',family:4}]; await assert.rejects(approvedAddresses('example.com'),/blocked/);
  } finally {dns.lookup=original;}
});
test('pinned HTTPS request omits credentials and rejects redirects, binary and large pages', async () => {
  const https=require('node:https'), {EventEmitter}=require('node:events');
  const original=https.get, {preview}=require('../proxy/server.cjs');
  let status=200, type='text/html', large=false;
  try {
    https.get=(url,opts,cb) => {
      assert.equal(opts.agent,false);assert.equal(opts.family,4);assert.equal(opts.autoSelectFamily,false);
      assert(!opts.headers.authorization && !opts.headers.cookie);
      opts.lookup('example.com',{},(e,ip,family)=>{assert.equal(ip,'93.184.216.34');assert.equal(family,4);});
      opts.lookup('example.com',{all:true},(e,list)=>assert.deepEqual(list,[{address:'93.184.216.34',family:4}]));
      const req=new EventEmitter();req.destroy=err=>{req.emit('error',err);req.emit('close');};
      process.nextTick(()=>{
        const res=new EventEmitter();res.statusCode=status;res.headers={'content-type':type};res.destroy=()=>{};
        cb(res);res.emit('data',Buffer.from(large?'x'.repeat(256001):'<script>untrusted</script>'));res.emit('end');req.emit('close');
      });return req;
    };
    const run=()=>preview(new URL('https://example.com'),[{address:'93.184.216.34',family:4}]);
    assert.match(await run(),/untrusted/);
    status=302;await assert.rejects(run(),/readable/);
    status=200;type='image/png';await assert.rejects(run(),/readable/);
    type='text/plain';large=true;await assert.rejects(run(),/limit/);
  } finally {https.get=original;}
});
test('direct API calls enforce persisted state, authentication and approval before and after fetch', async () => {
  const nativeFetch=global.fetch, dns=require('node:dns').promises, https=require('node:https'), {EventEmitter}=require('node:events');
  const originalLookup=dns.lookup, originalGet=https.get;
  let enabled=false, valid=true, hosts=['example.com'], fetches=0, disableDuringFetch=false;
  global.fetch=async (url,options) => {
    if (!String(url).startsWith(process.env.SUPABASE_URL)) return nativeFetch(url,options);
    const session=JSON.parse(options.body).p_session;
    assert(session === 'a'.repeat(64) || options.headers.authorization === 'Bearer valid');
    return new Response(JSON.stringify({enabled,hosts}),{status:valid?200:403});
  };
  dns.lookup=async () => [{address:'93.184.216.34',family:4}];
  https.get=(url,opts,cb)=>{
    fetches++;const req=new EventEmitter();req.destroy=()=>{};
    process.nextTick(()=>{const res=new EventEmitter();res.statusCode=200;res.headers={'content-type':'text/plain'};res.destroy=()=>{};cb(res);res.emit('data',Buffer.from('preview'));if(disableDuringFetch) enabled=false;res.emit('end');req.emit('close');});return req;
  };
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(url='https://example.com',session=true)=>nativeFetch(base+'/preview',{method:'POST',headers:{origin:process.env.HUB_ORIGIN,'content-type':'application/json',...(session?{'x-robco-session':'a'.repeat(64)}:{authorization:'Bearer valid'})},body:JSON.stringify({url})});
  try {
    assert.equal((await request()).status,403);assert.equal(fetches,0);
    enabled=true;assert.equal((await request()).status,200);assert.equal(fetches,1);
    assert.equal((await request('https://other.example')).status,400);assert.equal(fetches,1);
    valid=false;assert.equal((await request()).status,400);assert.equal(fetches,1);valid=true;
    assert.equal((await request('https://example.com',false)).status,200);
    enabled=false;assert.equal((await request('https://example.com',false)).status,403);
    enabled=true;disableDuringFetch=true;assert.equal((await request()).status,403);
    disableDuringFetch=false;enabled=true;const result=await request();assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');
  } finally {global.fetch=nativeFetch;dns.lookup=originalLookup;https.get=originalGet;await new Promise(resolve=>server.close(resolve));}
});
test('requires exact approved HTTPS host and no credentials or port', () => {
  const hosts = ['example.com'];
  assert.equal(parseTarget('https://example.com/a', hosts).pathname, '/a');
  for (const url of ['http://example.com','https://sub.example.com','https://example.com.evil.test','https://user:pass@example.com','https://example.com:8443','https://127.0.0.1']) assert.throws(() => parseTarget(url, hosts), url);
});
test('backend denies requests without origin and auth before network access', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base + '/status')).status, 403);
    assert.equal((await fetch(base + '/status', {headers:{origin:process.env.HUB_ORIGIN}})).status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
