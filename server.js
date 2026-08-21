'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- Static file server ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, reqPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- Game logic ----------

const SIZE = 10;
// Класичний набір кораблів: 1x4, 2x3, 3x2, 4x1
const SHIP_LENGTHS = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
// Скільки часу гравець може бути офлайн (втрата з'єднання, перезавантаження
// сторінки, закриття вкладки), перш ніж суперник вважатиме гру завершеною.
const RECONNECT_GRACE_MS = 5 * 60 * 1000;

function emptyGrid() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
}

function inBounds(r, c) {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

function validateShips(ships) {
  if (!Array.isArray(ships) || ships.length !== SHIP_LENGTHS.length) return null;

  const lengths = ships.map((s) => (Array.isArray(s.cells) ? s.cells.length : -1)).sort((a, b) => a - b);
  const expected = [...SHIP_LENGTHS].sort((a, b) => a - b);
  if (JSON.stringify(lengths) !== JSON.stringify(expected)) return null;

  const grid = emptyGrid();
  const occupied = new Set();

  for (const ship of ships) {
    const cells = ship.cells;
    for (const cell of cells) {
      if (!Array.isArray(cell) || cell.length !== 2) return null;
      const [r, c] = cell;
      if (!Number.isInteger(r) || !Number.isInteger(c) || !inBounds(r, c)) return null;
    }
    // contiguous straight line check
    const rows = cells.map((c) => c[0]);
    const cols = cells.map((c) => c[1]);
    const sameRow = rows.every((r) => r === rows[0]);
    const sameCol = cols.every((c) => c === cols[0]);
    if (cells.length > 1 && !sameRow && !sameCol) return null;
    if (sameRow) {
      const sorted = [...cols].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] !== sorted[i - 1] + 1) return null;
      }
    }
    if (sameCol) {
      const sorted = [...rows].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] !== sorted[i - 1] + 1) return null;
      }
    }

    // no-touch (including diagonally) against previously placed ships
    for (const [r, c] of cells) {
      const key = `${r},${c}`;
      if (occupied.has(key)) return null; // overlap
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr,
            nc = c + dc;
          if (inBounds(nr, nc) && grid[nr][nc] && grid[nr][nc] !== ship) {
            // touching a different ship
            if (!cells.some(([cr, cc]) => cr === nr && cc === nc)) return null;
          }
        }
      }
    }
    for (const [r, c] of cells) {
      grid[r][c] = ship;
      occupied.add(`${r},${c}`);
    }
  }

  return ships.map((s) => ({ cells: s.cells, hits: new Set() }));
}

// Generates a random, rules-legal fleet (no overlaps, no touching ships) —
// used to auto-place the bot's ships. Re-validated through validateShips so
// the bot is held to exactly the same rules as a human player.
function generateRandomShips() {
  const occupied = new Set();
  const placed = [];
  function neighbors(cells) {
    const set = new Set();
    for (const [r, c] of cells) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr,
            nc = c + dc;
          if (inBounds(nr, nc)) set.add(`${nr},${nc}`);
        }
      }
    }
    return set;
  }
  function canPlace(cells) {
    for (const [r, c] of cells) {
      if (!inBounds(r, c) || occupied.has(`${r},${c}`)) return false;
    }
    for (const key of neighbors(cells)) {
      if (occupied.has(key) && !cells.some(([r, c]) => `${r},${c}` === key)) return false;
    }
    return true;
  }
  for (const len of SHIP_LENGTHS) {
    let ok = false;
    let attempts = 0;
    while (!ok && attempts < 2000) {
      attempts++;
      const horiz = Math.random() < 0.5;
      const r = crypto.randomInt(SIZE);
      const c = crypto.randomInt(SIZE);
      const cells = [];
      for (let i = 0; i < len; i++) cells.push(horiz ? [r, c + i] : [r + i, c]);
      if (canPlace(cells)) {
        placed.push({ cells });
        cells.forEach(([r, c]) => occupied.add(`${r},${c}`));
        ok = true;
      }
    }
    if (!ok) return generateRandomShips(); // extremely unlikely; just retry from scratch
  }
  return placed;
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function makeToken() {
  return crypto.randomBytes(12).toString('hex');
}

