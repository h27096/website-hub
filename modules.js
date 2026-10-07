/* Shared Radio cards and local mini-games. */
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
function startCodebreaker() {
  const lifecycle = beginRobcoGame('CODEBREAKER', '', startCodebreaker);
  robcoGame = { code: String(Math.floor(Math.random() * 900) + 100), tries: 0 };
  const output = document.getElementById('gameOutput');
  const reset = output.querySelector('button');
  output.replaceChildren(reset);
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
  const lifecycle = beginRobcoGame('SIGNAL MATCH', '', startSignalMatch);
  const output = document.getElementById('gameOutput');
  const reset = output.querySelector('button');
  output.replaceChildren(reset);
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
  lifecycle.later(() => { if (title.isConnected) title.textContent = 'REPEAT THE FOUR SYMBOL SIGNAL.'; }, 3000);
}

