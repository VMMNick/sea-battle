'use strict';

const SIZE = 10;
const SHIP_LENGTHS = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
const COLS = 'АБВГДЕЖЗИК'.split(''); // 10 letters for column labels

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
const screens = {
  menu: $('screen-menu'),
  waiting: $('screen-waiting'),
  placement: $('screen-placement'),
  battle: $('screen-battle'),
  over: $('screen-over'),
};
function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

const statusBar = $('status-bar');
function setStatus(text) { statusBar.textContent = text; }

// ---------- WebSocket ----------
const proto = location.protocol === 'https:' ? 'wss' : 'ws';
let ws;
let myPlayer = null; // 'p1' | 'p2'
let roomCode = null;

function connect() {
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.addEventListener('open', () => setStatus('Підключено до сервера'));
  ws.addEventListener('close', () => {
    setStatus('З’єднання втрачено. Перепідключення…');
    setTimeout(connect, 2000);
  });
  ws.addEventListener('error', () => setStatus('Помилка з’єднання'));
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    handleMessage(msg);
  });
}
connect();

function sendMsg(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---------- Menu ----------
$('btn-create').addEventListener('click', () => {
  $('menu-error').textContent = '';
  sendMsg({ type: 'create' });
});
$('btn-join').addEventListener('click', joinRoom);
$('input-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});
function joinRoom() {
  const code = $('input-code').value.trim().toUpperCase();
  $('menu-error').textContent = '';
  if (!code) return;
  sendMsg({ type: 'join', code });
}

$('btn-copy-code').addEventListener('click', () => {
  navigator.clipboard?.writeText(roomCode).catch(() => {});
  $('btn-copy-code').textContent = 'Скопійовано!';
  setTimeout(() => { $('btn-copy-code').textContent = 'Скопіювати код'; }, 1500);
});

// ---------- Placement state ----------
let placedShips = []; // { cells: [[r,c],...] }
let occupiedSet = new Set();
let rotation = 'h'; // 'h' | 'v'
let shipQueue = []; // remaining lengths to place, longest first

function resetPlacement() {
  placedShips = [];
  occupiedSet = new Set();
  rotation = 'h';
  shipQueue = [...SHIP_LENGTHS];
  renderFleetStatus();
  buildOwnGrid();
  $('btn-ready').disabled = true;
  $('opp-ready-note').classList.add('hidden');
}

function renderFleetStatus() {
  const counts = {};
  SHIP_LENGTHS.forEach((l) => { counts[l] = (counts[l] || 0) + 1; });
  const placedCounts = {};
  placedShips.forEach((s) => { placedCounts[s.cells.length] = (placedCounts[s.cells.length] || 0) + 1; });

  const el = $('fleet-status');
  el.innerHTML = '';
  Object.keys(counts).sort((a, b) => b - a).forEach((len) => {
    const total = counts[len];
    const placed = placedCounts[len] || 0;
    for (let i = 0; i < total; i++) {
      const chip = document.createElement('span');
      chip.className = 'fleet-chip' + (i < placed ? ' done' : '');
      chip.textContent = '▮'.repeat(Number(len));
      el.appendChild(chip);
    }
  });
}

function neighborsOf(cells) {
  const set = new Set();
  for (const [r, c] of cells) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE) set.add(`${nr},${nc}`);
      }
    }
  }
  return set;
}

function canPlace(cells) {
  for (const [r, c] of cells) {
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return false;
    if (occupiedSet.has(`${r},${c}`)) return false;
  }
  // no touching existing ships
  const forbidden = neighborsOf(cells);
  for (const [r, c] of cells) {
    // remove own cells from forbidden check target - irrelevant since occupiedSet already excludes them
  }
  for (const key of forbidden) {
    if (occupiedSet.has(key) && !cells.some(([r, c]) => `${r},${c}` === key)) {
      // touching an occupied cell that's not part of this ship
      return false;
    }
  }
  return true;
}

function nextShipLength() {
  return shipQueue.length ? shipQueue[0] : null;
}

function cellsForPlacement(r, c, len, rot) {
  const cells = [];
  for (let i = 0; i < len; i++) {
    cells.push(rot === 'h' ? [r, c + i] : [r + i, c]);
  }
  return cells;
}

