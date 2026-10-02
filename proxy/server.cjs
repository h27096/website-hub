'use strict';
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const ORIGIN = process.env.HUB_ORIGIN;
if (!SUPABASE_URL || !SUPABASE_KEY || !ORIGIN || !ORIGIN.startsWith('https://')) {
  throw new Error('Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and HTTPS HUB_ORIGIN');
}
const BASE = new URL(SUPABASE_URL);
if (BASE.protocol !== 'https:') throw new Error('Supabase must use HTTPS');
if (new URL(ORIGIN).origin !== ORIGIN) throw new Error('HUB_ORIGIN must be an exact HTTPS origin');
const port = Number(process.env.PORT || 8787);

function publicAddress(ip) {
  const version = net.isIP(ip);
  if (version === 4) {
    const p = ip.split('.').map(Number);
    return p[0] > 0 && p[0] < 224 && p[0] !== 10 && p[0] !== 127 && p[0] !== 169 &&
      !(p[0] === 172 && p[1] >= 16 && p[1] <= 31) && !(p[0] === 192 && p[1] === 168) &&
      !(p[0] === 100 && p[1] >= 64 && p[1] <= 127) && !(p[0] === 192 && p[1] === 0) &&
      !(p[0] === 198 && (p[1] === 18 || p[1] === 19)) && !(p[0] === 198 && p[1] === 51 && p[2] === 100) &&
      !(p[0] === 203 && p[1] === 0 && p[2] === 113) && !(p[0] === 192 && p[1] === 0 && p[2] === 2) &&
      p[0] !== 0 && !(p[0] === 192 && p[1] === 88);
  }
  // Fail closed for IPv6, including mapped and transition addresses.
  if (version === 6) return false;
  return false;
}
function parseTarget(value, hosts) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\x00-\x1f]/.test(value)) throw new Error('Invalid URL');
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash || net.isIP(u.hostname) || u.hostname.includes(':') || !hosts.includes(u.hostname)) {
    throw new Error('HTTPS destination is not approved');
  }
  return u;
}
async function approvedAddresses(host) {
  let deadline;
  const addresses = await Promise.race([
    dns.lookup(host, { all: true, verbatim: true, family: 4 }),
    new Promise((_, reject) => {deadline = setTimeout(() => reject(new Error('Destination DNS timed out')),5000);})
  ]).finally(() => clearTimeout(deadline));
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('Destination address blocked');
  return addresses;
}
async function config(token, session) {
  const response = await fetch(new URL('/rest/v1/rpc/' + (session ? 'privacy_preview_authorize' : 'privacy_preview_config'), BASE), {
    method: 'POST', headers: { apikey: SUPABASE_KEY, ...(session ? {} : {authorization: 'Bearer ' + token}), 'content-type': 'application/json' },
    body: JSON.stringify(session ? {p_session: session} : {}), redirect: 'error', signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error('Authorization failed. Sign in again, or check database setup and maintenance mode.');
  const value = await response.json();
  if (typeof value.enabled !== 'boolean' || !Array.isArray(value.hosts) || !value.hosts.every(h => typeof h === 'string')) throw new Error('Configuration unavailable');
  return value;
}
async function preview(url, addresses) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    const req = https.get(url, {
      timeout: 8000, headers: { 'user-agent': 'RobCoPrivacyPreview', accept: 'text/html, text/plain;q=0.9', 'accept-encoding': 'identity' },
      lookup: (_host, opts, cb) => opts.all ? cb(null, [addresses[0]]) : cb(null, addresses[0].address, addresses[0].family),
      family: 4, autoSelectFamily: false, agent: false
    }, res => {
      if (res.statusCode !== 200 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') || !/^text\/(html|plain)(;|$)/i.test(res.headers['content-type'] || '')) {
        res.destroy(); reject(new Error('Destination did not return a readable page')); return;
      }
      res.on('data', chunk => { size += chunk.length; if (size > 256000) { res.destroy(); reject(new Error('Page exceeds preview limit')); } else chunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    const deadline = setTimeout(() => req.destroy(new Error('Destination timed out')), 10000);
    req.on('close', () => clearTimeout(deadline));
    req.on('timeout', () => req.destroy(new Error('Destination timed out')));
    req.on('error', reject);
  });
}
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors " + ORIGIN,
    'access-control-allow-origin': ORIGIN, 'vary': 'Origin', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(JSON.stringify(body));
}
// Global concurrency cap stores no client IPs, tokens or browsing history.
let active = 0;
const server = http.createServer({requestTimeout:10000, headersTimeout:10000}, async (req, res) => {
  if (req.headers.origin !== ORIGIN) return send(res, 403, { error: 'Origin denied' });
  if (req.method === 'OPTIONS') {
    res.setHeader('access-control-allow-headers', 'authorization, content-type, x-robco-session');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    return send(res, 204, {});
  }
  const token = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(req.headers.authorization || '')?.[1];
  const session = /^[a-f0-9]{64}$/.test(req.headers['x-robco-session'] || '') ? req.headers['x-robco-session'] : null;
  if (!token && !session) return send(res, 401, { error: 'Hub sign-in required' });
  if (active >= 16) return send(res, 503, {error:'Terminal busy. Try again shortly.'});
  active++;
  try {
    const current = await config(token, session);
    if (req.method === 'GET' && req.url === '/status') return send(res, 200, { enabled: current.enabled, hosts: current.hosts });
    if (req.method !== 'POST' || req.url !== '/preview') return send(res, 404, { error: 'Unknown operation' });
    if (!current.enabled) return send(res, 403, { error: 'Preview disabled by Overseer' });
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 4096) throw new Error('Request too large'); chunks.push(chunk); }
    const url = parseTarget(JSON.parse(Buffer.concat(chunks).toString('utf8')).url, current.hosts);
    const addresses = await approvedAddresses(url.hostname);
    // Recheck immediately before outbound access; never cache the enable switch.
    const latest = await config(token, session);
    if (!latest.enabled) return send(res, 403, {error:'Preview disabled by Overseer'});
    parseTarget(url.href, latest.hosts);
    const content = await preview(url, addresses);
    const final = await config(token, session);
    if (!final.enabled || !final.hosts.includes(url.hostname)) return send(res, 403, {error:'Preview disabled or destination removed by Overseer'});
    return send(res, 200, { content, url: url.href });
  } catch (error) {
    // Avoid logging URLs, tokens, page bodies or request metadata.
    return send(res, 400, { error: error.message });
  } finally { active--; }
});
if (require.main === module) server.listen(port, '127.0.0.1');
module.exports = { publicAddress, parseTarget, approvedAddresses, preview, server };
