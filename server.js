'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- Optional Redis-backed room persistence ----------
// Rooms normally live only in the Node process's memory, so any restart
// (deploy, crash, a free-tier host putting the dyno to sleep) instantly
// wipes every active game. If a REDIS_URL is configured we mirror room
// state into Redis on every meaningful change and reload it at boot, so
// players can resume mid-game after a restart. With no REDIS_URL set this
// whole layer is a no-op and behavior is identical to before — no external
// dependency required for a small/local deployment.
let Redis = null;
try {
  Redis = require('ioredis');
} catch {
  // ioredis not installed — fine, persistence is simply unavailable.
}
const REDIS_URL = process.env.REDIS_URL || '';
const ROOM_TTL_SECONDS = 24 * 60 * 60; // abandoned rooms expire from Redis after a day
const redisKeyFor = (code) => `seabattle:room:${code}`;
const LEADERBOARD_REDIS_KEY = 'seabattle:leaderboard';

let redis = null;
if (REDIS_URL) {
  if (!Redis) {
    console.warn('[redis] REDIS_URL задано, але пакет ioredis не встановлено — персистентність вимкнена.');
  } else {
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
    redis.on('error', (err) => console.error('[redis] помилка з’єднання:', err.message));
    redis.on('connect', () => console.log('[redis] підключено, стан кімнат зберігатиметься'));
  }
}

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

// Скільки поспіль невдалих спроб приєднання (неіснуючий код) вважається
// підбором коду, і на скільки блокувати приєднання з цього з'єднання після
// цього. Налаштовується через env лише для того, щоб тести не чекали
// реальні 30 секунд.
const JOIN_LOCKOUT_THRESHOLD = 5;
const JOIN_LOCKOUT_MS = Number(process.env.SEABATTLE_JOIN_LOCKOUT_MS) || 30000;

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