function newPlayer(ws) {
  return {
    ws,
    token: makeToken(), // secret used by this player's browser to reconnect to this exact seat
    ships: null, // validated ship list with hit tracking
    shotsReceived: emptyGrid(), // what opponent has fired at us: 'hit' | 'miss'
    ready: false,
    rematchWanted: false,
    connected: true,
    disconnectedAt: null,
  };
}

function newBotPlayer(difficulty) {
  return {
    ws: null,
    isBot: true,
    difficulty: difficulty === 'easy' ? 'easy' : 'smart', // 'easy' fires blind; 'smart' hunts with the heatmap AI below
    token: null,
    ships: null,
    shotsReceived: emptyGrid(),
    ready: false,
    rematchWanted: true, // the bot always accepts a rematch instantly
    connected: true, // a bot is never "disconnected"
    disconnectedAt: null,
    ai: freshBotAI(),
  };
}

// A room where the opponent seat is a bot player rather than a real socket.
function roomShouldBeDeleted(room) {
  const p1 = room.players.p1;
  const p2 = room.players.p2;
  const p1Real = p1 && !p1.isBot;
  const p2Real = p2 && !p2.isBot;
  return !p1Real && !p2Real;
}

// ---------- Bot AI (probability-density hunt / directional target) ----------
// kept in sync manually with test/bot-ai-sim.js

function freshBotAI() {
  return {
    mode: 'hunt',
    hits: [],
    queue: [],
    direction: null,
    remaining: [...SHIP_LENGTHS], // lengths of ships not yet confirmed sunk
    dead: new Set(), // cells known empty (no-touch buffer around sunk ships) — never worth firing at
  };
}

function botBlocked(tried, ai, r, c) {
  if (!inBounds(r, c)) return true;
  if (tried[r][c]) return true;
  if (ai.dead.has(`${r},${c}`)) return true;
  return false;
}

// Picks the bot's next shot against `target` (the human player object),
// using its own shotsReceived grid as the source of truth for "already tried".
function pickBotMove(target, ai) {
  const tried = target.shotsReceived;

  // Target mode: we have a live hit and are hunting down the rest of that ship.
  while (ai.mode === 'target' && ai.queue.length) {
    const [r, c] = ai.queue.shift();
    if (!botBlocked(tried, ai, r, c)) return [r, c];
  }
  if (ai.mode === 'target' && !ai.queue.length) {
    // ran out of leads without sinking the ship (edge of board) — fall back to hunting
    ai.mode = 'hunt';
    ai.hits = [];
    ai.direction = null;
  }

  // Hunt mode: probability-density search. For every remaining (not-yet-sunk)
  // ship length, count how many horizontal/vertical placements could still fit
  // through each untried cell (skipping cells already fired on or known dead
  // from the no-touch rule around sunk ships), then fire at a cell with the
  // highest count. This is the classic "heatmap" approach and meaningfully
  // outperforms blind/checkerboard hunting, especially once ships start getting
  // sunk and their dead zones shrink the search space.
  const lengths = ai.remaining.length ? ai.remaining : SHIP_LENGTHS;
  const scores = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  const cellBlocked = (r, c) => !!tried[r][c] || ai.dead.has(`${r},${c}`);
  let anyScore = false;
  for (const len of lengths) {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c <= SIZE - len; c++) {
        let fits = true;
        for (let i = 0; i < len; i++) {
          if (cellBlocked(r, c + i)) {
            fits = false;
            break;
          }
        }
        if (!fits) continue;
        for (let i = 0; i < len; i++) {
          scores[r][c + i]++;
          anyScore = true;
        }
      }
    }
    if (len > 1) {
      for (let c = 0; c < SIZE; c++) {
        for (let r = 0; r <= SIZE - len; r++) {
          let fits = true;
          for (let i = 0; i < len; i++) {
            if (cellBlocked(r + i, c)) {
              fits = false;
              break;
            }
          }
          if (!fits) continue;
          for (let i = 0; i < len; i++) {
            scores[r + i][c]++;
            anyScore = true;
          }
        }
      }
    }
  }
  const bestCells = [];
  let best = -1;
  if (anyScore) {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (cellBlocked(r, c)) continue;
        const s = scores[r][c];
        if (s > best) {
          best = s;
          bestCells.length = 0;
          bestCells.push([r, c]);
        } else if (s === best) bestCells.push([r, c]);
      }
    }
  } else {
    // Shouldn't normally happen (would mean our bookkeeping is out of sync),
    // but never leave the bot stuck — fall back to any untried, non-dead cell.
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (!cellBlocked(r, c)) bestCells.push([r, c]);
      }
    }
  }
  if (!bestCells.length) return null; // board fully tried (shouldn't happen before game ends)
  return bestCells[crypto.randomInt(bestCells.length)];
}

