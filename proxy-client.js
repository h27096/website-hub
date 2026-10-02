/* Extension of the recovered privacy-preview client. No persistent browser data. */
let privacySession = null, privacyController = null, privacyPoll = null, privacyGeneration = 0;
let privacyHistory = [], privacyIndex = -1, privacyAvailable = false;
async function privacyRpc(name, body = {}, manage = false) {
  const token = window.overseerSession?.access_token;
  if (manage && !token) throw new Error('Authenticated Overseer sign-in required.');
  const response = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + name, {
    method:'POST', headers:{apikey:SUPABASE_KEY,'content-type':'application/json',...(manage ? {authorization:'Bearer ' + token} : {})},
    body:JSON.stringify(body),cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('Database request rejected. Check sign-in and apply the Private Terminal migrations.');
  const raw = await response.text(); return raw ? JSON.parse(raw) : null;
}
async function privacyHubLogin(code) {
  const options = {method:'POST',body:JSON.stringify({input_code:code})};
  let response = await databaseRequest('/rest/v1/rpc/privacy_preview_login',options);
  // Missing migration only: never retry a consumed or rejected access code.
  if (response.status === 404) response = await databaseRequest('/rest/v1/rpc/use_access_code',options);
  return response;
}
function privacyBackend() {
  if (!window.ROBCO_PROXY_URL) throw new Error('BACKEND NOT CONFIGURED. An Overseer must deploy the separate HTTPS service.');
  let base; try {base = new URL(window.ROBCO_PROXY_URL);} catch {throw new Error('Invalid backend configuration.');}
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Backend must be an HTTPS origin.');
  return base.origin;
}
async function privacyApi(path, options = {}) {
  const base = privacyBackend(), token = window.overseerSession?.access_token;
  if (!token && !privacySession) throw new Error('Sign in to the Hub again to start a Private Terminal session.');
  let response;
  try {
    response = await fetch(base + path, {
      ...options,headers:{'content-type':'application/json',...(token ? {authorization:'Bearer ' + token} : {'x-robco-session':privacySession})},
      cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',signal:options.signal || AbortSignal.timeout(12000)
    });
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new Error('Backend unreachable or timed out. Check hosting and the allowed Hub origin.');
  }
  let data; try {data = await response.json();} catch {throw new Error('Backend returned an invalid response.');}
  if (!response.ok) throw new Error(data.error || 'Private Terminal request rejected.');
  return data;
}
function privacyStatus(message) {document.getElementById('privacyStatus').textContent = message;}
function privacyControls(busy = false) {
  document.getElementById('privacyGo').disabled = busy || !privacyAvailable;
  document.getElementById('privacyBack').disabled = busy || !privacyAvailable || privacyIndex < 1;
  document.getElementById('privacyForward').disabled = busy || !privacyAvailable || privacyIndex >= privacyHistory.length-1;
  document.getElementById('privacyReload').disabled = busy || !privacyAvailable || privacyIndex < 0;
}
function clearPrivacyContent() {
  privacyController?.abort(); privacyController = null;
  document.getElementById('privacyFrame').srcdoc = '';
}
function stopPrivacyPreview() {
  privacyGeneration++; clearTimeout(privacyPoll); privacyPoll = null; clearPrivacyContent();
  privacyHistory = []; privacyIndex = -1; privacyAvailable = false;
  document.getElementById('privacyUrl').value = ''; privacyControls();
}
function logoutPrivacy() {
  const session = privacySession; privacySession = null; stopPrivacyPreview();
  if (session) privacyRpc('privacy_preview_logout',{p_session:session}).catch(() => {});
}
async function refreshPrivacyHome() {
  const status = document.getElementById('privacyHomeStatus');
  try {
    const enabled = await privacyRpc('privacy_preview_status');
    status.textContent = enabled === true ? (window.ROBCO_PROXY_URL ? 'PRIVATE TERMINAL' : 'PRIVATE TERMINAL // BACKEND NOT CONFIGURED') : 'PRIVATE TERMINAL // OFFLINE BY ORDER OF OVERSEER';
  } catch {status.textContent = 'PRIVATE TERMINAL // CONFIGURATION UNAVAILABLE';}
}
async function refreshPrivacyStatus() {
  const generation = privacyGeneration;
  try {
    const enabled = await privacyRpc('privacy_preview_status');
    if (generation !== privacyGeneration) return;
    if (enabled !== true) throw new Error('OFFLINE BY ORDER OF OVERSEER');
    const config = await privacyApi('/status');
    if (generation !== privacyGeneration) return;
    if (config.enabled !== true) throw new Error('OFFLINE BY ORDER OF OVERSEER');
    privacyAvailable = true;
    if (!privacyController) {privacyStatus('CONNECTED // APPROVED DESTINATIONS ONLY'); privacyControls();}
    document.getElementById('privacyApproved').textContent = 'APPROVED HOSTS: ' + (config.hosts.join(', ') || 'NONE');
  } catch (error) {
    if (generation !== privacyGeneration) return;
    privacyAvailable = false; clearPrivacyContent(); privacyControls(); privacyStatus(error.message);
  } finally {
    if (generation === privacyGeneration && !document.getElementById('privateTerminal').classList.contains('hidden')) privacyPoll = setTimeout(refreshPrivacyStatus,10000);
  }
}
function showPrivacyPreview() {showUserPage('privateTerminal');}
function openPrivacyPage() {
  stopPrivacyPreview(); privacyStatus('CHECKING CONNECTION...');
  document.getElementById('privacyApproved').textContent = ''; refreshPrivacyStatus();
}
function validatePrivacyUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\x00-\x1f]/.test(value)) throw new Error('Enter an approved HTTPS address without spaces.');
  let url; try {url = new URL(value);} catch {throw new Error('Enter a complete HTTPS address.');}
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new Error('Use HTTPS, without credentials, custom ports or fragments.');
  return url.href;
}
async function loadPrivacyPreview(value, index = null) {
  const generation = privacyGeneration;
  clearPrivacyContent();
  let controller;
  try {
    const target = validatePrivacyUrl(value ?? document.getElementById('privacyUrl').value.trim());
    controller = new AbortController(); privacyController = controller; privacyControls(true);
    privacyStatus('LOADING APPROVED PAGE...');
    const result = await privacyApi('/preview',{method:'POST',body:JSON.stringify({url:target}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(25000)])});
    if (generation !== privacyGeneration || privacyController !== controller) return;
    if (typeof result.content !== 'string' || typeof result.url !== 'string') throw new Error('Invalid preview response.');
    const escaped = result.content.replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    document.getElementById('privacyFrame').srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{background:#010401;color:#55ff55;font:14px monospace;white-space:pre-wrap;overflow-wrap:anywhere;padding:14px}</style>${escaped}`;
    if (index === null) {
      privacyHistory = privacyHistory.slice(0,privacyIndex+1); privacyHistory.push(target);
      if (privacyHistory.length > 30) privacyHistory.shift();
      privacyIndex = privacyHistory.length-1;
    } else privacyIndex = index;
    document.getElementById('privacyUrl').value = target;
    privacyAvailable = true; privacyStatus('LOADED // ISOLATED SOURCE TEXT PREVIEW');
  } catch (error) {
    if (generation === privacyGeneration && (!controller || privacyController === controller) && error.name !== 'AbortError') privacyStatus('UNAVAILABLE // ' + error.message);
  } finally {
    if (generation === privacyGeneration && (!controller || privacyController === controller)) {privacyController = null; privacyControls();}
  }
}
function privacyMove(delta) {
  const index = privacyIndex + delta;
  if (index >= 0 && index < privacyHistory.length) loadPrivacyPreview(privacyHistory[index],index);
}
async function showPrivacyControl() {
  const output = document.getElementById('overseerOutput');
  if (!output || !window.overseerSession?.access_token) return;
  output.innerHTML = `<h3>🌐 PRIVATE TERMINAL CONTROL</h3><p id="privacyControlStatus" role="status">CHECKING SAVED STATUS...</p><button id="privacyToggle" disabled>CHECKING...</button><p id="privacyControlHosts"></p><label>APPROVED DESTINATION HOSTNAME<input id="privacyHost" placeholder="example.com" autocomplete="off"></label><button id="privacyApprove">APPROVE HOST</button><button id="privacyRemove">REMOVE HOST</button><p id="privacyControlMessage" role="status"></p>`;
  const panel = document.getElementById('privacyControlStatus'), token = window.overseerSession.access_token;
  const valid = () => panel.isConnected && token === window.overseerSession?.access_token;
  const toggle = document.getElementById('privacyToggle'), message = document.getElementById('privacyControlMessage');
  let enabled = false;
  async function refresh() {
    toggle.disabled = true;
    try {
      const config = await privacyRpc('privacy_preview_config',{},true);
      if (!valid()) return;
      enabled = config.enabled === true;
      panel.textContent = 'PRIVATE TERMINAL STATUS: ' + (enabled ? 'ENABLED' : 'DISABLED');
      document.getElementById('privacyControlHosts').textContent = 'APPROVED HOSTS: ' + (config.hosts.join(', ') || 'NONE');
      toggle.textContent = enabled ? 'DISABLE PRIVATE TERMINAL' : 'ENABLE PRIVATE TERMINAL'; toggle.disabled = false;
    } catch (error) {if (valid()) {panel.textContent = 'STATUS UNAVAILABLE'; message.textContent = error.message;}}
  }
  async function change(name, body) {
    if (!valid()) return;
    toggle.disabled = true; message.textContent = 'SAVING...';
    try {await privacyRpc(name,body,true); if (!valid()) return; message.textContent = 'SAVED IN SUPABASE.'; await refresh(); refreshPrivacyHome();}
    catch (error) {if (valid()) {message.textContent = error.message; await refresh();}}
  }
  toggle.onclick = () => {if (!enabled || confirm('DISABLE PRIVATE TERMINAL FOR ALL USERS?')) change('privacy_preview_set_enabled',{new_enabled:!enabled});};
  const destination = approved => {
    const host = document.getElementById('privacyHost').value.trim().toLowerCase();
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) || host.length > 253) {message.textContent = 'Enter a hostname only, without scheme, path or IP address.'; return;}
    change('privacy_preview_set_destination',{new_hostname:host,new_approved:approved});
  };
  document.getElementById('privacyApprove').onclick = () => destination(true);
  document.getElementById('privacyRemove').onclick = () => destination(false);
  await refresh();
}
new MutationObserver(() => {
  if (!document.getElementById('dashboard').classList.contains('hidden')) refreshPrivacyHome();
}).observe(document.getElementById('dashboard'),{attributes:true,attributeFilter:['class']});
window.addEventListener('pagehide',logoutPrivacy);
document.addEventListener('visibilitychange',() => {
  if (document.hidden) stopPrivacyPreview();
  else if (!document.getElementById('privateTerminal').classList.contains('hidden')) openPrivacyPage();
});
