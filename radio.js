/* Original local signals plus optional persistent Supabase music programs. */
const ROBCO_STATIONS = [
  { name: 'ROBCO SIGNAL', frequency: '88.4', description: 'Swing from the service desk', tracks: [
    { title: 'Lunch Break at Relay Nine', bpm: 112, root: 48, swing: .16, melody: [12,16,19,21,19,16,14,16,12,14,16,19,17,16,14,7] },
    { title: 'After Hours Assembly', bpm: 100, root: 53, swing: .2, melody: [19,16,12,14,16,21,19,16,17,14,10,14,16,12,7,12] },
    { title: 'Original RobCo Signal', notes: [220,330,440,330] }
  ] },
  { name: 'VAULT AMBIENT', frequency: '101.3', description: 'Quiet hours beneath the surface', tracks: [
    { title: 'Atrium Lights', bpm: 72, root: 45, ambient: true, melody: [12,null,19,16,null,14,12,null,9,null,16,19,null,14,7,null] },
    { title: 'The Sleeping Reactor', bpm: 64, root: 50, ambient: true, melody: [7,null,14,null,17,14,null,12,9,null,16,null,19,16,14,null] },
    { title: 'Original Vault Signal', notes: [196,246.94,293.66,246.94] }
  ] },
  { name: 'TERMINAL TEST', frequency: '107.7', description: 'Preserved calibration broadcasts', tracks: [
    { title: 'Original Terminal Test', notes: [262,392,523.25,392] }
  ] }
];
const ROBCO_LOCAL_STATIONS = ROBCO_STATIONS.map(station => ({...station, tracks:[...station.tracks]}));
let robcoMedia = null;
let robcoMediaTimeout = null;
let robcoMediaCancel = null;
const robcoSignedSources = new Map();
let robcoStation = 0;
let robcoTrack = 0;
let robcoVolume = .8;
let robcoMuted = false;
let robcoAudio = null;
let robcoRadioTimer = null;
let robcoMaster = null;
let robcoGeneration = 0;
let robcoState = 'OFFLINE';
let robcoMessage = '';
let robcoPosition = 0;
let robcoStartedAt = 0;
let robcoEvents = [];
let robcoEventIndex = 0;
let robcoQueueKey = '';
const radioTrack = () => ROBCO_STATIONS[robcoStation].tracks[robcoTrack];
const radioDuration = () => radioTrack().storage_path ? radioTrack().duration || 0 : radioTrack().notes ? 23.04 : 64 * 60 / radioTrack().bpm;
const radioTime = seconds => Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0') : '--:--';
const radioFrequency = midi => 440 * Math.pow(2, (midi - 69) / 12);
function radioPosition() {
  if (robcoMedia) return Number.isFinite(robcoMedia.currentTime) ? robcoMedia.currentTime : 0;
  return Math.min(radioDuration(), robcoPosition + (robcoState === 'ON AIR' && robcoAudio ? robcoAudio.currentTime - robcoStartedAt : 0));
}
function radioRelease() {
  ++robcoGeneration; // Invalidate pending resume promises before navigation or tuning.
  clearTimeout(robcoMediaTimeout);
  if (robcoMediaCancel) { robcoMediaCancel(); robcoMediaCancel = null; }
  if (robcoMedia) {
    robcoMedia.onloadedmetadata = robcoMedia.onerror = robcoMedia.onended = robcoMedia.ontimeupdate = robcoMedia.onwaiting = robcoMedia.onplaying = robcoMedia.onpause = null;
    robcoMedia.pause(); robcoMedia.removeAttribute('src'); robcoMedia.load(); robcoMedia = null;
  }
  clearInterval(robcoRadioTimer);
  robcoRadioTimer = null;
  const audio = robcoAudio;
  robcoAudio = null;
  robcoMaster = null;
  if (audio) {
    audio.onstatechange = null;
    try { const closing = audio.close(); if (closing) closing.catch(() => {}); } catch (_) { /* Already closed. */ }
  }
}
function stopRobcoRadio() {
  radioRelease();
  robcoPosition = 0;
  robcoState = 'OFFLINE';
  robcoMessage = '';
  updateRadioDisplay();
}
function pauseRobcoRadio() {
  robcoPosition = radioPosition();
  radioRelease();
  robcoState = 'PAUSED';
  updateRadioDisplay();
}
function radioFailure(message) {
  radioRelease();
  robcoState = 'SIGNAL LOST';
  robcoMessage = message;
  updateRadioDisplay();
}
function buildRadioScore(track) {
  const events = [];
  const add = (time, frequency, duration, volume, type = 'sine') => events.push({ time, frequency, duration, volume, type });
  if (track.notes) {
    for (let i = 0; i < 64; i++) add(i * .36, track.notes[i % track.notes.length], .28, .2);
  } else {
    const beat = 60 / track.bpm;
    const chords = [0,5,0,7,5,0,7,0];
    for (let bar = 0; bar < 16; bar++) {
      const root = track.root + chords[bar % chords.length];
      const start = bar * 4 * beat;
      // A soft chord bed, alternating bass and two varied melodic phrases.
      [0,4,7,11].forEach(note => add(start, radioFrequency(root + 12 + note), beat * 3.8, .022, 'triangle'));
      for (let b = 0; b < 4; b++) {
        add(start + b * beat, radioFrequency(root + (b % 2 ? 7 : 0)), beat * .75, .09, 'sine');
      }
      for (let step = 0; step < 8; step++) {
        const note = track.melody[(bar * 4 + step) % track.melody.length];
        if (note === null) continue;
        const offset = (step / 2 + (step % 2 ? track.swing || 0 : 0)) * beat;
        add(start + offset, radioFrequency(root + note), beat * (track.ambient ? .85 : .32), .075, track.ambient ? 'sine' : 'triangle');
      }
    }
  }
  return events.sort((a,b) => a.time - b.time);
}
function scheduleRadioNote(event, when) {
  const oscillator = robcoAudio.createOscillator();
  const gain = robcoAudio.createGain();
  oscillator.type = event.type;
  oscillator.frequency.value = event.frequency;
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(event.volume, when + .025);
  gain.gain.exponentialRampToValueAtTime(.0001, when + event.duration);
  oscillator.connect(gain).connect(robcoMaster);
  oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  oscillator.start(when);
  oscillator.stop(when + event.duration + .01);
}
function radioTick() {
  if (robcoState !== 'ON AIR' || !robcoAudio) return;
  try {
    const position = radioPosition();
    if (position >= radioDuration()) { nextRobcoTrack(1); return; }
    while (robcoEventIndex < robcoEvents.length && robcoEvents[robcoEventIndex].time < position + .15) {
      const event = robcoEvents[robcoEventIndex++];
      // A throttled background tab must not play a backlog of notes at once.
      if (event.time >= position - .08) scheduleRadioNote(event, Math.max(robcoAudio.currentTime, robcoStartedAt + event.time - robcoPosition));
    }
    updateRadioProgress();
  } catch (_) { radioFailure('AUDIO INTERRUPTED. PRESS PLAY TO RETRY OR SELECT ANOTHER STATION.'); }
}
async function playRobcoRadio() {
  radioRelease();
  const generation = robcoGeneration;
  if (radioTrack().storage_path) { await playUploadedRadio(generation); return; }
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) { radioFailure('AUDIO UNAVAILABLE ON THIS DEVICE. TRY A BROWSER WITH WEB AUDIO SUPPORT.'); return; }
  robcoState = 'TUNING';
  robcoMessage = '';
  updateRadioDisplay();
  try {
    const audio = new AudioCtor();
    robcoAudio = audio;
    await audio.resume();
    if (generation !== robcoGeneration) return;
    if (audio.state !== 'running') throw new Error('Audio suspended');
    robcoMaster = audio.createGain();
    robcoMaster.gain.value = robcoMuted ? 0 : robcoVolume;
    robcoMaster.connect(audio.destination);
    robcoEvents = buildRadioScore(radioTrack());
    robcoEventIndex = robcoEvents.findIndex(event => event.time >= robcoPosition);
    if (robcoEventIndex < 0) robcoEventIndex = robcoEvents.length;
    robcoStartedAt = audio.currentTime;
    robcoState = 'ON AIR';
    audio.onstatechange = () => {
      if (generation === robcoGeneration && audio.state !== 'running') {
        robcoPosition = radioPosition();
        radioFailure('AUDIO INTERRUPTED. PRESS PLAY TO RECONNECT.');
      }
    };
    robcoRadioTimer = setInterval(radioTick, 50);
    updateRadioDisplay();
    radioTick();
  } catch (_) {
    if (generation === robcoGeneration) radioFailure('AUDIO START FAILED. PRESS PLAY TO RETRY.');
  }
}
function toggleRobcoRadio() {
  if (robcoState === 'ON AIR' || robcoState === 'TUNING') pauseRobcoRadio();
  else playRobcoRadio();
}
function selectRobcoTrack(index) {
  const playing = robcoState === 'ON AIR' || robcoState === 'TUNING';
  radioRelease();
  robcoTrack = index;
  robcoPosition = 0;
  robcoMessage = '';
  robcoState = 'READY';
  if (playing) playRobcoRadio();
  else updateRadioDisplay();
}
function nextRobcoTrack(direction) {
  selectRobcoTrack((robcoTrack + direction + ROBCO_STATIONS[robcoStation].tracks.length) % ROBCO_STATIONS[robcoStation].tracks.length);
}
function selectRobcoStation(index) { robcoStation = index; selectRobcoTrack(0); }
function tuneRobcoRadio(direction) { selectRobcoStation((robcoStation + direction + ROBCO_STATIONS.length) % ROBCO_STATIONS.length); }
function seekRobcoRadio(value) {
  const playing = robcoState === 'ON AIR' || robcoState === 'TUNING';
  radioRelease();
  robcoPosition = Math.max(0, Math.min(radioDuration() - .1, Number(value) || 0));
  robcoState = 'PAUSED';
  if (playing) playRobcoRadio();
  else updateRadioDisplay();
}
function setRobcoVolume(value) {
  robcoVolume = Math.max(0, Math.min(1, (Number(value) || 0) / 100));
  if (robcoMaster) robcoMaster.gain.setTargetAtTime(robcoMuted ? 0 : robcoVolume, robcoAudio.currentTime, .02);
  if (robcoMedia) { robcoMedia.volume = robcoVolume; robcoMedia.muted = robcoMuted; }
  updateRadioDisplay();
}
function muteRobcoRadio() { robcoMuted = !robcoMuted; setRobcoVolume(robcoVolume * 100); }
function updateRadioProgress() {
  const progress = document.getElementById('radioProgress');
  if (!progress) return;
  const position = radioPosition();
  progress.max = radioDuration();
  progress.disabled = !radioDuration();
  if (document.activeElement !== progress) progress.value = position;
  progress.setAttribute('aria-valuetext', radioTime(position) + ' of ' + radioTime(radioDuration()));
  document.getElementById('radioTime').textContent = radioTime(position) + ' / ' + (radioDuration() ? radioTime(radioDuration()) : '--:--');
}
function updateRadioDisplay() {
  const display = document.getElementById('radioDisplay');
  if (!display) return;
  const station = ROBCO_STATIONS[robcoStation];
  const status = (station.frequency ? station.frequency + ' MHz // ' : 'ARCHIVE // ') + station.name + ' // ' + robcoState + (robcoMessage ? ' — ' + robcoMessage : '');
  if (display.textContent !== status) display.textContent = status;
  document.getElementById('radioTitle').textContent = radioTrack().title;
  document.getElementById('radioDetails').textContent = (radioTrack().artist || 'ROBCO HOUSE ORCHESTRA') + ' // ' + (robcoTrack + 1) + ' OF ' + station.tracks.length + ' // ' + (radioTrack().storage_path ? 'OVERSEER ARCHIVE' : radioTrack().notes ? 'LEGACY SIGNAL' : 'ORIGINAL INSTRUMENTAL');
  const active = robcoState === 'ON AIR' || robcoState === 'TUNING';
  document.getElementById('radioPlay').textContent = active ? 'Ⅱ PAUSE' : '▶ PLAY';
  document.getElementById('radioPlay').setAttribute('aria-pressed', String(active));
  document.getElementById('radioMute').textContent = robcoMuted ? 'UNMUTE' : 'MUTE';
  document.getElementById('radioMute').setAttribute('aria-pressed', String(robcoMuted));
  document.getElementById('radioVolumeValue').textContent = Math.round(robcoVolume * 100) + '%';
  document.getElementById('radioVolume').value = Math.round(robcoVolume * 100);
  const key = robcoStation + ':' + robcoTrack;
  if (robcoQueueKey !== key) {
    const stations = document.getElementById('radioStations');
    if (!stations.children.length) ROBCO_STATIONS.forEach((item, index) => {
      const button = moduleCard((item.frequency ? item.frequency + ' // ' : '') + item.name, item.description, () => selectRobcoStation(index));
      stations.append(button);
    });
    [...stations.children].forEach((button, index) => button.setAttribute('aria-pressed', String(index === robcoStation)));
    const playlist = document.getElementById('radioPlaylist');
    // Keep focused playlist buttons in place when only the current track changes.
    if (playlist.dataset.station !== String(robcoStation)) {
      playlist.replaceChildren();
      station.tracks.forEach((track, index) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.textContent = track.title + (track.artist ? ' — ' + track.artist : '');
        button.onclick = () => selectRobcoTrack(index);
        item.append(button); playlist.append(item);
      });
      playlist.dataset.station = String(robcoStation);
    }
    [...playlist.children].forEach((item,index) => item.firstChild.setAttribute('aria-current', String(index === robcoTrack)));
    robcoQueueKey = key;
  }
  updateRadioProgress();
}
window.addEventListener('pagehide', stopRobcoRadio);