// 'Легкий' бот: жодного полювання чи прицілювання — просто випадкова
// невипробувана клітинка щоразу, навіть одразу після влучання.
function pickBotMoveEasy(target) {
  const tried = target.shotsReceived;
  const cells = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!tried[r][c]) cells.push([r, c]);
    }
  }
  if (!cells.length) return null;
  return cells[crypto.randomInt(cells.length)];
}

// Marks every cell touching (including diagonally) the given ship's cells as
// "dead" — guaranteed empty, since ships can never touch under this game's
// placement rules. Lets the hunt phase skip them without wasting a real shot.
function markDeadAround(ai, cells) {
  for (const [r, c] of cells) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const nr = r + dr,
          nc = c + dc;
        if (inBounds(nr, nc)) ai.dead.add(`${nr},${nc}`);
      }
    }
  }
}

// Updates the bot's AI state after seeing the result of its own shot.
function updateBotAI(ai, r, c, result) {
  if (result === 'sunk' || result === 'win') {
    const shipCells = [...ai.hits, [r, c]];
    const sunkLen = shipCells.length;
    const idx = ai.remaining.indexOf(sunkLen);
    if (idx !== -1) ai.remaining.splice(idx, 1);
    markDeadAround(ai, shipCells);
    ai.mode = 'hunt';
    ai.hits = [];
    ai.queue = [];
    ai.direction = null;
    return;
  }
  if (result === 'miss') {
    // if we were following a discovered direction, dropping a miss just means
    // "stop extending that end" — the queue naturally moves on to other leads.
    return;
  }
  // hit, ship not yet sunk
  ai.hits.push([r, c]);
  if (ai.hits.length === 1) {
    ai.mode = 'target';
    ai.direction = null;
    const candidates = [
      [r - 1, c],
      [r + 1, c],
      [r, c - 1],
      [r, c + 1],
    ];
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    ai.queue = candidates;
    return;
  }
  if (!ai.direction) {
    const [fr, fc] = ai.hits[0];
    ai.direction = fr === r ? 'h' : 'v';
    // once we know the line, drop candidates that don't lie on it
    ai.queue = ai.queue.filter(([qr, qc]) => (ai.direction === 'h' ? qr === fr : qc === fc));
  }
  // extend further past this new hit, in the same direction
  const rows = ai.hits.map(([hr]) => hr);
  const cols = ai.hits.map(([, hc]) => hc);
  if (ai.direction === 'h') {
    const row = rows[0];
    ai.queue.push([row, Math.min(...cols) - 1], [row, Math.max(...cols) + 1]);
  } else {
    const col = cols[0];
    ai.queue.push([Math.min(...rows) - 1, col], [Math.max(...rows) + 1, col]);
  }
}

// What a reconnecting client needs to fully rebuild the UI it left behind.
function buildResumeSnapshot(room, myKey) {
  const me = room.players[myKey];
  const opp = room.players[otherKey(myKey)];
  const sunkEnemyShips =
    opp && opp.ships ? opp.ships.filter((s) => s.hits.size === s.cells.length).map((s) => s.cells) : [];
  return {
    type: 'resumed',
    code: room.code,
    player: myKey,
    phase: room.phase,
    turn: room.turn,
    winner: room.winner || null,
    amReady: !!me.ready,
    myShips: me.ships ? me.ships.map((s) => s.cells) : null,
    myShotsReceived: me.shotsReceived, // shots the opponent has fired at me
    myShotsOnOpp: opp ? opp.shotsReceived : emptyGrid(), // my shots fired at the opponent
    sunkEnemyShips,
    oppConnected: !!(opp && opp.connected),
    oppReady: !!(opp && opp.ready),
    oppPresent: !!opp,
    oppIsBot: !!(opp && opp.isBot),
  };
}

