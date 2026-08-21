'use strict';
// Чиста (без мережі/таймерів) симуляція логіки бота: скільки пострілів у
// середньому потрібно боту, щоб потопити весь випадковий флот, порівняно з
// абсолютно випадковою стрільбою без повторів. Це прямий, малошумний тест
// якості алгоритму hunt/target, на відміну від повільних наскрізних партій.

const SIZE = 10;
const SHIP_LENGTHS = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];

function inBounds(r, c) {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

function generateRandomShips() {
  const occupied = new Set();
  const placed = [];
  function neighbors(cells) {
    const s = new Set();
    for (const [r, c] of cells)
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr,
            nc = c + dc;
          if (inBounds(nr, nc)) s.add(`${nr},${nc}`);
        }
    return s;
  }
  function canPlace(cells) {
    for (const [r, c] of cells) if (!inBounds(r, c) || occupied.has(`${r},${c}`)) return false;
    for (const key of neighbors(cells))
      if (occupied.has(key) && !cells.some(([r, c]) => `${r},${c}` === key)) return false;
    return true;
  }
  for (const len of SHIP_LENGTHS) {
    let ok = false,
      attempts = 0;
    while (!ok && attempts < 2000) {
      attempts++;
      const horiz = Math.random() < 0.5;
      const r = Math.floor(Math.random() * SIZE);
      const c = Math.floor(Math.random() * SIZE);
      const cells = [];
      for (let i = 0; i < len; i++) cells.push(horiz ? [r, c + i] : [r + i, c]);
      if (canPlace(cells)) {
        placed.push({ cells, hits: new Set() });
        cells.forEach(([r, c]) => occupied.add(`${r},${c}`));
        ok = true;
      }
    }
    if (!ok) return generateRandomShips();
  }
  return placed;
}

// ---- exact copy of the server's bot AI (kept in sync manually with server.js) ----
function freshBotAI() {
  return {
    mode: 'hunt',
    hits: [],
    queue: [],
    direction: null,
    remaining: [...SHIP_LENGTHS],
    dead: new Set(),
  };
}

function botBlocked(tried, ai, r, c) {
  if (!inBounds(r, c)) return true;
  if (tried[r][c]) return true;
  if (ai.dead.has(`${r},${c}`)) return true;
  return false;
}

function pickBotMove(triedGrid, ai) {
  while (ai.mode === 'target' && ai.queue.length) {
    const [r, c] = ai.queue.shift();
    if (!botBlocked(triedGrid, ai, r, c)) return [r, c];
  }
  if (ai.mode === 'target' && !ai.queue.length) {
    ai.mode = 'hunt';
    ai.hits = [];
    ai.direction = null;
  }
  const lengths = ai.remaining.length ? ai.remaining : SHIP_LENGTHS;
  const scores = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  const cellBlocked = (r, c) => !!triedGrid[r][c] || ai.dead.has(`${r},${c}`);
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
          for (let i = 0; i < len; i++) scores[r + i][c]++;
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
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (!cellBlocked(r, c)) bestCells.push([r, c]);
  }
  if (!bestCells.length) return null;
  return bestCells[Math.floor(Math.random() * bestCells.length)];
}

function markDeadAround(ai, cells) {
  for (const [r, c] of cells) {
    for (let dr = -1; dr <= 1; dr++)
      for (let dc = -1; dc <= 1; dc++) {
        const nr = r + dr,
          nc = c + dc;
        if (inBounds(nr, nc)) ai.dead.add(`${nr},${nc}`);
      }
  }
}

function updateBotAI(ai, r, c, result) {
  if (result === 'sunk') {
    const shipCells = [...ai.hits, [r, c]];
    const idx = ai.remaining.indexOf(shipCells.length);
    if (idx !== -1) ai.remaining.splice(idx, 1);
    markDeadAround(ai, shipCells);
    ai.mode = 'hunt';
    ai.hits = [];
    ai.queue = [];
    ai.direction = null;
    return;
  }
  if (result === 'miss') return;
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
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    ai.queue = candidates;
    return;
  }
  if (!ai.direction) {
    const [fr, fc] = ai.hits[0];
    ai.direction = fr === r ? 'h' : 'v';
    ai.queue = ai.queue.filter(([qr, qc]) => (ai.direction === 'h' ? qr === fr : qc === fc));
  }
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
// ---- end copy ----

function fireAt(fleet, r, c) {
  for (const ship of fleet) {
    if (ship.cells.some(([sr, sc]) => sr === r && sc === c)) {
      ship.hits.add(`${r},${c}`);
      return ship.hits.size === ship.cells.length ? 'sunk' : 'hit';
    }
  }
  return 'miss';
}

function allSunk(fleet) {
  return fleet.every((s) => s.hits.size === s.cells.length);
}

function emptyGrid() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
}

function playOutWithAI() {
  const fleet = generateRandomShips();
  const tried = emptyGrid();
  const ai = freshBotAI();
  let shots = 0;
  while (!allSunk(fleet)) {
    const move = pickBotMove(tried, ai);
    if (!move) throw new Error('AI ran out of moves before sinking the fleet — bug!');
    const [r, c] = move;
    const result = fireAt(fleet, r, c);
    tried[r][c] = result === 'miss' ? 'miss' : 'hit';
    updateBotAI(ai, r, c, result);
    shots++;
  }
  return shots;
}

function playOutRandom() {
  const fleet = generateRandomShips();
  const cells = [];
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) cells.push([r, c]);
  // Fisher-Yates shuffle
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  let shots = 0;
  for (const [r, c] of cells) {
    fireAt(fleet, r, c);
    shots++;
    if (allSunk(fleet)) break;
  }
  return shots;
}

const N = 500;
let aiTotal = 0,
  randTotal = 0;
let aiMax = 0,
  aiMin = Infinity;
for (let i = 0; i < N; i++) {
  const a = playOutWithAI();
  aiTotal += a;
  aiMax = Math.max(aiMax, a);
  aiMin = Math.min(aiMin, a);
  randTotal += playOutRandom();
}
const aiAvg = aiTotal / N;
const randAvg = randTotal / N;

console.log(`Simulated ${N} full board clears.`);
console.log(`Hunt/target AI: average ${aiAvg.toFixed(1)} shots to sink the whole fleet (min ${aiMin}, max ${aiMax})`);
console.log(`Pure random (no repeats): average ${randAvg.toFixed(1)} shots to sink the whole fleet`);
console.log(`Improvement: AI needs ${(100 * (1 - aiAvg / randAvg)).toFixed(1)}% fewer shots than random`);

// Known reference points for a 10x10 board with this classic fleet:
// pure random averages ~96-97 shots (near-exhaustive); a correct probability-
// density hunt/target bot should comfortably finish in the 50-65 range on average.
if (randAvg < 90) {
  throw new Error(
    `Sanity check failed: random baseline (${randAvg.toFixed(1)}) is suspiciously low — test harness bug`,
  );
}
if (aiAvg > 65) {
  throw new Error(
    `Bot AI is not meaningfully better than random (avg ${aiAvg.toFixed(1)} shots vs random ${randAvg.toFixed(1)}) — algorithm likely has a bug`,
  );
}
if (aiAvg >= randAvg) {
  throw new Error(
    `Bot AI (${aiAvg.toFixed(1)}) is not even better than random (${randAvg.toFixed(1)}) — algorithm is broken`,
  );
}

console.log('\nOK: hunt/target AI clearly outperforms random shooting ✅');