function buildOwnGrid() {
  const grid = $('grid-own');
  grid.innerHTML = '';
  grid.classList.remove('grid-small');
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      cell.addEventListener('mouseenter', () => previewAt(r, c));
      cell.addEventListener('mouseleave', clearPreview);
      cell.addEventListener('click', () => placeAt(r, c));
      grid.appendChild(cell);
    }
  }
  paintOwnShips();
}

function paintOwnShips() {
  document.querySelectorAll('#grid-own .cell').forEach((el) => el.classList.remove('ship'));
  for (const ship of placedShips) {
    for (const [r, c] of ship.cells) {
      const el = ownCellEl(r, c);
      if (el) el.classList.add('ship');
    }
  }
}

function ownCellEl(r, c) {
  return document.querySelector(`#grid-own .cell[data-r="${r}"][data-c="${c}"]`);
}

function clearPreview() {
  document.querySelectorAll('#grid-own .cell.preview-ok, #grid-own .cell.preview-bad')
    .forEach((el) => el.classList.remove('preview-ok', 'preview-bad'));
}

function previewAt(r, c) {
  clearPreview();
  const len = nextShipLength();
  if (!len) return;
  const cells = cellsForPlacement(r, c, len, rotation);
  const ok = canPlace(cells);
  for (const [cr, cc] of cells) {
    const el = ownCellEl(cr, cc);
    if (el) el.classList.add(ok ? 'preview-ok' : 'preview-bad');
  }
}

function placeAt(r, c) {
  const len = nextShipLength();
  if (!len) return;
  const cells = cellsForPlacement(r, c, len, rotation);
  if (!canPlace(cells)) return;
  placedShips.push({ cells });
  cells.forEach(([cr, cc]) => occupiedSet.add(`${cr},${cc}`));
  shipQueue.shift();
  paintOwnShips();
  renderFleetStatus();
  clearPreview();
  $('btn-ready').disabled = shipQueue.length !== 0;
}

function toggleRotation() {
  rotation = rotation === 'h' ? 'v' : 'h';
}
$('btn-rotate').addEventListener('click', toggleRotation);
window.addEventListener('keydown', (e) => {
  if ((e.key === 'r' || e.key === 'R') && !screens.placement.classList.contains('hidden')) {
    toggleRotation();
  }
});

$('btn-clear').addEventListener('click', resetPlacement);

$('btn-random').addEventListener('click', () => {
  resetPlacement();
  const lengths = [...SHIP_LENGTHS];
  for (const len of lengths) {
    let placedOk = false;
    let attempts = 0;
    while (!placedOk && attempts < 500) {
      attempts++;
      const rot = Math.random() < 0.5 ? 'h' : 'v';
      const r = Math.floor(Math.random() * SIZE);
      const c = Math.floor(Math.random() * SIZE);
      const cells = cellsForPlacement(r, c, len, rot);
      if (canPlace(cells)) {
        placedShips.push({ cells });
        cells.forEach(([cr, cc]) => occupiedSet.add(`${cr},${cc}`));
        shipQueue.shift();
        placedOk = true;
      }
    }
  }
  paintOwnShips();
  renderFleetStatus();
  $('btn-ready').disabled = shipQueue.length !== 0;
});

$('btn-ready').addEventListener('click', () => {
  sendMsg({ type: 'place', ships: placedShips });
  $('btn-ready').disabled = true;
});

// ---------- Battle ----------
let myTurn = false;
let ownShotsGrid = null; // 10x10 of null|'hit'|'miss'|'sunk' — shots opponent made on us
let enemyShotsGrid = null; // 10x10 of null|'hit'|'miss'|'sunk' — our shots on enemy
let ownShipCellsSet = null;

function buildBattleGrids() {
  ownShotsGrid = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  enemyShotsGrid = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  ownShipCellsSet = new Set();
  placedShips.forEach((s) => s.cells.forEach(([r, c]) => ownShipCellsSet.add(`${r},${c}`)));

  const selfGrid = $('grid-self');
  selfGrid.innerHTML = '';
  selfGrid.classList.add('grid-small');
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      if (ownShipCellsSet.has(`${r},${c}`)) cell.classList.add('ship');
      cell.dataset.r = r;
      cell.dataset.c = c;
      selfGrid.appendChild(cell);
    }
  }

  const enemyGrid = $('grid-enemy');
  enemyGrid.innerHTML = '';
  enemyGrid.classList.add('grid-enemy');
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      cell.addEventListener('click', () => fireAt(r, c));
      enemyGrid.appendChild(cell);
    }
  }
  updateTurnUI();
}