const rooms = new Map(); // code -> room

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function otherKey(key) {
  return key === 'p1' ? 'p2' : 'p1';
}

function broadcastRoom(room, msg) {
  if (room.players.p1) send(room.players.p1.ws, msg);
  if (room.players.p2) send(room.players.p2.ws, msg);
}

function allShipsSunk(player) {
  return player.ships.every((s) => s.hits.size === s.cells.length);
}

// Core of a single shot, shared by human 'fire' messages and the bot's
// automated moves so both are governed by exactly the same rules.
function performFire(room, shooterKey, r, c) {
  const opp = room.players[otherKey(shooterKey)];

  let result = 'miss';
  let sunkShip = null;
  for (const ship of opp.ships) {
    if (ship.cells.some(([sr, sc]) => sr === r && sc === c)) {
      ship.hits.add(`${r},${c}`);
      result = ship.hits.size === ship.cells.length ? 'sunk' : 'hit';
      if (result === 'sunk') sunkShip = ship;
      break;
    }
  }
  opp.shotsReceived[r][c] = result === 'miss' ? 'miss' : 'hit';

  const win = result !== 'miss' && allShipsSunk(opp);
  if (result === 'miss') {
    room.turn = otherKey(shooterKey);
  }
  // on hit or sunk, same player continues (turn unchanged)

  broadcastRoom(room, {
    type: 'fire_result',
    by: shooterKey,
    r,
    c,
    result: win ? 'win' : result,
    shipCells: sunkShip ? sunkShip.cells : undefined,
    turn: room.turn,
  });

  if (win) {
    room.phase = 'over';
    room.winner = shooterKey;
    broadcastRoom(room, { type: 'game_over', winner: shooterKey });
  }

  return { result: win ? 'win' : result, win };
}

// If it's the bot's turn, schedule its next shot after a short human-feeling
// delay. Safe to call unconditionally after any state change.
function scheduleBotMove(room) {
  if (room.phase !== 'battle') return;
  const botKey = ['p1', 'p2'].find((k) => room.players[k] && room.players[k].isBot);
  if (!botKey || room.turn !== botKey) return;
  const bot = room.players[botKey];
  const target = room.players[otherKey(botKey)];
  if (!target) return;

  setTimeout(
    () => {
      // re-check everything: the room/game may have moved on while we waited
      if (room.phase !== 'battle' || room.turn !== botKey) return;
      if (!rooms.get(room.code) || rooms.get(room.code) !== room) return;
      const move = bot.difficulty === 'easy' ? pickBotMoveEasy(target) : pickBotMove(target, bot.ai);
      if (!move) return;
      const [r, c] = move;
      const { result } = performFire(room, botKey, r, c);
      if (bot.difficulty !== 'easy') updateBotAI(bot.ai, r, c, result);
      scheduleBotMove(room); // keeps firing on its own turn (hit → shoot again)
    },
    550 + crypto.randomInt(450),
  );
}

function resetRoomForRematch(room) {
  for (const key of ['p1', 'p2']) {
    const p = room.players[key];
    if (!p) continue;
    p.ships = null;
    p.shotsReceived = emptyGrid();
    p.ready = false;
    if (p.isBot) p.ai = freshBotAI();
  }
  room.phase = 'placement';
  room.turn = 'p1';
  room.winner = null;
}

