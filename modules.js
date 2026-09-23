/* RobCo archive modules: fictional local content; no database permissions required. */
const ROBCO_TAPES = [
  { id: 'HT-001', title: 'Morning Systems Check', location: 'VAULT OPERATIONS', entries: ['08:00 // Terminal array online.', '08:14 // Air filters inspected. Replacement scheduled for next cycle.', '08:32 // Archive access restored to public terminals.'] },
  { id: 'HT-002', title: 'Supply Inventory', location: 'ROBCO LOGISTICS', entries: ['Crate 14: spare circuit boards.', 'Crate 15: replacement fuses.', 'Note: submit all inventory corrections to the records desk.'] },
  { id: 'HT-003', title: 'Training Orientation', location: 'EMPLOYEE SERVICES', entries: ['Welcome to the RobCo terminal network.', 'Select a document from Files to read archived records.', 'Report faulty equipment to a supervisor.'] }
];
const ROBCO_DOCUMENTS = [
  { id: 'DOC-100', title: 'Terminal Operations Handbook', category: 'ROBCO', lines: ['Use an assigned terminal for authorized tasks.', 'Check the daily system bulletin before beginning a shift.', 'Record maintenance issues in the service log.'] },
  { id: 'DOC-207', title: 'Vault Supply Requisition', category: 'VAULT-TEC', lines: ['Request: replacement display tubes, quantity 4.', 'Request: printed maintenance forms, quantity 20.', 'Status: awaiting warehouse confirmation.'] },
  { id: 'DOC-312', title: 'Archive Index', category: 'RECORDS', lines: ['HT-001 // Morning Systems Check', 'HT-002 // Supply Inventory', 'HT-003 // Training Orientation'] }
];
let robcoGame = null;

function moduleCard(title, subtitle, onClick) {
  const button = document.createElement('button');
  button.className = 'archive-card';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const sub = document.createElement('small');
  sub.textContent = subtitle;
  button.append(heading, sub);
  button.addEventListener('click', onClick);
  return button;
}
function renderArchive(section, items, subtitle, readerId) {
  const list = document.querySelector('#' + section + ' .archive-list');
  const reader = document.getElementById(readerId);
  list.replaceChildren();
  reader.textContent = 'SELECT A RECORD TO BEGIN.';
  items.forEach(item => list.appendChild(moduleCard(item.title, item.id + ' // ' + (item.location || item.category), () => {
    reader.replaceChildren();
    const title = document.createElement('h3');
    title.textContent = item.id + ' // ' + item.title;
    const label = document.createElement('p');
    label.textContent = (item.location || item.category) + ' // ' + subtitle;
    reader.append(title, label);
    (item.entries || item.lines).forEach(line => {
      const p = document.createElement('p');
      p.textContent = '> ' + line;
      reader.appendChild(p);
    });
    reader.focus();
  })));
}
function renderHolotapes() { renderArchive('holotapes', ROBCO_TAPES, 'PLAYBACK COMPLETE', 'holotapeReader'); }
function renderFiles() { renderArchive('files', ROBCO_DOCUMENTS, 'END OF FILE', 'fileReader'); }
function startCodebreaker() {
  robcoGame = { code: String(Math.floor(Math.random() * 900) + 100), tries: 0 };
  const output = document.getElementById('gameOutput');
  output.replaceChildren();
  const p = document.createElement('p');
  p.textContent = 'GUESS THE 3-DIGIT ACCESS CODE. YOU HAVE 8 ATTEMPTS. FEEDBACK SHOWS DIGITS IN THE CORRECT POSITION.';
  const input = document.createElement('input');
  input.type = 'text'; input.inputMode = 'numeric'; input.maxLength = 3;
  input.setAttribute('aria-label', 'Three digit code');
  const result = document.createElement('p');
  result.setAttribute('role', 'status');
  const submit = document.createElement('button');
  submit.textContent = 'TEST CODE';
  submit.onclick = () => {
    const guess = input.value;
    if (!/^\d{3}$/.test(guess)) { result.textContent = 'ENTER EXACTLY THREE DIGITS.'; return; }
    robcoGame.tries++;
    const matches = [...guess].filter((digit, i) => digit === robcoGame.code[i]).length;
    if (guess === robcoGame.code) { result.textContent = 'ACCESS GRANTED IN ' + robcoGame.tries + ' ATTEMPTS.'; submit.disabled = true; }
    else if (robcoGame.tries >= 8) { result.textContent = 'TERMINAL LOCKED. CODE WAS ' + robcoGame.code + '. SELECT NEW GAME TO RESTART.'; submit.disabled = true; }
    else result.textContent = matches + '/3 POSITIONS CORRECT // ' + (8 - robcoGame.tries) + ' ATTEMPTS REMAIN.';
    input.value = ''; input.focus();
  };
  input.onkeydown = event => { if (event.key === 'Enter') submit.click(); };
  output.append(p, input, submit, result);
  input.focus();
}
function startSignalMatch() {
  const output = document.getElementById('gameOutput');
  output.replaceChildren();
  const symbols = ['△', '◇', '○', '□'];
  const pattern = Array.from({ length: 4 }, () => symbols[Math.floor(Math.random() * symbols.length)]);
  const title = document.createElement('p');
  title.textContent = 'MEMORIZE THE SIGNAL: ' + pattern.join(' ');
  const result = document.createElement('p');
  result.setAttribute('role', 'status');
  const controls = document.createElement('div');
  let entered = [];
  const buttons = symbols.map(symbol => {
    const button = document.createElement('button');
    button.textContent = symbol;
    button.onclick = () => {
      entered.push(symbol);
      if (entered.length === pattern.length) {
        result.textContent = entered.every((value, i) => value === pattern[i]) ? 'SIGNAL MATCHED.' : 'SIGNAL LOST. SELECT NEW GAME TO RETRY.';
        buttons.forEach(control => control.disabled = true);
      } else result.textContent = 'INPUT: ' + entered.join(' ');
    };
    return button;
  });
  controls.append(...buttons);
  output.append(title, controls, result);
  setTimeout(() => { if (title.isConnected) title.textContent = 'REPEAT THE FOUR SYMBOL SIGNAL.'; }, 3000);
}
