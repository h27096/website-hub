/* Read-only diagnostic: GET readiness + OPTIONS, no Auth calls or POST writes. */
const fs = require('node:fs'), path = require('node:path');
const labels = {
  FUNCTION_NOT_DEPLOYED: 'FUNCTION NOT DEPLOYED',
  CORS_PREFLIGHT_FAILED: 'CORS PREFLIGHT FAILED',
  FUNCTION_UNREACHABLE: 'FUNCTION UNREACHABLE',
  AUTHORIZATION_FAILED: 'AUTHORIZATION FAILED',
  BACKEND_CONFIGURATION: 'BACKEND CONFIGURATION FAILED',
  READY: 'READY',
};
async function check({url, origin, fetchImpl = fetch}) {
  const records = [];
  for (const method of ['GET','OPTIONS']) {
    try {
      const headers = {Origin: origin};
      if (method === 'OPTIONS') Object.assign(headers, {
        'Access-Control-Request-Method':'POST',
        'Access-Control-Request-Headers':'apikey,content-type,authorization',
      });
      const r = await fetchImpl(url, {method, headers, credentials:'omit', signal:AbortSignal.timeout(10000)});
      const raw = await r.text();
      let body = {}; try {body = JSON.parse(raw);} catch {}
      records.push({method, status:r.status, code:/^[A-Za-z0-9_-]{1,64}$/.test(body.code||'') ? body.code : null,
        ready:body.ready === true, cors: {
          origin:r.headers.get('access-control-allow-origin'),
          methods:r.headers.get('access-control-allow-methods'),
          headers:r.headers.get('access-control-allow-headers'),
        }});
    } catch {records.push({method, status:null, transport_error:true});}
  }
  const [get, options] = records;
  const list = s => (s||'').toLowerCase().split(',').map(x=>x.trim());
  let result;
  if (records.some(r=>r.status === 404 && r.code === 'NOT_FOUND')) result='FUNCTION_NOT_DEPLOYED';
  else if (records.some(r=>r.code === 'ORIGIN_NOT_CONFIGURED')) result='CORS_PREFLIGHT_FAILED';
  else if (records.some(r=>[401,403].includes(r.status))) result='AUTHORIZATION_FAILED';
  else if (records.some(r=>r.transport_error)) result='FUNCTION_UNREACHABLE';
  else if (records.some(r=>r.code === 'BACKEND_CONFIGURATION')) result='BACKEND_CONFIGURATION';
  else if (options.status < 200 || options.status > 299 || !['*',origin].includes(options.cors.origin)
    || !list(options.cors.methods).includes('post') || !['apikey','content-type','authorization'].every(h=>list(options.cors.headers).includes(h))
    || !['*',origin].includes(get.cors.origin)) result='CORS_PREFLIGHT_FAILED';
  else if (get.status !== 200 || !get.ready) result='BACKEND_CONFIGURATION';
  else result='READY';
  return {url, origin, result, label:labels[result], requests:records};
}
module.exports = {check};
if (require.main === module) {
  const root = path.resolve(__dirname,'..'), html = fs.readFileSync(path.join(root,'index.html'),'utf8');
  const base = html.match(/const SUPABASE_URL\s*=\s*"([^"]+)"/)?.[1];
  const argv = process.argv.slice(2), pos = argv.indexOf('--origin');
  const origin = pos < 0 ? 'https://' + fs.readFileSync(path.join(root,'CNAME'),'utf8').trim() : argv[pos+1];
  try {
    if (!base || !origin || new URL(origin).origin !== origin) throw Error('Supply --origin with scheme and host only, no trailing slash/path.');
    check({url:base+'/functions/v1/training-auth',origin}).then(report=>{
      console.log(JSON.stringify(report,null,2)); process.exitCode=report.result==='READY' ? 0 : 1;
    }).catch(()=>{console.error('FUNCTION UNREACHABLE: diagnostic could not complete.');process.exitCode=1;});
  } catch(e) {console.error(e.message);process.exitCode=1;}
}