// ---------- Rate limiting ----------
// Cheap per-connection sliding-window limiter. Scoped to stop a single
// misbehaving client from flooding room creation, brute-forcing 4-char room
// codes, or spamming shots — not a substitute for a real edge/WAF rate
// limiter if this ever sees real public traffic at scale, since a
// determined attacker can still open many connections. Good enough for a
// hobby-scale deployment without adding an external dependency.
function makeRateLimiter(maxEvents, windowMs) {
  const timestamps = [];
  return function allow() {
    const now = Date.now();
    while (timestamps.length && now - timestamps[0] > windowMs) timestamps.shift();
    if (timestamps.length >= maxEvents) return false;
    timestamps.push(now);
    return true;
  };
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // create/create_bot/join is one bucket (room churn / code-guessing); fire
  // is separate and more generous since rapid clicking during real play is normal.
  const roomLimiter = makeRateLimiter(10, 60000); // 10 per minute
  const fireLimiter = makeRateLimiter(40, 10000); // 40 per 10s

  let roomCode = null;
  let myKey = null; // 'p1' | 'p2'

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'create' || msg.type === 'create_bot' || msg.type === 'join') {
      if (!roomLimiter()) {
        send(ws, { type: 'error', message: 'Забагато спроб поспіль. Зачекайте трохи і спробуйте ще раз.' });
        return;
      }
    }

    if (msg.type === 'create') {
      const code = makeRoomCode();
      const room = {
        code,
        players: { p1: newPlayer(ws), p2: null },
        phase: 'waiting', // waiting -> placement -> battle -> over
        turn: 'p1',
      };
      rooms.set(code, room);
      roomCode = code;
      myKey = 'p1';
      send(ws, { type: 'created', code, player: 'p1', token: room.players.p1.token });
      return;
    }

    if (msg.type === 'create_bot') {
      const difficulty = msg.difficulty === 'easy' ? 'easy' : 'smart';
      const code = makeRoomCode();
      const room = {
        code,
        players: { p1: newPlayer(ws), p2: newBotPlayer(difficulty) },
        phase: 'placement', // the "seat" is already filled, so skip the waiting room entirely
        turn: 'p1',
      };
      rooms.set(code, room);
      roomCode = code;
      myKey = 'p1';
      send(ws, { type: 'bot_created', code, player: 'p1', token: room.players.p1.token, difficulty });
      return;
    }

    if (msg.type === 'join') {
      const code = String(msg.code || '')
        .toUpperCase()
        .trim();
      const room = rooms.get(code);
      if (!room) {
        send(ws, { type: 'error', message: 'Кімнату не знайдено. Перевірте код.' });
        return;
      }
      if (room.players.p2 && room.players.p2.connected) {
        send(ws, { type: 'error', message: 'Кімната вже заповнена.' });
        return;
      }
      room.players.p2 = newPlayer(ws);
      roomCode = code;
      myKey = 'p2';
      room.phase = 'placement';
      send(ws, { type: 'joined', code, player: 'p2', token: room.players.p2.token });
      broadcastRoom(room, { type: 'start_placement' });
      return;
    }

    if (msg.type === 'resume') {
      const code = String(msg.code || '')
        .toUpperCase()
        .trim();
      const token = String(msg.token || '');
      const room = rooms.get(code);
      if (!room) {
        send(ws, { type: 'resume_failed', message: 'Цю гру не знайдено — можливо, вона вже завершилась.' });
        return;
      }
      const foundKey = ['p1', 'p2'].find((k) => room.players[k] && room.players[k].token === token);
      if (!foundKey) {
        send(ws, { type: 'resume_failed', message: 'Не вдалося відновити сесію цієї гри.' });
        return;
      }
      const me = room.players[foundKey];
      me.ws = ws;
      me.connected = true;
      me.disconnectedAt = null;
      roomCode = code;
      myKey = foundKey;

      send(ws, buildResumeSnapshot(room, foundKey));

      const opp = room.players[otherKey(foundKey)];
      if (opp && opp.connected) {
        send(opp.ws, { type: 'opponent_reconnected' });
      }
      return;
    }

    if (msg.type === 'leave') {
      if (roomCode && myKey) {
        const room = rooms.get(roomCode);
        if (room) {
          const opp = room.players[otherKey(myKey)];
          room.players[myKey] = null;
          if (opp && !opp.isBot) send(opp.ws, { type: 'opponent_left' });
          if (roomShouldBeDeleted(room)) rooms.delete(roomCode);
        }
      }
      roomCode = null;
      myKey = null;
      return;
    }

    const room = rooms.get(roomCode);
    if (!room || !myKey) return;
    const me = room.players[myKey];
    if (!me) return;
    const opp = room.players[otherKey(myKey)];

    if (msg.type === 'place') {
      const validated = validateShips(msg.ships);
      if (!validated) {
        send(ws, { type: 'error', message: 'Некоректне розташування кораблів.' });
        return;
      }
      me.ships = validated;
      me.ready = true;
      send(ws, { type: 'placement_ok' });

      if (opp && opp.isBot && !opp.ready) {
        opp.ships = validateShips(generateRandomShips());
        opp.ready = true;
      } else if (opp) {
        send(opp.ws, { type: 'opponent_ready' });
      }

      if (opp && me.ready && opp.ready) {
        room.phase = 'battle';
        room.turn = 'p1';
        broadcastRoom(room, { type: 'battle_start', turn: room.turn });
        scheduleBotMove(room);
      }
      return;
    }

    if (msg.type === 'fire') {
      if (!fireLimiter()) {
        send(ws, { type: 'error', message: 'Забагато пострілів поспіль. Зачекайте секунду.' });
        return;
      }
      if (room.phase !== 'battle') return;
      if (room.turn !== myKey) {
        send(ws, { type: 'error', message: 'Зараз не ваш хід.' });
        return;
      }
      const { r, c } = msg;
      if (!Number.isInteger(r) || !Number.isInteger(c) || !inBounds(r, c)) return;
      if (opp.shotsReceived[r][c]) {
        send(ws, { type: 'error', message: 'Сюди вже стріляли.' });
        return;
      }

      performFire(room, myKey, r, c);
      scheduleBotMove(room);
      return;
    }

    if (msg.type === 'rematch') {
      if (opp && opp.isBot) {
        resetRoomForRematch(room);
        broadcastRoom(room, { type: 'start_placement' });
        return;
      }
      me.rematchWanted = true;
      if (opp) send(opp.ws, { type: 'opponent_wants_rematch' });
      if (opp && opp.rematchWanted) {
        me.rematchWanted = false;
        opp.rematchWanted = false;
        resetRoomForRematch(room);
        broadcastRoom(room, { type: 'start_placement' });
      }
      return;
    }
  });

  ws.on('close', () => {
    if (!roomCode || !myKey) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    const me = room.players[myKey];
    if (!me) return;
    // Only treat this as a real disconnect if no newer connection (a resume)
    // has already taken over this seat.
    if (me.ws !== ws) return;

    me.connected = false;
    me.disconnectedAt = Date.now();
    const disconnectedKey = myKey;

    const opp = room.players[otherKey(disconnectedKey)];
    if (opp && opp.connected) {
      // Soft signal: the game keeps its state, just wait — the player may
      // reconnect (page refresh, dropped wifi, closed tab by accident) within
      // the grace window below.
      send(opp.ws, { type: 'opponent_connection_lost' });
    }

    setTimeout(() => {
      const r = rooms.get(roomCode);
      if (!r) return;
      const stillGone = r.players[disconnectedKey];
      if (!stillGone || stillGone.connected) return; // they came back — nothing to do

      const stillOpp = r.players[otherKey(disconnectedKey)];
      if (stillOpp && stillOpp.connected) {
        send(stillOpp.ws, { type: 'opponent_gave_up' });
      }
      r.players[disconnectedKey] = null;
      if (roomShouldBeDeleted(r)) rooms.delete(roomCode);
    }, RECONNECT_GRACE_MS);
  });
});

