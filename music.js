/* Persistent music uses the existing publishable key and Overseer user JWT.
   No privileged credentials and no audio bytes are stored in this repository. */
const MUSIC_BUCKET = 'robco-radio';
const MUSIC_MAX_BYTES = 500 * 1000 * 1000; // 500 MB (decimal), matching Storage.
let musicLibraryRequest = 0;
let musicManagerBusy = false;

function musicHeaders(manage = false) {
  const headers = { apikey: SUPABASE_KEY };
  if (manage) {
    const token = window.overseerSession?.access_token;
    if (!token) throw new Error('OVERSEER LOGIN REQUIRED.');
    headers.Authorization = 'Bearer ' + token;
  }
  return headers;
}
async function musicRequest(endpoint, { manage = false, method = 'GET', body } = {}) {
  const response = await fetch(SUPABASE_URL + endpoint, {
    method, headers: { ...musicHeaders(manage), 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000)
  });
  let data;
  try { data = await response.json(); } catch (_) { data = null; }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error(manage ? 'ACCESS DENIED OR SESSION EXPIRED. SIGN IN AS AN OVERSEER AGAIN.' : 'MUSIC ACCESS UNAVAILABLE. CONTACT AN OVERSEER.');
    if (response.status === 404 || data?.code === 'PGRST205' || data?.code === 'PGRST202') throw new Error('MUSIC SERVICE NOT CONFIGURED. APPLY THE RADIO SQL SETUP.');
    throw new Error(data?.message || data?.error || 'MUSIC REQUEST FAILED. PLEASE RETRY.');
  }
  return data;
}
function musicRpc(name, body = {}) { return musicRequest('/rest/v1/rpc/' + name, { manage:true, method:'POST', body }); }
async function musicRows(manage = false) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const batch = await musicRequest('/rest/v1/radio_tracks?select=*&order=created_at.asc,id.asc&limit=500&offset=' + offset + (manage ? '' : '&status=eq.ready'), { manage });
    if (!Array.isArray(batch)) throw new Error('INVALID MUSIC LIBRARY RESPONSE.');
    rows.push(...batch);
    if (batch.length < 500) return rows;
  }
}
async function musicSignedUrl(storagePath) {
  let data;
  try { data = await musicRequest('/storage/v1/object/sign/' + MUSIC_BUCKET + '/' + encodeURIComponent(storagePath), { method:'POST', body:{expiresIn:3600} }); }
  catch (_) { throw new Error('TRACK UNAVAILABLE. REFRESH THE LIBRARY OR TRY ANOTHER SONG.'); }
  if (!data?.signedURL) throw new Error('TRACK UNAVAILABLE. REFRESH THE LIBRARY OR TRY ANOTHER SONG.');
  // Only accept a Storage URL from this project's origin.
  const url = new URL(data.signedURL.startsWith('/object/') ? '/storage/v1' + data.signedURL : data.signedURL, SUPABASE_URL);
  if (url.origin !== new URL(SUPABASE_URL).origin || !url.pathname.startsWith('/storage/v1/object/sign/')) throw new Error('INVALID AUDIO LOCATION.');
  return url.href;
}
async function refreshRadioLibrary() {
  const request = ++musicLibraryRequest;
  const status = document.getElementById('radioLibraryStatus');
  if (status) status.textContent = 'RECEIVING MUSIC CATALOG…';
  try {
    const rows = await musicRows();
    if (request !== musicLibraryRequest) return;
    applyRadioLibrary(rows);
    if (status) status.textContent = rows.length ? rows.length + ' UPLOADED SONGS AVAILABLE.' : 'NO UPLOADED SONGS YET. LOCAL BROADCASTS AVAILABLE.';
  } catch (_) {
    if (request !== musicLibraryRequest) return;
    if (status) status.textContent = 'UPLOADED MUSIC UNAVAILABLE. LOCAL BROADCASTS STILL AVAILABLE. USE REFRESH TO RETRY.';
  }
}

