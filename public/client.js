'use strict';

const SIZE = 10;
const SHIP_LENGTHS = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
const COLS = 'АБВГДЕЖЗИК'.split(''); // 10 letters for column labels

// ---------- DOM helpers ----------
const $ = (id) => document.getElementById(id);
const screens = {
  resuming: $('screen-resuming'),
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

// ---------- Ship hull rendering ----------
// Paints a ship's cells so the group reads as one vessel (pointed bow,
// rounded stern, a deck line, and a small bridge block on longer ships)
// instead of a row of identical squares.
const SHIP_SHAPE_CLASSES = [
  'ship', 'ship-solo',
  'ship-h-start', 'ship-h-mid', 'ship-h-end',
  'ship-v-start', 'ship-v-mid', 'ship-v-end',
];

function clearShipShape(el) {
  if (!el) return;
  el.classList.remove(...SHIP_SHAPE_CLASSES);
  const cabin = el.querySelector('.ship-cabin');
  if (cabin) cabin.remove();
}

function paintShipHull(cells, cellElFn) {
  const sorted = [...cells].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const orientation = sorted.length === 1 ? 'solo' : (sorted[0][0] === sorted[1][0] ? 'h' : 'v');
  sorted.forEach(([r, c], i) => {
    const el = cellElFn(r, c);
    if (!el) return;
    el.classList.add('ship');
    if (orientation === 'solo') {
      el.classList.add('ship-solo');
    } else {
      const pos = i === 0 ? 'start' : (i === sorted.length - 1 ? 'end' : 'mid');
      el.classList.add(`ship-${orientation}-${pos}`);
    }
    // small bridge/superstructure block on the second segment of longer ships
    if (sorted.length >= 3 && i === 1 && !el.querySelector('.ship-cabin')) {
      const cabin = document.createElement('span');
      cabin.className = 'ship-cabin';
      el.appendChild(cabin);
    }
  });
}

const statusBar = $('status-bar');
function setStatus(text) { statusBar.textContent = text; }

const oppBanner = $('opp-status-banner');
function showOppBanner(text, ok) {
  oppBanner.textContent = text;
  oppBanner.classList.remove('hidden');
  oppBanner.classList.toggle('ok', !!ok);
}
function hideOppBanner() {
  oppBanner.classList.add('hidden');
}

// ---------- Saved session (survives accidental tab close / refresh / dropped wifi) ----------
const SESSION_KEY = 'seabattle_session';
function saveSession(data) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(data)); } catch { /* ignore (private mode etc.) */ }
}
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

// ---------- WebSocket ----------
const proto = location.protocol === 'https:' ? 'wss' : 'ws';
let ws;
let myPlayer = null; // 'p1' | 'p2'
let roomCode = null;
let hasHydrated = false; // true once the current screen has been built from real server state
let vsBot = false;

function setEnemyBoardTitle() {
  $('enemy-board-title').textContent = vsBot ? 'Флот бота 🤖' : 'Флот суперника';
}

