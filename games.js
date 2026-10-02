/* Original local terminal training games. No network or persistent player data. */
let gameCleanup = () => {};
function stopRobcoGame() {
  gameCleanup();
  gameCleanup = () => {};
}
function beginRobcoGame(title, instructions, restart) {
  stopRobcoGame();
  const output = document.getElementById('gameOutput');
  output.replaceChildren();
  const controller = new AbortController();
  const timers = new Set();
  const heading = document.createElement('h3'); heading.textContent = title;
  const help = document.createElement('p'); help.textContent = instructions;
  const reset = document.createElement('button'); reset.textContent = 'RESTART / RESET';
  reset.addEventListener('click', restart, {signal: controller.signal});
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const board = document.createElement('div'); board.className = 'training-board';
  output.append(heading, help, reset, status, board);
  gameCleanup = () => {
    controller.abort();
    timers.forEach(clearTimeout); timers.clear();
    output.replaceChildren();
    output.textContent = 'SELECT A GAME TO BEGIN.';
  };
  return {
    board, status,
    button(label, action) {
      const button = document.createElement('button'); button.textContent = label;
      button.addEventListener('click', action, {signal: controller.signal});
      board.append(button); return button;
    },
    later(action, delay) {
      const id = setTimeout(() => { timers.delete(id); action(); }, delay);
      timers.add(id); return id;
    }
  };
}
function startMemoryBanks() {
  const game = beginRobcoGame('MEMORY BANKS', 'Find all six matching pairs. Select cards with a mouse, touch, or Tab and Enter/Space. Mismatched cards close after one second.', startMemoryBanks);
  game.board.classList.add('memory-grid');
  const cards = ['A','B','C','D','E','F','A','B','C','D','E','F'];
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1)); [cards[i],cards[j]] = [cards[j],cards[i]];
  }
  let first = null, locked = false, pairs = 0, attempts = 0;
  game.status.textContent = 'PAIRS: 0/6 // ATTEMPTS: 0';
  cards.forEach((symbol, index) => {
    const card = game.button('?', () => {
      if (locked || card.disabled || card === first) return;
      card.textContent = symbol; card.setAttribute('aria-label', 'Card ' + (index + 1) + ': ' + symbol);
      if (!first) { first = card; return; }
      attempts++;
      const previous = first; first = null;
      if (previous.textContent === symbol) {
        card.disabled = previous.disabled = true; pairs++;
      } else {
        locked = true;
        game.later(() => {
          [previous,card].forEach(item => {item.textContent = '?'; item.setAttribute('aria-label', item.dataset.hiddenLabel);});
          locked = false;
        }, 1000);
      }
      game.status.textContent = (pairs === 6 ? 'MEMORY RESTORED // ' : '') + 'PAIRS: ' + pairs + '/6 // ATTEMPTS: ' + attempts;
    });
    card.dataset.hiddenLabel = 'Hidden card ' + (index + 1);
    card.setAttribute('aria-label', card.dataset.hiddenLabel);
  });
}
function startCircuitGrid() {
  const game = beginRobcoGame('CIRCUIT GRID', 'Switch every circuit OFF. Selecting a cell flips it and its neighbors above, below, left and right. Use touch, mouse, or Tab and Enter/Space. Every starting board is solvable.', startCircuitGrid);
  game.board.classList.add('circuit-grid');
  const state = Array(9).fill(false); let moves = 0;
  function flip(index) {
    [index, index >= 3 ? index-3 : -1, index < 6 ? index+3 : -1, index%3 ? index-1 : -1, index%3 < 2 ? index+1 : -1].filter(i => i >= 0).forEach(i => state[i] = !state[i]);
  }
  for (let i = 0; i < 9; i++) if (Math.random() < .5) flip(i);
  if (!state.some(Boolean)) flip(4);
  const buttons = state.map((_, index) => game.button('', () => {flip(index); moves++; render();}));
  function render() {
    const won = !state.some(Boolean);
    buttons.forEach((button, index) => {
      button.textContent = state[index] ? 'ON' : 'OFF';
      button.setAttribute('aria-label', 'Circuit ' + (index+1) + ': ' + button.textContent);
      button.setAttribute('aria-pressed', String(state[index])); button.disabled = won;
    });
    game.status.textContent = (won ? 'GRID STABILIZED // ' : '') + 'MOVES: ' + moves;
  }
  render();
}
function startReactorTiming() {
  const game = beginRobcoGame('REACTOR TIMING', 'Select ARM, then wait for DISCHARGE NOW before selecting the same button again. Early input ends the round. Use a mouse, touch, or Enter/Space. Restart for another round.', startReactorTiming);
  let phase = 'idle', readyAt = 0;
  game.status.textContent = 'REACTOR IDLE.';
  const trigger = game.button('ARM REACTOR', () => {
    if (phase === 'idle') {
      phase = 'waiting'; trigger.textContent = 'WAIT FOR SIGNAL'; game.status.textContent = 'CHARGING...';
      game.later(() => {
        if (phase !== 'waiting') return;
        phase = 'ready'; readyAt = performance.now(); trigger.textContent = 'DISCHARGE NOW'; game.status.textContent = 'SIGNAL READY — DISCHARGE NOW';
      }, 1500 + Math.random() * 2500);
    } else if (phase === 'waiting') {
      phase = 'done'; trigger.disabled = true; game.status.textContent = 'TOO EARLY. RESTART TO TRY AGAIN.';
    } else if (phase === 'ready') {
      phase = 'done'; trigger.disabled = true;
      game.status.textContent = 'DISCHARGED IN ' + Math.round(performance.now() - readyAt) + ' ms. RESTART TO TRY AGAIN.';
    }
  });
}
// Hidden sections, logout, navigation and tab backgrounding all end active games.
new MutationObserver(() => {
  if (document.getElementById('games').classList.contains('hidden')) stopRobcoGame();
}).observe(document.getElementById('games'), {attributes:true, attributeFilter:['class']});
document.addEventListener('visibilitychange', () => { if (document.hidden) stopRobcoGame(); });
window.addEventListener('pagehide', stopRobcoGame);