async function validateMusicFile(file) {
  if (!file || !file.size) throw new Error('SELECT A NONEMPTY AUDIO FILE.');
  if (file.size > MUSIC_MAX_BYTES) throw new Error('FILE TOO LARGE. MAXIMUM 500 MB.');
  const extension = file.name.split('.').pop().toLowerCase();
  const types = {mp3:'audio/mpeg', wav:'audio/wav', m4a:'audio/mp4', aac:'audio/aac', ogg:'audio/ogg'};
  if (!types[extension]) throw new Error('USE MP3, WAV, M4A, AAC OR OGG AUDIO.');
  const header = new Uint8Array(await file.slice(0,64).arrayBuffer());
  const text = (start,length) => String.fromCharCode(...header.slice(start,start+length));
  const valid = extension === 'mp3' ? text(0,3) === 'ID3' || (header[0] === 255 && (header[1] & 224) === 224)
    : extension === 'wav' ? text(0,4) === 'RIFF' && text(8,4) === 'WAVE'
    : extension === 'm4a' ? text(4,4) === 'ftyp'
    : extension === 'aac' ? header[0] === 255 && (header[1] & 246) === 240
    : text(0,4) === 'OggS';
  if (!valid) throw new Error('FILE CONTENT DOES NOT MATCH ITS AUDIO FORMAT.');
  const source = URL.createObjectURL(file);
  const audio = new Audio();
  try {
    await new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error('AUDIO VALIDATION TIMED OUT. TRY ANOTHER FILE.')),15000);
      audio.onloadedmetadata = () => {
        clearTimeout(timer);
        if (Number.isFinite(audio.duration) && audio.duration > 0) resolve();
        else reject(new Error('AUDIO HAS NO PLAYABLE DURATION.'));
      };
      audio.onerror = () => { clearTimeout(timer); reject(new Error('CORRUPT AUDIO OR FORMAT NOT SUPPORTED BY THIS BROWSER.')); };
      audio.preload = 'metadata'; audio.src = source;
    });
  } finally {
    audio.onloadedmetadata = audio.onerror = null;
    audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(source);
  }
  return {extension, mime:types[extension]};
}
function uploadMusicObject(track, file, onProgress) {
  return new Promise((resolve,reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', SUPABASE_URL + '/storage/v1/object/' + MUSIC_BUCKET + '/' + encodeURIComponent(track.storage_path));
    for (const [key,value] of Object.entries(musicHeaders(true))) xhr.setRequestHeader(key,value);
    xhr.setRequestHeader('Content-Type',track.mime_type);
    xhr.setRequestHeader('x-upsert','false');
    xhr.setRequestHeader('cache-control','max-age=60');
    xhr.timeout = 3600000; // Allow up to one hour for large uploads.
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(xhr.status === 401 || xhr.status === 403 ? 'UPLOAD DENIED. SIGN IN AS AN OVERSEER AGAIN.' : 'UPLOAD FAILED. CHECK THE PENDING ENTRY BELOW.'));
    xhr.onerror = xhr.ontimeout = () => reject(new Error('UPLOAD INTERRUPTED. CHECK THE PENDING ENTRY BELOW BEFORE RETRYING.'));
    xhr.send(file);
  });
}
function musicMetadata(form) {
  const values = Object.fromEntries(new FormData(form));
  const metadata = {p_title:String(values.title || '').trim(), p_artist:String(values.artist || '').trim(), p_station:String(values.station || '').trim()};
  if (!metadata.p_title || !metadata.p_artist || !metadata.p_station || metadata.p_title.length > 120 || metadata.p_artist.length > 120 || metadata.p_station.length > 60) throw new Error('ENTER TITLE AND ARTIST (1–120 CHARACTERS), AND STATION (1–60).');
  return metadata;
}
function musicMessage(panel, message) { const status = panel.querySelector('[data-music-status]'); if (status) status.textContent = message; }
function setMusicBusy(panel,busy) {
  musicManagerBusy = busy;
  panel.querySelectorAll('button,input').forEach(control => { control.disabled = busy; });
  panel.setAttribute('aria-busy',String(busy));
}
async function musicAction(panel,action) {
  if (musicManagerBusy) return;
  setMusicBusy(panel,true);
  try { await action(); }
  catch (error) { musicMessage(panel,error.name === 'TimeoutError' ? 'CONNECTION TIMED OUT. REFRESH THE LIST BEFORE RETRYING.' : error.message); }
  finally {
    setMusicBusy(panel,false);
    if (panel.isConnected) await renderMusicManagerList(panel);
    refreshRadioLibrary();
  }
}
async function showMusicManager() {
  const output = document.getElementById('overseerOutput');
  if (!output) return;
  if (musicManagerBusy) { return; }
  output.textContent = 'VERIFYING OVERSEER CLEARANCE…';
  try {
    if (await musicRpc('radio_is_overseer') !== true) throw new Error('OVERSEER CLEARANCE REQUIRED.');
    if (!output.isConnected) return;
    output.innerHTML = `<section id="musicManager" aria-label="Overseer music management">
      <h2>RADIO // MUSIC MANAGEMENT</h2>
      <p>PERMANENT BROADCAST ARCHIVE</p>
      <form id="musicUploadForm">
        <label>AUDIO FILE <input name="audio" type="file" accept=".mp3,.wav,.m4a,.aac,.ogg" required></label>
        <p class="radio-note">MP3 / WAV / M4A / AAC / OGG • MAXIMUM 500 MB. Keep this page open until upload completes.</p>
        <label>SONG TITLE <input name="title" maxlength="120" required></label>
        <label>ARTIST <input name="artist" maxlength="120" required></label>
        <label>STATION / CATEGORY <input name="station" maxlength="60" list="musicStationNames" value="ROBCO SIGNAL" required></label>
        <datalist id="musicStationNames"><option value="ROBCO SIGNAL"><option value="VAULT AMBIENT"><option value="TERMINAL TEST"></datalist>
        <label class="music-rights"><input name="rights" type="checkbox" required> I have permission to upload and share this audio.</label>
        <button type="submit">UPLOAD SONG</button>
      </form>
      <p data-music-status role="status">SELECT AN AUTHORIZED AUDIO FILE TO BEGIN.</p>
      <button type="button" id="musicRefresh">REFRESH SONG LIST</button>
      <div id="musicSongList"></div>
    </section>`;
    const panel = output.querySelector('#musicManager');
    const form = panel.querySelector('form');
    form.onsubmit = event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      // Capture file/metadata before disabling the form (disabled fields leave FormData).
      let metadata;
      try { metadata = musicMetadata(form); } catch (error) { musicMessage(panel,error.message); return; }
      const file = form.elements.audio.files[0];
      musicAction(panel,async () => {
        musicMessage(panel,'VALIDATING AUDIO…');
        const format = await validateMusicFile(file);
        musicMessage(panel,'RESERVING ARCHIVE ENTRY…');
        const track = await musicRpc('radio_reserve_track',{...metadata,p_extension:format.extension,p_size:file.size,p_mime:format.mime});
        await uploadMusicObject(track,file,percent => musicMessage(panel,'UPLOADING AUDIO… ' + percent + '%'));
        musicMessage(panel,'VERIFYING STORED FILE…');
        await musicRpc('radio_publish_track',{p_id:track.id});
        form.reset();
        musicMessage(panel,'UPLOAD COMPLETE. SONG IS STORED AND AVAILABLE ON THE RADIO.');
      });
    };
    panel.querySelector('#musicRefresh').onclick = () => renderMusicManagerList(panel);
    await renderMusicManagerList(panel);
  } catch (error) { if (output.isConnected) output.textContent = error.message; }
}
async function renderMusicManagerList(panel) {
  const list = panel.querySelector('#musicSongList');
  list.textContent = 'LOADING ARCHIVE…';
  try {
    const rows = await musicRows(true);
    if (!panel.isConnected) return;
    list.replaceChildren();
    if (!rows.length) list.textContent = 'NO UPLOADED SONGS.';
    for (const track of rows) {
      const card = document.createElement('form');
      card.className = 'music-song';
      const heading = document.createElement('h3');
      heading.textContent = track.title + ' // ' + track.status.toUpperCase();
      card.append(heading);
      for (const [key,label,max] of [['title','SONG TITLE',120],['artist','ARTIST',120],['station','STATION / CATEGORY',60]]) {
        const field = document.createElement('label'), input = document.createElement('input');
        field.textContent = label; input.name = key; input.value = track[key]; input.maxLength = max; input.required = true;
        input.disabled = track.status === 'deleting'; field.append(input); card.append(field);
      }
      const info = document.createElement('p');
      info.className = 'radio-note';
      info.textContent = (track.file_size / 1024 / 1024).toFixed(1) + ' MiB // ' + track.mime_type;
      card.append(info);
      const save = document.createElement('button'); save.textContent = 'SAVE METADATA'; save.type = 'submit'; save.disabled = track.status === 'deleting';
      card.append(save);
      card.onsubmit = event => {
        event.preventDefault();
        if (!card.reportValidity()) return;
        let metadata;
        try { metadata = musicMetadata(card); } catch (error) { musicMessage(panel,error.message); return; }
        musicAction(panel,async () => { await musicRpc('radio_edit_track',{p_id:track.id,...metadata}); musicMessage(panel,'METADATA SAVED.'); });
      };
      if (track.status === 'pending') {
        const finish = document.createElement('button'); finish.type='button'; finish.textContent='FINISH PENDING UPLOAD';
        finish.onclick = () => musicAction(panel,async () => { await musicRpc('radio_publish_track',{p_id:track.id}); musicMessage(panel,'STORED UPLOAD PUBLISHED.'); });
        card.append(finish);
        const help = document.createElement('p'); help.className='radio-note'; help.textContent='If the file reached Storage, finish the upload. Otherwise remove this pending entry, then upload again.'; card.append(help);
      }
      const remove = document.createElement('button'); remove.type='button'; remove.textContent = track.status === 'deleting' ? 'RETRY REMOVAL' : 'DELETE SONG';
      remove.onclick = () => {
        if (!confirm('Permanently remove "' + track.title + '" and its stored audio?')) return;
        musicAction(panel,async () => {
          musicMessage(panel,'REMOVING SONG AND STORED AUDIO…');
          const deleting = await musicRpc('radio_begin_delete',{p_id:track.id});
          if (deleting?.storage_path) {
            await musicRequest('/storage/v1/object/' + MUSIC_BUCKET,{manage:true,method:'DELETE',body:{prefixes:[deleting.storage_path]}});
            await musicRpc('radio_finish_delete',{p_id:track.id});
          }
          musicMessage(panel,'SONG AND STORED AUDIO REMOVED.');
        });
      };
      card.append(remove); list.append(card);
    }
  } catch (error) { list.textContent = error.message; }
}
window.addEventListener('beforeunload',event => { if (musicManagerBusy) { event.preventDefault(); event.returnValue=''; } });
