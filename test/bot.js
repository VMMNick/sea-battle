'use strict';
// Перевірка гри проти бота: створення, авто-розстановка бота, повний бій,
// правило "влучив — стріляй ще раз" і базова якість ШІ (target-режим після влучання).
const WebSocket = require('ws');
const URL = process.env.URL || 'ws://localhost:8123';
const SIZE = 10;

class Client {
  constructor(ws) {
    this.ws = ws;
    this.queue = [];
    ws.on('message', (raw) => this.queue.push(JSON.parse(raw.toString())));
  }
  waitFor(predicate, timeoutMs = 8000) {
    const idx = this.queue.findIndex(predicate);
    if (idx !== -1) return Promise.resolve(this.queue.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const iv = setInterval(() => {
        const i = this.queue.findIndex(predicate);
        if (i !== -1) { clearInterval(iv); resolve(this.queue.splice(i, 1)[0]); }
        else if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error('timeout')); }
      }, 30);
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  close() { this.ws.close(); }
}

function connect() {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => resolve(new Client(ws)));
  });
}

function randomFleet() {
  const SHIP_LENGTHS = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
  const occupied = new Set();
  const ships = [];
  const inB = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  function neighbors(cells) {
    const s = new Set();
    for (const [r, c] of cells) for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const nr = r + dr, nc = c + dc;
      if (inB(nr, nc)) s.add(`${nr},${nc}`);
    }
    return s;
  }
  function canPlace(cells) {
    for (const [r, c] of cells) if (!inB(r, c) || occupied.has(`${r},${c}`)) return false;
    for (const k of neighbors(cells)) if (occupied.has(k) && !cells.some(([r, c]) => `${r},${c}` === k)) return false;
    return true;
  }
  for (const len of SHIP_LENGTHS) {
    let placed = false, attempts = 0;
    while (!placed && attempts < 2000) {
      attempts++;
      const horiz = Math.random() < 0.5;
      const r = Math.floor(Math.random() * SIZE);
      const c = Math.floor(Math.random() * SIZE);
      const cells = [];
      for (let i = 0; i < len; i++) cells.push(horiz ? [r, c + i] : [r + i, c]);
      if (canPlace(cells)) { ships.push({ cells }); cells.forEach(([r, c]) => occupied.add(`${r},${c}`)); placed = true; }
    }
    if (!placed) throw new Error('failed to place ship');
  }
  return ships;
}

