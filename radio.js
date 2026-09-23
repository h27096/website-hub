/* Original, locally synthesized RobCo instrumentals. No recordings or remote audio. */
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
const radioDuration = () => radioTrack().notes ? 23.04 : 64 * 60 / radioTrack().bpm;
const radioTime = seconds => Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
const radioFrequency = midi => 440 * Math.pow(2, (midi - 69) / 12);
function radioPosition() {
  return Math.min(radioDuration(), robcoPosition + (robcoState === 'ON AIR' && robcoAudio ? robcoAudio.currentTime - robcoStartedAt : 0));
}
function radioRelease() {
  ++robcoGeneration; // Invalidate pending resume promises before navigation or tuning.
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
  updateRadioDisplay();
}
function muteRobcoRadio() { robcoMuted = !robcoMuted; setRobcoVolume(robcoVolume * 100); }
function updateRadioProgress() {
  const progress = document.getElementById('radioProgress');
  if (!progress) return;
  const position = radioPosition();
  progress.max = radioDuration();
  if (document.activeElement !== progress) progress.value = position;
  progress.setAttribute('aria-valuetext', radioTime(position) + ' of ' + radioTime(radioDuration()));
  document.getElementById('radioTime').textContent = radioTime(position) + ' / ' + radioTime(radioDuration());
}
function updateRadioDisplay() {
  const display = document.getElementById('radioDisplay');
  if (!display) return;
  const station = ROBCO_STATIONS[robcoStation];
  const status = station.frequency + ' MHz // ' + station.name + ' // ' + robcoState + (robcoMessage ? ' — ' + robcoMessage : '');
  if (display.textContent !== status) display.textContent = status;
  document.getElementById('radioTitle').textContent = radioTrack().title;
  document.getElementById('radioDetails').textContent = 'ROBCO HOUSE ORCHESTRA // ' + (robcoTrack + 1) + ' OF ' + station.tracks.length + ' // ' + (radioTrack().notes ? 'LEGACY SIGNAL' : 'ORIGINAL INSTRUMENTAL');
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
      const button = moduleCard(item.frequency + ' // ' + item.name, item.description, () => selectRobcoStation(index));
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
        button.textContent = track.title;
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