function connect() {
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.addEventListener('open', () => {
    setStatus('Підключено до сервера');
    const saved = loadSession();
    if (saved && saved.code && saved.token) {
      showScreen('resuming');
      sendMsg({ type: 'resume', code: saved.code, token: saved.token });
    }
  });
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

// Show the "resuming" screen immediately (before the socket even connects) so
// returning players don't see a flash of the main menu first.
if (loadSession()) {
  showScreen('resuming');
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
$('btn-create-bot').addEventListener('click', () => {
  $('menu-error').textContent = '';
  sendMsg({ type: 'create_bot' });
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

function backToMenu() {
  myPlayer = null;
  roomCode = null;
  hasHydrated = false;
  vsBot = false;
  clearSession();
  hideOppBanner();
  $('input-code').value = '';
  $('menu-error').textContent = '';
  showScreen('menu');
  setStatus('Підключено до сервера');
}

$('btn-cancel-waiting').addEventListener('click', () => {
  sendMsg({ type: 'leave' });
  backToMenu();
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

// Rebuild the placement screen showing an already-submitted fleet as read-only
// (used when resuming a session where this player had already clicked "Готово").
function restorePlacementReady(shipsCells) {
  placedShips = shipsCells.map((cells) => ({ cells }));
  occupiedSet = new Set();
  placedShips.forEach((s) => s.cells.forEach(([r, c]) => occupiedSet.add(`${r},${c}`)));
  rotation = 'h';
  shipQueue = [];
  renderFleetStatus();
  buildOwnGrid();
  $('btn-ready').disabled = true;
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
  document.querySelectorAll('#grid-own .cell').forEach(clearShipShape);
  for (const ship of placedShips) {
    paintShipHull(ship.cells, ownCellEl);
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

function buildBattleGrids() {
  ownShotsGrid = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  enemyShotsGrid = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));

  const selfGrid = $('grid-self');
  selfGrid.innerHTML = '';
  selfGrid.classList.add('grid-small');
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      selfGrid.appendChild(cell);
    }
  }
  placedShips.forEach((s) => paintShipHull(s.cells, selfCellEl));

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

// Rebuild the battle screen from a server-provided snapshot (used on resume):
// replays every past shot on both boards so the UI looks exactly as it did
// before the player disconnected.
function buildBattleGridsFromSnapshot(msg) {
  placedShips = (msg.myShips || []).map((cells) => ({ cells }));
  buildBattleGrids();

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const against = msg.myShotsReceived[r][c];
      if (against) {
        const cls = against === 'miss' ? 'miss' : 'hit';
        markCell(selfCellEl(r, c), cls);
        ownShotsGrid[r][c] = cls;
      }
      const onOpp = msg.myShotsOnOpp[r][c];
      if (onOpp) {
        const cls = onOpp === 'miss' ? 'miss' : 'hit';
        markCell(enemyCellEl(r, c), cls);
        enemyShotsGrid[r][c] = cls;
      }
    }
  }

  // own ships that are fully hit get the "sunk" skull styling
  for (const ship of placedShips) {
    const allHit = ship.cells.every(([r, c]) => msg.myShotsReceived[r][c]);
    if (allHit) {
      ship.cells.forEach(([r, c]) => {
        markCell(selfCellEl(r, c), 'sunk');
        ownShotsGrid[r][c] = 'sunk';
      });
    }
  }

  // server tells us exactly which enemy ships we've sunk
  (msg.sunkEnemyShips || []).forEach((cells) => {
    cells.forEach(([r, c]) => {
      markCell(enemyCellEl(r, c), 'sunk');
      enemyShotsGrid[r][c] = 'sunk';
    });
    paintShipHull(cells, enemyCellEl);
  });
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

// Plays a one-shot explosion/splash/sinking animation over a cell. Purely
// cosmetic — only called for shots that just happened live, never when
// silently rebuilding the board after a resume/reload.
function spawnImpactFx(el, kind) {
  if (!el) return;
  const fx = document.createElement('div');
  fx.className = `fx fx-${kind}`;
  if (kind === 'miss') {
    fx.innerHTML = '<span class="fx-splash-ring"></span><span class="fx-splash-ring fx-splash-ring2"></span>';
  } else {
    const sparkCount = kind === 'sunk' ? 8 : 6;
    let sparks = '';
    for (let i = 0; i < sparkCount; i++) {
      sparks += `<span class="fx-spark" style="--angle:${Math.round((360 / sparkCount) * i)}deg"></span>`;
    }
    let bubbles = '';
    if (kind === 'sunk') {
      for (let i = 0; i < 4; i++) {
        bubbles += `<span class="fx-bubble" style="--bx:${15 + i * 22}%; animation-delay:${260 + i * 90}ms"></span>`;
      }
    }
    fx.innerHTML = `<span class="fx-ring"></span><span class="fx-core"></span>${sparks}${bubbles}`;
  }
  el.appendChild(fx);
  const impactClass = kind === 'sunk' ? 'impact-sunk' : kind === 'hit' ? 'impact-hit' : 'impact-miss';
  el.classList.add(impactClass);
  const cleanupDelay = kind === 'sunk' ? 900 : 550;
  setTimeout(() => {
    fx.remove();
    el.classList.remove(impactClass);
  }, cleanupDelay);
}

// ---------- Message handling ----------
function handleMessage(msg) {
  switch (msg.type) {
    case 'created':
      myPlayer = msg.player;
      roomCode = msg.code;
      hasHydrated = true;
      vsBot = false;
      setEnemyBoardTitle();
      saveSession({ code: msg.code, token: msg.token, player: msg.player });
      $('room-code').textContent = roomCode;
      showScreen('waiting');
      setStatus(`Кімната ${roomCode} створена. Ви — гравець 1.`);
      break;

    case 'joined':
      myPlayer = msg.player;
      roomCode = msg.code;
      hasHydrated = true;
      vsBot = false;
      setEnemyBoardTitle();
      saveSession({ code: msg.code, token: msg.token, player: msg.player });
      setStatus(`Ви приєдналися до кімнати ${roomCode}. Ви — гравець 2.`);
      break;

    case 'bot_created':
      myPlayer = msg.player;
      roomCode = msg.code;
      hasHydrated = true;
      vsBot = true;
      saveSession({ code: msg.code, token: msg.token, player: msg.player, vsBot: true });
      setEnemyBoardTitle();
      resetPlacement();
      showScreen('placement');
      setStatus('Гра проти бота. Розставте кораблі та натисніть «Готово».');
      break;

    case 'error':
      $('menu-error').textContent = msg.message;
      break;

    case 'resumed': {
      myPlayer = msg.player;
      roomCode = msg.code;
      vsBot = !!msg.oppIsBot;
      setEnemyBoardTitle();
      hideOppBanner();
      if (!msg.oppConnected && msg.oppPresent && (msg.phase === 'placement' || msg.phase === 'battle')) {
        showOppBanner('Суперник наразі офлайн — очікуємо, поки він повернеться…');
      }

      if (msg.phase === 'waiting') {
        $('room-code').textContent = roomCode;
        showScreen('waiting');
        setStatus(`Кімната ${roomCode}. Очікуємо суперника…`);
      } else if (msg.phase === 'placement') {
        if (msg.amReady && msg.myShips) {
          restorePlacementReady(msg.myShips);
        } else if (!hasHydrated || placedShips.length === 0) {
          resetPlacement();
        } // else: keep whatever the player was already placing locally (quiet reconnect)
        $('opp-ready-note').classList.toggle('hidden', !msg.oppReady);
        showScreen('placement');
        setStatus('Розставте кораблі та натисніть «Готово».');
      } else if (msg.phase === 'battle') {
        myTurn = msg.turn === myPlayer;
        buildBattleGridsFromSnapshot(msg);
        showScreen('battle');
        setStatus('Бій триває — з поверненням!');
      } else if (msg.phase === 'over') {
        const iWon = msg.winner === myPlayer;
        $('over-title').textContent = iWon
          ? '🎉 Перемога! Ви розгромили флот суперника.'
          : '💥 Поразка. Ваш флот знищено.';
        $('rematch-note').classList.add('hidden');
        showScreen('over');
        setStatus('Гру завершено.');
      }
      hasHydrated = true;
      break;
    }

    case 'resume_failed':
      clearSession();
      backToMenu();
      $('menu-error').textContent = msg.message;
      break;

    case 'start_placement':
      resetPlacement();
      hideOppBanner();
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
      const cellFor = iAmShooter ? enemyCellEl : selfCellEl;
      const gridFor = iAmShooter ? enemyShotsGrid : ownShotsGrid;
      if (result === 'sunk' || result === 'win') {
        // reveal + animate every cell of the ship that just went down
        const cells = shipCells && shipCells.length ? shipCells : [[r, c]];
        cells.forEach(([sr, sc]) => {
          const el = cellFor(sr, sc);
          markCell(el, 'sunk');
          gridFor[sr][sc] = 'sunk';
          spawnImpactFx(el, 'sunk');
        });
        paintShipHull(cells, cellFor); // own ships are already painted; this reveals a sunk enemy hull
      } else {
        const cls = result === 'miss' ? 'miss' : 'hit';
        const el = cellFor(r, c);
        markCell(el, cls);
        gridFor[r][c] = cls;
        spawnImpactFx(el, cls);
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

    case 'opponent_connection_lost':
      // Soft signal: the opponent's connection dropped, but the game state is
      // preserved server-side — they have a few minutes to reconnect. Don't
      // interrupt the current screen, just let the player know.
      showOppBanner('Суперник тимчасово втратив з’єднання — очікуємо, поки він повернеться…');
      break;

    case 'opponent_reconnected':
      showOppBanner('Суперник повернувся!', true);
      setTimeout(hideOppBanner, 2500);
      break;

    case 'opponent_gave_up':
      hideOppBanner();
      clearSession();
      setStatus('Суперник не повернувся вчасно — гру завершено.');
      alert('Суперник не повернувся вчасно. Гру завершено.');
      backToMenu();
      break;

    case 'opponent_left':
      setStatus('Суперник скасував гру.');
      alert('Суперник скасував гру.');
      backToMenu();
      break;
  }
}

$('btn-rematch').addEventListener('click', () => {
  sendMsg({ type: 'rematch' });
  $('btn-rematch').disabled = true;
});

$('btn-menu').addEventListener('click', () => {
  clearSession();
  location.reload();
});