// Filtered by char code rather than a regex control-character class, so the
// source has no literal control bytes for tools/diffs to trip over. Shared
// by the nickname and in-game chat sanitizers below.
function stripControlChars(raw) {
  return Array.from(String(raw || ''))
    .filter((ch) => {
      const code = ch.codePointAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join('');
}

// Trims, strips control characters, and caps length so a nickname is always
// safe to store, persist, and render as plain text on the leaderboard.
const MAX_NICKNAME_LENGTH = 20;
function sanitizeNickname(raw) {
  const cleaned = stripControlChars(raw).trim().slice(0, MAX_NICKNAME_LENGTH);
  return cleaned || 'Капітан';
}

// In-game chat: free text between the two players in a room, capped and
// stripped the same way as a nickname (never persisted, never sent
// anywhere except the room's own two sockets).
const MAX_CHAT_LENGTH = 200;
function sanitizeChatText(raw) {
  return stripControlChars(raw).trim().slice(0, MAX_CHAT_LENGTH);
}

// Emoji quick-reactions are restricted to a fixed allow-list rather than
// free text, so this channel can never be used to smuggle arbitrary content.
const CHAT_EMOJI = ['👍', '😂', '😱', '🔥', '🎯', '🙌'];

function newPlayer(ws, nickname) {
  return {
    ws,
    token: makeToken(), // secret used by this player's browser to reconnect to this exact seat
    nickname: sanitizeNickname(nickname),
    ships: null, // validated ship list with hit tracking
    shotsReceived: emptyGrid(), // what opponent has fired at us: 'hit' | 'miss'
    ready: false,
    rematchWanted: false,
    connected: true,
    disconnectedAt: null,
  };
}

const BOT_DIFFICULTIES = ['easy', 'smart', 'expert'];

function newBotPlayer(difficulty) {
  return {
    ws: null,
    isBot: true,
    // 'easy' fires blind; 'smart' hunts with the heatmap AI below; 'expert'
    // adds the parity optimization on top of the same heatmap.
    difficulty: BOT_DIFFICULTIES.includes(difficulty) ? difficulty : 'smart',
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

// ---------- Redis (de)serialization ----------
// `ws` sockets and `Set`s aren't JSON-safe and never survive a restart
// anyway, so we strip/convert them going in and rebuild fresh Sets coming
// back out. Real WebSocket connections are always null after a reload —
// a human player must send `resume` with their saved token to reattach.

function serializePlayerForRedis(p) {
  if (!p) return null;
  const base = {
    isBot: !!p.isBot,
    token: p.token,
    nickname: p.nickname || null,
    ships: p.ships ? p.ships.map((s) => ({ cells: s.cells, hits: [...s.hits] })) : null,
    shotsReceived: p.shotsReceived,
    ready: !!p.ready,
    rematchWanted: !!p.rematchWanted,
    disconnectedAt: p.isBot ? null : p.disconnectedAt,
  };
  if (p.isBot) {
    base.difficulty = p.difficulty;
    base.ai = { ...p.ai, dead: [...p.ai.dead] };
  }
  return base;
}

function deserializePlayerFromRedis(d) {
  if (!d) return null;
  const ships = d.ships ? d.ships.map((s) => ({ cells: s.cells, hits: new Set(s.hits) })) : null;
  if (d.isBot) {
    return {
      ws: null,
      isBot: true,
      difficulty: BOT_DIFFICULTIES.includes(d.difficulty) ? d.difficulty : 'smart',
      token: null,
      ships,
      shotsReceived: d.shotsReceived,
      ready: !!d.ready,
      rematchWanted: true,
      connected: true,
      disconnectedAt: null,
      ai: d.ai ? { ...d.ai, dead: new Set(d.ai.dead) } : freshBotAI(),
    };
  }
  return {
    ws: null,
    token: d.token,
    nickname: sanitizeNickname(d.nickname),
    ships,
    shotsReceived: d.shotsReceived,
    ready: !!d.ready,
    rematchWanted: !!d.rematchWanted,
    connected: false, // must resume with the token to reattach a live socket
    disconnectedAt: d.disconnectedAt || Date.now(),
  };
}

function serializeRoomForRedis(room) {
  return {
    code: room.code,
    phase: room.phase,
    turn: room.turn,
    winner: room.winner || null,
    players: {
      p1: serializePlayerForRedis(room.players.p1),
      p2: serializePlayerForRedis(room.players.p2),
    },
  };
}

function deserializeRoomFromRedis(data) {
  return {
    code: data.code,
    phase: data.phase,
    turn: data.turn,
    winner: data.winner || null,
    players: {
      p1: deserializePlayerFromRedis(data.players.p1),
      p2: deserializePlayerFromRedis(data.players.p2),
    },
  };
}

// Fire-and-forget: gameplay never waits on Redis. A slow or unreachable
// Redis degrades persistence, not the live game.
function persistRoom(room) {
  if (!redis) return;
  redis
    .set(redisKeyFor(room.code), JSON.stringify(serializeRoomForRedis(room)), 'EX', ROOM_TTL_SECONDS)
    .catch((err) => console.error('[redis] не вдалося зберегти кімнату', room.code, err.message));
}

function deleteRoomFromRedis(code) {
  if (!redis) return;
  redis.del(redisKeyFor(code)).catch((err) => console.error('[redis] не вдалося видалити кімнату', code, err.message));
}

// Fire-and-forget: the whole leaderboard is tiny (a handful of nicknames),
// so we just persist it as one JSON blob rather than a Redis hash per entry.
function persistLeaderboard() {
  if (!redis) return;
  const data = [...leaderboard.entries()];
  redis
    .set(LEADERBOARD_REDIS_KEY, JSON.stringify(data))
    .catch((err) => console.error('[redis] не вдалося зберегти таблицю лідерів', err.message));
}

async function loadLeaderboardFromRedis() {
  if (!redis) return;
  try {
    const raw = await redis.get(LEADERBOARD_REDIS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      for (const [key, entry] of data) {
        if (key && entry) leaderboard.set(key, entry);
      }
      console.log(`[redis] відновлено таблицю лідерів (${leaderboard.size} гравців)`);
    }
  } catch (err) {
    console.error('[redis] не вдалося завантажити таблицю лідерів:', err.message);
  }
}

// Called once at boot: repopulates the in-memory `rooms` Map from whatever
// survived in Redis, so a resume immediately after a restart finds its room.
async function loadRoomsFromRedis() {
  if (!redis) return;
  try {
    const keys = await redis.keys('seabattle:room:*');
    let restored = 0;
    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      try {
        const room = deserializeRoomFromRedis(JSON.parse(raw));
        rooms.set(room.code, room);
        restored++;
      } catch (e) {
        console.error('[redis] пошкоджений запис кімнати, пропускаю:', key, e.message);
      }
    }
    if (restored) console.log(`[redis] відновлено ${restored} кімнат(и) після перезапуску`);
  } catch (err) {
    console.error('[redis] не вдалося завантажити кімнати при старті:', err.message);
  }
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

// Monte Carlo tie-break (the 'expert' difficulty): the per-ship heatmap
// below often leaves several cells tied for the top score, and 'smart'
// breaks that tie uniformly at random. 'expert' instead repeatedly tries to
// drop the *entire* remaining fleet onto the board at once (respecting
// bounds, already-tried/dead cells, no overlap, no touching) and tallies how
// often each *tied* cell ends up covered — approximating the true joint
// probability that a ship occupies it, which per-ship scoring alone can't
// see. Refining only among cells the heatmap already rated best means
// 'expert' can never pick a worse cell than 'smart' would — at worst the
// samples are inconclusive and it falls back to the same random tie-break.
const MONTE_CARLO_SAMPLES = 400;

function sampleFleetPlacement(lengths, blocked) {
  const occupied = new Set();
  const order = [...lengths];
  for (let i = order.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const len of order) {
    let placed = false;
    for (let attempt = 0; attempt < 40 && !placed; attempt++) {
      const horiz = Math.random() < 0.5;
      const r = crypto.randomInt(SIZE);
      const c = crypto.randomInt(SIZE);
      const cells = [];
      let ok = true;
      for (let i = 0; i < len; i++) {
        const rr = horiz ? r : r + i;
        const cc = horiz ? c + i : c;
        if (!inBounds(rr, cc) || blocked(rr, cc) || occupied.has(`${rr},${cc}`)) {
          ok = false;
          break;
        }
        cells.push([rr, cc]);
      }
      if (!ok) continue;
      // no-touch check against ships already placed in this sample
      for (const [rr, cc] of cells) {
        for (let dr = -1; dr <= 1 && ok; dr++) {
          for (let dc = -1; dc <= 1 && ok; dc++) {
            const nr = rr + dr,
              nc = cc + dc;
            if (occupied.has(`${nr},${nc}`) && !cells.some(([xr, xc]) => xr === nr && xc === nc)) ok = false;
          }
        }
      }
      if (!ok) continue;
      cells.forEach(([rr, cc]) => occupied.add(`${rr},${cc}`));
      placed = true;
    }
    if (!placed) return null;
  }
  return occupied;
}

// Re-ranks a set of cells that are already tied for the top heatmap score,
// using how often each one is covered across many random whole-fleet
// placements. Returns the (possibly smaller) subset that came out on top of
// that resampling, or the original list unchanged if too few samples landed
// to say anything meaningful — so this can only narrow the choice among
// already-equally-good cells, never steer toward a worse one.
function monteCarloRefineTiebreak(tiedCells, lengths, blocked) {
  if (tiedCells.length <= 1) return tiedCells;
  const tally = new Map(tiedCells.map(([r, c]) => [`${r},${c}`, 0]));
  let validSamples = 0;
  for (let s = 0; s < MONTE_CARLO_SAMPLES; s++) {
    const occupied = sampleFleetPlacement(lengths, blocked);
    if (!occupied) continue;
    validSamples++;
    for (const key of occupied) {
      if (tally.has(key)) tally.set(key, tally.get(key) + 1);
    }
  }
  if (!validSamples) return tiedCells;

  let best = -1;
  let bestKeys = [];
  for (const [key, v] of tally) {
    if (v > best) {
      best = v;
      bestKeys = [key];
    } else if (v === best) {
      bestKeys.push(key);
    }
  }
  return bestKeys.map((k) => k.split(',').map(Number));
}

// Picks the bot's next shot against `target` (the human player object),
// using its own shotsReceived grid as the source of truth for "already tried".
// `useExpert` ('expert' difficulty) refines heatmap ties with the Monte
// Carlo sampler above instead of breaking them uniformly at random.
function pickBotMove(target, ai, useExpert) {
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
  const finalCells = useExpert ? monteCarloRefineTiebreak(bestCells, lengths, cellBlocked) : bestCells;
  return finalCells[crypto.randomInt(finalCells.length)];
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

// ---------- Leaderboard ----------
// Global, cross-room win tally keyed by a lowercased nickname (so "Коля" and
// "коля" share one entry); only human-vs-human games count, so nobody can
// pad their record by beating the easy bot in a loop. Tiny enough to keep as
// a single in-memory Map, mirrored to Redis as one JSON blob when available.
const leaderboard = new Map(); // lowercase nickname -> { name, wins, games }
const LEADERBOARD_TOP_N = 10;

function recordLeaderboardResult(room, winnerKey) {
  const winner = room.players[winnerKey];
  const loser = room.players[otherKey(winnerKey)];
  if (!winner || !loser || winner.isBot || loser.isBot) return; // bot games don't count
  for (const p of [winner, loser]) {
    const key = p.nickname.toLowerCase();
    const entry = leaderboard.get(key) || { name: p.nickname, wins: 0, games: 0 };
    entry.name = p.nickname; // keep the most recently used casing
    entry.games += 1;
    if (p === winner) entry.wins += 1;
    leaderboard.set(key, entry);
  }
  persistLeaderboard();
}

function getTopLeaderboard() {
  return [...leaderboard.values()]
    .sort((a, b) => b.wins - a.wins || b.wins / b.games - a.wins / a.games || a.name.localeCompare(b.name))
    .slice(0, LEADERBOARD_TOP_N)
    .map((e) => ({ name: e.name, wins: e.wins, games: e.games }));
}

// ---------- Quick match ----------
// A simple FIFO queue: the first connection to ask for a quick match waits
// here until a second one asks, at which point they're paired into a fresh
// room together — no code to type or share. `setRoomCode`/`setMyKey` let the
// *other* connection's message handler (which is what actually finds the
// match) reach into the waiting connection's own per-connection closure
// state, since that's private to the `wss.on('connection', ...)` scope it
// was created in.
const quickMatchQueue = [];

function removeFromQuickMatchQueue(ws) {
  const idx = quickMatchQueue.findIndex((e) => e.ws === ws);
  if (idx !== -1) quickMatchQueue.splice(idx, 1);
}

// Pops the oldest still-connected waiting entry, skipping (and discarding)
// any that went stale (closed) while queued.
function popQuickMatchOpponent(ws) {
  while (quickMatchQueue.length) {
    const entry = quickMatchQueue.shift();
    if (entry.ws === ws) continue; // shouldn't happen, but never match with self
    if (entry.ws.readyState !== entry.ws.OPEN) continue;
    return entry;
  }
  return null;
}

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
    recordLeaderboardResult(room, shooterKey);
  }

  persistRoom(room);
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
      const move =
        bot.difficulty === 'easy' ? pickBotMoveEasy(target) : pickBotMove(target, bot.ai, bot.difficulty === 'expert');
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
  const chatLimiter = makeRateLimiter(20, 10000); // 20 chat/reaction messages per 10s

  // Room codes are only 4 characters (~1.6M combinations), so the generic
  // roomLimiter above (10 room actions/min) isn't tight enough on its own to
  // discourage guessing a code to sneak into someone else's game. Track
  // consecutive *wrong-code* join attempts specifically and lock this
  // connection out of joining for a cooldown once it looks like guessing
  // rather than a typo. A full room or an already-taken code don't count —
  // those aren't evidence of guessing.
  let failedJoinAttempts = 0;
  let joinLockedUntil = 0;

  let roomCode = null;
  let myKey = null; // 'p1' | 'p2'

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'create' || msg.type === 'create_bot' || msg.type === 'join' || msg.type === 'quick_match') {
      if (!roomLimiter()) {
        send(ws, {
          type: 'error',
          errorCode: 'too_many_room_actions',
          message: 'Забагато спроб поспіль. Зачекайте трохи і спробуйте ще раз.',
        });
        return;
      }
    }

    if (msg.type === 'get_leaderboard') {
      send(ws, { type: 'leaderboard', top: getTopLeaderboard() });
      return;
    }

    if (msg.type === 'create') {
      const code = makeRoomCode();
      const room = {
        code,
        players: { p1: newPlayer(ws, msg.nickname), p2: null },
        phase: 'waiting', // waiting -> placement -> battle -> over
        turn: 'p1',
      };
      rooms.set(code, room);
      roomCode = code;
      myKey = 'p1';
      persistRoom(room);
      send(ws, { type: 'created', code, player: 'p1', token: room.players.p1.token });
      return;
    }

    if (msg.type === 'create_bot') {
      const difficulty = BOT_DIFFICULTIES.includes(msg.difficulty) ? msg.difficulty : 'smart';
      const code = makeRoomCode();
      const room = {
        code,
        players: { p1: newPlayer(ws, msg.nickname), p2: newBotPlayer(difficulty) },
        phase: 'placement', // the "seat" is already filled, so skip the waiting room entirely
        turn: 'p1',
      };
      rooms.set(code, room);
      roomCode = code;
      myKey = 'p1';
      persistRoom(room);
      send(ws, { type: 'bot_created', code, player: 'p1', token: room.players.p1.token, difficulty });
      return;
    }

    if (msg.type === 'join') {
      const now = Date.now();
      if (now < joinLockedUntil) {
        send(ws, {
          type: 'error',
          errorCode: 'join_locked',
          errorVars: { seconds: Math.ceil((joinLockedUntil - now) / 1000) },
          message: `Забагато невдалих спроб приєднання. Спробуйте ще раз через ${Math.ceil((joinLockedUntil - now) / 1000)} с.`,
        });
        return;
      }
      const code = String(msg.code || '')
        .toUpperCase()
        .trim();
      const room = rooms.get(code);
      if (!room) {
        failedJoinAttempts++;
        if (failedJoinAttempts >= JOIN_LOCKOUT_THRESHOLD) {
          joinLockedUntil = now + JOIN_LOCKOUT_MS;
          failedJoinAttempts = 0;
          send(ws, {
            type: 'error',
            errorCode: 'join_locked',
            errorVars: { seconds: Math.ceil(JOIN_LOCKOUT_MS / 1000) },
            message: `Забагато невдалих спроб приєднання. Спробуйте ще раз через ${Math.ceil(JOIN_LOCKOUT_MS / 1000)} с.`,
          });
          return;
        }
        send(ws, { type: 'error', errorCode: 'room_not_found', message: 'Кімнату не знайдено. Перевірте код.' });
        return;
      }
      if (room.players.p2 && room.players.p2.connected) {
        send(ws, { type: 'error', errorCode: 'room_full', message: 'Кімната вже заповнена.' });
        return;
      }
      failedJoinAttempts = 0;
      room.players.p2 = newPlayer(ws, msg.nickname);
      roomCode = code;
      myKey = 'p2';
      room.phase = 'placement';
      persistRoom(room);
      send(ws, { type: 'joined', code, player: 'p2', token: room.players.p2.token });
      broadcastRoom(room, { type: 'start_placement' });
      return;
    }

    if (msg.type === 'quick_match') {
      const opponent = popQuickMatchOpponent(ws);
      if (!opponent) {
        quickMatchQueue.push({
          ws,
          nickname: sanitizeNickname(msg.nickname),
          setRoomCode: (v) => {
            roomCode = v;
          },
          setMyKey: (v) => {
            myKey = v;
          },
        });
        send(ws, { type: 'quick_match_waiting' });
        return;
      }
      const code = makeRoomCode();
      const p1 = newPlayer(opponent.ws, opponent.nickname);
      const p2 = newPlayer(ws, msg.nickname);
      const room = {
        code,
        players: { p1, p2 },
        phase: 'placement', // both seats are already filled — skip the waiting room entirely
        turn: 'p1',
      };
      rooms.set(code, room);
      opponent.setRoomCode(code);
      opponent.setMyKey('p1');
      roomCode = code;
      myKey = 'p2';
      persistRoom(room);
      send(opponent.ws, { type: 'quick_matched', code, player: 'p1', token: p1.token });
      send(ws, { type: 'quick_matched', code, player: 'p2', token: p2.token });
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
        send(ws, {
          type: 'resume_failed',
          errorCode: 'resume_not_found',
          message: 'Цю гру не знайдено — можливо, вона вже завершилась.',
        });
        return;
      }
      const foundKey = ['p1', 'p2'].find((k) => room.players[k] && room.players[k].token === token);
      if (!foundKey) {
        send(ws, { type: 'resume_failed', errorCode: 'resume_lost', message: 'Не вдалося відновити сесію цієї гри.' });
        return;
      }
      const me = room.players[foundKey];
      me.ws = ws;
      me.connected = true;
      me.disconnectedAt = null;
      roomCode = code;
      myKey = foundKey;
      persistRoom(room);

      send(ws, buildResumeSnapshot(room, foundKey));

      const opp = room.players[otherKey(foundKey)];
      if (opp && opp.connected) {
        send(opp.ws, { type: 'opponent_reconnected' });
      }
      return;
    }

    if (msg.type === 'leave') {
      removeFromQuickMatchQueue(ws); // no-op if we weren't queued
      if (roomCode && myKey) {
        const room = rooms.get(roomCode);
        if (room) {
          const opp = room.players[otherKey(myKey)];
          room.players[myKey] = null;
          if (opp && !opp.isBot) send(opp.ws, { type: 'opponent_left' });
          if (roomShouldBeDeleted(room)) {
            rooms.delete(roomCode);
            deleteRoomFromRedis(roomCode);
          } else {
            persistRoom(room);
          }
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

    if (msg.type === 'chat') {
      if (!chatLimiter()) {
        send(ws, {
          type: 'error',
          errorCode: 'too_many_chat',
          message: 'Забагато повідомлень поспіль. Зачекайте трохи.',
        });
        return;
      }
      const text = sanitizeChatText(msg.text);
      if (!text) return;
      broadcastRoom(room, { type: 'chat', from: myKey, text });
      return;
    }

    if (msg.type === 'reaction') {
      if (!chatLimiter()) {
        send(ws, {
          type: 'error',
          errorCode: 'too_many_chat',
          message: 'Забагато повідомлень поспіль. Зачекайте трохи.',
        });
        return;
      }
      if (!CHAT_EMOJI.includes(msg.emoji)) return;
      broadcastRoom(room, { type: 'reaction', from: myKey, emoji: msg.emoji });
      return;
    }

    if (msg.type === 'place') {
      const validated = validateShips(msg.ships);
      if (!validated) {
        send(ws, { type: 'error', errorCode: 'invalid_placement', message: 'Некоректне розташування кораблів.' });
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
      persistRoom(room);
      return;
    }

    if (msg.type === 'fire') {
      if (!fireLimiter()) {
        send(ws, {
          type: 'error',
          errorCode: 'too_many_shots',
          message: 'Забагато пострілів поспіль. Зачекайте секунду.',
        });
        return;
      }
      if (room.phase !== 'battle') return;
      if (room.turn !== myKey) {
        send(ws, { type: 'error', errorCode: 'not_your_turn', message: 'Зараз не ваш хід.' });
        return;
      }
      const { r, c } = msg;
      if (!Number.isInteger(r) || !Number.isInteger(c) || !inBounds(r, c)) return;
      if (opp.shotsReceived[r][c]) {
        send(ws, { type: 'error', errorCode: 'already_fired', message: 'Сюди вже стріляли.' });
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
        persistRoom(room);
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
      persistRoom(room);
      return;
    }
  });

  ws.on('close', () => {
    removeFromQuickMatchQueue(ws); // in case we were still waiting in the queue, not yet in a room
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
    persistRoom(room);

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
      if (roomShouldBeDeleted(r)) {
        rooms.delete(roomCode);
        deleteRoomFromRedis(roomCode);
      } else {
        persistRoom(r);
      }
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

Promise.all([loadRoomsFromRedis(), loadLeaderboardFromRedis()]).finally(() => {
  server.listen(PORT, () => {
    console.log(`Sea Battle server listening on port ${PORT}`);
  });
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
    if (redis) redis.disconnect();
    // Belt-and-braces: force-exit shortly after in case something (a slow
    // client, a half-open socket) keeps the process alive past close().
    setTimeout(() => process.exit(0), 3000).unref();
  }, 300);
}
process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
process.on('SIGINT', () => shutdownGracefully('SIGINT'));