// heartbeat to drop dead connections
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(interval));

server.listen(PORT, () => {
  console.log(`Sea Battle server listening on port ${PORT}`);
});

// ---------- Graceful shutdown ----------
// A deploy/restart (e.g. Render pushing a new version) sends SIGTERM. Give
// connected players a heads-up before the socket actually drops, instead of
// silently vanishing — the client already retries the connection on its own,
// and the room state briefly survives a resume once the new process is up
// (rooms live in memory only, so this is a courtesy message, not real
// persistence across the restart itself).
let shuttingDown = false;
function shutdownGracefully(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal} — notifying ${wss.clients.size} client(s) and shutting down…`);
  wss.clients.forEach((ws) => {
    send(ws, {
      type: 'server_restarting',
      message: 'Сервер оновлюється. Через хвилину спробуємо перепідключити вас автоматично.',
    });
  });
  // Give the messages a brief moment to actually flush over the sockets
  // before tearing anything down.
  setTimeout(() => {
    clearInterval(interval);
    server.close(() => process.exit(0));
    wss.clients.forEach((ws) => ws.close(1001, 'Server restarting'));
    // Belt-and-braces: force-exit shortly after in case something (a slow
    // client, a half-open socket) keeps the process alive past close().
    setTimeout(() => process.exit(0), 3000).unref();
  }, 300);
}
process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
process.on('SIGINT', () => shutdownGracefully('SIGINT'));