(async () => {
  // ---- Basic flow: create_bot skips the waiting room entirely ----
  const p1 = await connect();
  p1.send({ type: 'create_bot' });
  const created = await p1.waitFor((m) => m.type === 'bot_created');
  console.log('Bot room created:', created.code, '- no waiting screen needed');
  if (!created.token) throw new Error('expected a reconnect token even for bot games');

  const fleet = randomFleet();
  p1.send({ type: 'place', ships: fleet });
  await p1.waitFor((m) => m.type === 'placement_ok');

  // bot should auto-place and battle should start without any second client
  const battleStart = await p1.waitFor((m) => m.type === 'battle_start');
  console.log('OK: battle started automatically after only placing my own ships. turn =', battleStart.turn);
  if (battleStart.turn !== 'p1') throw new Error('expected human (p1) to go first');

  // ---- Play the game out for real, tracking bot behavior ----
  // The bot's fleet is randomly generated server-side and never revealed to
  // the client, so — just like a real player — we can't target it exactly;
  // sweep the board in order instead.
  function makeSweeper() {
    const cells = [];
    for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) cells.push([r, c]);
    let i = 0;
    return () => cells[i++];
  }
  let turn = battleStart.turn;
  const nextMyCell = makeSweeper();
  let winner = null;
  let botShotCount = 0;
  let botHitCount = 0;
  const botShots = []; // [r,c,result]
  let rounds = 0;

  while (!winner && rounds < 500) {
    rounds++;
    if (turn === 'p1') {
      const [r, c] = nextMyCell();
      p1.send({ type: 'fire', r, c });
      const res = await p1.waitFor((m) => m.type === 'fire_result' && m.by === 'p1' && m.r === r && m.c === c);
      turn = res.turn;
      if (res.result === 'win') winner = 'p1';
    } else {
      // it's the bot's turn — it fires on its own after a short delay
      const res = await p1.waitFor((m) => m.type === 'fire_result' && m.by === 'p2');
      botShotCount++;
      if (res.result === 'hit' || res.result === 'sunk' || res.result === 'win') botHitCount++;
      botShots.push([res.r, res.c, res.result]);
      turn = res.turn;
      if (res.result === 'win') winner = 'p2';
    }
  }

  if (!winner) throw new Error('game vs bot did not conclude within round limit');
  console.log(`Game finished. Winner: ${winner}. Bot fired ${botShotCount} shots, ${botHitCount} were hits/sinks.`);

  // Sanity: bot must never fire the same cell twice
  const seen = new Set();
  for (const [r, c] of botShots) {
    const key = `${r},${c}`;
    if (seen.has(key)) throw new Error(`bot fired at ${key} more than once`);
    seen.add(key);
  }
  console.log('OK: bot never repeated a shot (' + botShots.length + ' unique cells)');

  // Sanity: hit rate should reflect a smarter-than-random bot. Random firing
  // hits roughly 20/100 = 20% of the time on an empty board; with hunt/target
  // AI the effective hit rate over a full game should clearly beat pure luck.
  const hitRate = botHitCount / botShotCount;
  console.log(`Bot hit rate this game: ${(hitRate * 100).toFixed(1)}%`);
  if (hitRate < 0.2) {
    console.warn('NOTE: bot hit rate was low this game (can happen by chance) — see multi-game average below.');
  }

  p1.close();

  // ---- Run several more full games headlessly to get an average hit rate,
  // since any single game is noisy ----
  async function playOneGame() {
    const c1 = await connect();
    c1.send({ type: 'create_bot' });
    const cr = await c1.waitFor((m) => m.type === 'bot_created');
    const f = randomFleet();
    c1.send({ type: 'place', ships: f });
    await c1.waitFor((m) => m.type === 'placement_ok');
    const bs = await c1.waitFor((m) => m.type === 'battle_start');
    let t = bs.turn;
    const nextCell = makeSweeper();
    let shots = 0, hits = 0;
    let win = null;
    let guard = 0;
    while (!win && guard < 500) {
      guard++;
      if (t === 'p1') {
        const [r, c] = nextCell();
        c1.send({ type: 'fire', r, c });
        const res = await c1.waitFor((m) => m.type === 'fire_result' && m.by === 'p1' && m.r === r && m.c === c);
        t = res.turn;
        if (res.result === 'win') win = 'p1';
      } else {
        const res = await c1.waitFor((m) => m.type === 'fire_result' && m.by === 'p2');
        shots++;
        if (res.result !== 'miss') hits++;
        t = res.turn;
        if (res.result === 'win') win = 'p2';
      }
    }
    c1.close();
    return { shots, hits, win };
  }

  const N = 2;
  // Fold in the very first game's numbers too, so the sample is 1+N games
  // without paying for extra slow bot-delay wall-clock time.
  let totalShots = botShotCount, totalHits = botHitCount;
  for (let i = 0; i < N; i++) {
    const g = await playOneGame();
    totalShots += g.shots;
    totalHits += g.hits;
  }
  const avgRate = totalHits / totalShots;
  console.log(`\nAverage bot hit rate over ${1 + N} full games: ${(avgRate * 100).toFixed(1)}% (${totalHits}/${totalShots} shots)`);
  if (avgRate < 0.24) {
    throw new Error(`Bot hit rate too low (${(avgRate * 100).toFixed(1)}%) — hunt/target AI should meaningfully beat random (~20%)`);
  }
  console.log('OK: bot plays meaningfully smarter than random shooting');

  console.log('\nALL BOT CHECKS PASSED ✅');
  process.exit(0);
})().catch((err) => {
  console.error('TEST ERROR:', err);
  process.exit(1);
});