function selfCellEl(r, c) {
  return document.querySelector(`#grid-self .cell[data-r="${r}"][data-c="${c}"]`);
}
function enemyCellEl(r, c) {
  return document.querySelector(`#grid-enemy .cell[data-r="${r}"][data-c="${c}"]`);
}

function updateTurnUI() {
  const el = $('battle-turn');
  el.textContent = myTurn ? 'Ваш хід — стріляйте по флоту суперника' : 'Хід суперника — очікуйте';
  el.className = 'battle-turn ' + (myTurn ? 'my-turn' : 'opp-turn');
  $('grid-enemy').querySelectorAll('.cell').forEach((el) => {
    el.classList.toggle('disabled', !myTurn);
  });
}

function fireAt(r, c) {
  if (!myTurn) return;
  if (enemyShotsGrid[r][c]) return;
  sendMsg({ type: 'fire', r, c });
}

function markCell(el, cls) {
  if (!el) return;
  el.classList.remove('miss', 'hit', 'sunk');
  el.classList.add(cls);
}

// ---------- Message handling ----------
function handleMessage(msg) {
  switch (msg.type) {
    case 'created':
      myPlayer = msg.player;
      roomCode = msg.code;
      $('room-code').textContent = roomCode;
      showScreen('waiting');
      setStatus(`Кімната ${roomCode} створена. Ви — гравець 1.`);
      break;

    case 'joined':
      myPlayer = msg.player;
      roomCode = msg.code;
      setStatus(`Ви приєдналися до кімнати ${roomCode}. Ви — гравець 2.`);
      break;

    case 'error':
      $('menu-error').textContent = msg.message;
      break;

    case 'start_placement':
      resetPlacement();
      showScreen('placement');
      setStatus('Розставте кораблі та натисніть «Готово».');
      break;

    case 'placement_ok':
      setStatus('Кораблі прийнято сервером. Очікуємо суперника…');
      break;

    case 'opponent_ready':
      $('opp-ready-note').classList.remove('hidden');
      break;

    case 'battle_start':
      myTurn = msg.turn === myPlayer;
      buildBattleGrids();
      showScreen('battle');
      setStatus('Бій розпочався!');
      break;

    case 'fire_result': {
      const { by, r, c, result, shipCells, turn } = msg;
      const iAmShooter = by === myPlayer;
      if (iAmShooter) {
        const cls = result === 'miss' ? 'miss' : 'hit';
        markCell(enemyCellEl(r, c), cls);
        enemyShotsGrid[r][c] = cls;
        if (result === 'sunk' || result === 'win') {
          (shipCells || []).forEach(([sr, sc]) => {
            markCell(enemyCellEl(sr, sc), 'sunk');
            enemyShotsGrid[sr][sc] = 'sunk';
          });
        }
      } else {
        const cls = result === 'miss' ? 'miss' : 'hit';
        markCell(selfCellEl(r, c), cls);
        ownShotsGrid[r][c] = cls;
        if (result === 'sunk' || result === 'win') {
          (shipCells || []).forEach(([sr, sc]) => {
            markCell(selfCellEl(sr, sc), 'sunk');
            ownShotsGrid[sr][sc] = 'sunk';
          });
        }
      }
      myTurn = turn === myPlayer;
      updateTurnUI();
      break;
    }

    case 'game_over': {
      const iWon = msg.winner === myPlayer;
      $('over-title').textContent = iWon ? '🎉 Перемога! Ви розгромили флот суперника.' : '💥 Поразка. Ваш флот знищено.';
      $('rematch-note').classList.add('hidden');
      showScreen('over');
      setStatus('Гру завершено.');
      break;
    }

    case 'opponent_wants_rematch':
      $('rematch-note').classList.remove('hidden');
      break;

    case 'opponent_disconnected':
      setStatus('Суперник відключився.');
      alert('Суперник відключився від гри.');
      location.reload();
      break;
  }
}

$('btn-rematch').addEventListener('click', () => {
  sendMsg({ type: 'rematch' });
  $('btn-rematch').disabled = true;
});

$('btn-menu').addEventListener('click', () => location.reload());