function applyRadioLibrary(rows) {
  const selected = radioTrack();
  const stationName = ROBCO_STATIONS[robcoStation].name;
  const stations = ROBCO_LOCAL_STATIONS.map(station => ({...station, tracks:[...station.tracks]}));
  for (const row of rows) {
    if (row.status !== 'ready') continue;
    let station = stations.find(item => item.name === row.station);
    if (!station) { station = {name:row.station,description:'Overseer broadcast archive',tracks:[]}; stations.push(station); }
    station.tracks.push({...row, duration:row.id === selected.id ? selected.duration : undefined});
  }
  const stationIndex = stations.findIndex(item => item.tracks.some(track => selected.id ? track.id === selected.id : item.name === stationName && track.title === selected.title));
  if (stationIndex < 0) stopRobcoRadio();
  ROBCO_STATIONS.splice(0,ROBCO_STATIONS.length,...stations);
  robcoStation = stationIndex < 0 ? 0 : stationIndex;
  robcoTrack = stationIndex < 0 ? 0 : stations[stationIndex].tracks.findIndex(track => selected.id ? track.id === selected.id : track.title === selected.title);
  if (stationIndex < 0) robcoMessage = 'PREVIOUS SONG REMOVED. SELECT ANOTHER PROGRAM.';
  robcoQueueKey = '';
  document.getElementById('radioStations').replaceChildren();
  delete document.getElementById('radioPlaylist').dataset.station;
  updateRadioDisplay();
}
async function playUploadedRadio(generation) {
  robcoState = 'TUNING'; robcoMessage = '';
  updateRadioDisplay();
  try {
    const track = radioTrack();
    const cached = robcoSignedSources.get(track.storage_path);
    const source = cached && cached.expires > Date.now() ? cached.url : await musicSignedUrl(track.storage_path);
    if (generation !== robcoGeneration) return;
    if (!cached || cached.expires <= Date.now()) robcoSignedSources.set(track.storage_path,{url:source,expires:Date.now()+55*60*1000});
    const audio = new Audio(); robcoMedia = audio;
    audio.volume = robcoVolume; audio.muted = robcoMuted; audio.preload = 'metadata';
    const startupDeadline = new Promise((_,reject) => {
      robcoMediaCancel = () => reject(new Error('Playback cancelled'));
      robcoMediaTimeout = setTimeout(() => reject(new Error('AUDIO LOAD TIMED OUT. PRESS PLAY TO RETRY.')),20000);
    });
    const metadataReady = new Promise((resolve,reject) => {
      audio.onloadedmetadata = () => {
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) { reject(new Error('INVALID AUDIO DURATION. TRY ANOTHER SONG.')); return; }
        track.duration = audio.duration;
        // A catalog refresh may have replaced this track object while loading.
        if (radioTrack().id === track.id) radioTrack().duration = audio.duration;
        audio.currentTime = Math.min(robcoPosition, Math.max(0,audio.duration - .1));
        resolve();
      };
      audio.onerror = () => reject(new Error('AUDIO MISSING OR UNSUPPORTED. REFRESH THE LIBRARY OR SELECT ANOTHER SONG.'));
      audio.src = source;
    });
    // Start within the click's activation window when a signed URL is cached.
    // If a browser blocks the first network-delayed start, the next PLAY can retry.
    await Promise.race([Promise.all([metadataReady,audio.play()]),startupDeadline]);
    if (generation !== robcoGeneration) return;
    clearTimeout(robcoMediaTimeout); robcoMediaCancel = null;
    audio.onloadedmetadata = null;
    audio.onerror = () => { if (generation === robcoGeneration) {
      robcoSignedSources.delete(track.storage_path);
      radioFailure('SIGNAL LOST. PRESS PLAY TO RETRY OR SELECT ANOTHER SONG.');
    } };
    audio.ontimeupdate = updateRadioProgress;
    audio.onended = () => { if (generation === robcoGeneration) nextRobcoTrack(1); };
    audio.onwaiting = () => { if (generation === robcoGeneration) {
      robcoMessage = 'BUFFERING…'; updateRadioDisplay();
      clearTimeout(robcoMediaTimeout);
      robcoMediaTimeout = setTimeout(() => {
        if (generation === robcoGeneration) { robcoPosition = radioPosition(); radioFailure('SIGNAL TIMED OUT. PRESS PLAY TO RETRY.'); }
      },20000);
    } };
    audio.onplaying = () => { if (generation === robcoGeneration) { clearTimeout(robcoMediaTimeout); robcoMessage = ''; updateRadioDisplay(); } };
    robcoState = 'ON AIR'; updateRadioDisplay();
  } catch (error) {
    if (generation === robcoGeneration) {
      if (error.name !== 'NotAllowedError') robcoSignedSources.delete(radioTrack().storage_path);
      radioFailure(error.name === 'NotAllowedError' ? 'PLAYBACK BLOCKED. PRESS PLAY TO RETRY.' : error.message);
    }
  }
}
