'use strict';
// Перевірка глобальної таблиці лідерів: перемоги гравців у боях "людина
// проти людини" накопичуються під їхніми нікнеймами і повертаються через
// get_leaderboard. (Виняток для ігор проти бота — простий предикат
// `!winner.isBot && !loser.isBot` у server.js — перевіряється оглядом коду,
// а не рантаймом: детермінований повний бій проти бота зайняв би багато
// нестабільного часу через випадкове розташування його флоту.)
const WebSocket = require('ws');
const URL = process.env.URL || 'ws://localhost:8123';

class Client {
  constructor(ws) {
    this.ws = ws;
    this.queue = [];
    ws.on('message', (raw) => this.queue.push(JSON.parse(raw.toString())));
  }
  waitFor(predicate, timeoutMs = 5000) {
    const idx = this.queue.findIndex(predicate);
    if (idx !== -1) return Promise.resolve(this.queue.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const iv = setInterval(() => {
        const i = this.queue.findIndex(predicate);
        if (i !== -1) {
          clearInterval(iv);
          resolve(this.queue.splice(i, 1)[0]);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(iv);
          reject(new Error('timeout'));
        }
      }, 30);
    });
  }
  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }
  close() {
    this.ws.close();
  }
}

function connect() {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => resolve(new Client(ws)));
  });
}

// Identical fixed, valid, non-touching fleet for both players — since both
// boards use the same layout, each side already knows exactly where the
// other's ships are, so a full sink needs no guessing.
const SHIPS = [
  { cells: [[0, 0], [0, 1], [0, 2], [0, 3]] },
  { cells: [[2, 0], [2, 1], [2, 2]] },
  { cells: [[4, 0], [4, 1], [4, 2]] },
  { cells: [[6, 0], [6, 1]] },
  { cells: [[8, 0], [8, 1]] },
  { cells: [[2, 4], [2, 5]] },
  { cells: [[0, 9]] },
  { cells: [[2, 9]] },
  { cells: [[4, 9]] },
  { cells: [[6, 9]] },
]; // prettier-ignore
const ALL_SHIP_CELLS = SHIPS.flatMap((s) => s.cells);

async function playToCompletion(attacker, defender) {
  for (const [r, c] of ALL_SHIP_CELLS) {
    attacker.send({ type: 'fire', r, c });
    await attacker.waitFor((m) => m.type === 'fire_result' && m.r === r && m.c === c);
  }
  await attacker.waitFor((m) => m.type === 'game_over');
  await defender.waitFor((m) => m.type === 'game_over');
}

async function setUpRoom(nickA, nickB) {
  const a = await connect();
  const b = await connect();
  a.send({ type: 'create', nickname: nickA });
  const created = await a.waitFor((m) => m.type === 'created');
  b.send({ type: 'join', code: created.code, nickname: nickB });
  await b.waitFor((m) => m.type === 'joined');
  await a.waitFor((m) => m.type === 'start_placement');
  await b.waitFor((m) => m.type === 'start_placement');
  a.send({ type: 'place', ships: SHIPS });
  b.send({ type: 'place', ships: SHIPS });
  await a.waitFor((m) => m.type === 'battle_start');
  await b.waitFor((m) => m.type === 'battle_start');
  return { a, b };
}

(async () => {
  const suffix = Date.now().toString(36);
  const alice = `TestAlice_${suffix}`;
  const bob = `TestBob_${suffix}`;

  // ---- Game 1: Alice (p1, always moves first) wins outright ----
  const room1 = await setUpRoom(alice, bob);
  await playToCompletion(room1.a, room1.b);
  console.log('OK: game 1 finished, Alice (p1) won');

  let top;
  {
    room1.a.send({ type: 'get_leaderboard' });
    const lb = await room1.a.waitFor((m) => m.type === 'leaderboard');
    top = lb.top;
  }
  const aliceEntry1 = top.find((e) => e.name === alice);
  const bobEntry1 = top.find((e) => e.name === bob);
  if (!aliceEntry1 || aliceEntry1.wins !== 1 || aliceEntry1.games !== 1) {
    throw new Error(`unexpected Alice leaderboard entry after game 1: ${JSON.stringify(aliceEntry1)}`);
  }
  if (!bobEntry1 || bobEntry1.wins !== 0 || bobEntry1.games !== 1) {
    throw new Error(`unexpected Bob leaderboard entry after game 1: ${JSON.stringify(bobEntry1)}`);
  }
  console.log('OK: leaderboard reflects game 1 ->', JSON.stringify({ alice: aliceEntry1, bob: bobEntry1 }));
  room1.a.close();
  room1.b.close();

  // ---- Game 2: fresh room, this time Bob (p2) wins ----
  // p1 always moves first, so Alice fires one deliberate miss (an empty
  // cell) to hand the turn to Bob, who then sinks every one of Alice's
  // ships without missing.
  const room2 = await setUpRoom(alice, bob);
  room2.a.send({ type: 'fire', r: 9, c: 9 }); // guaranteed miss, not part of any ship
  await room2.a.waitFor((m) => m.type === 'fire_result' && m.r === 9 && m.c === 9 && m.result === 'miss');
  await playToCompletion(room2.b, room2.a);
  console.log('OK: game 2 finished, Bob (p2) won');

  {
    room2.b.send({ type: 'get_leaderboard' });
    const lb = await room2.b.waitFor((m) => m.type === 'leaderboard');
    top = lb.top;
  }
  const aliceEntry2 = top.find((e) => e.name === alice);
  const bobEntry2 = top.find((e) => e.name === bob);
  if (!aliceEntry2 || aliceEntry2.wins !== 1 || aliceEntry2.games !== 2) {
    throw new Error(`unexpected Alice leaderboard entry after game 2: ${JSON.stringify(aliceEntry2)}`);
  }
  if (!bobEntry2 || bobEntry2.wins !== 1 || bobEntry2.games !== 2) {
    throw new Error(`unexpected Bob leaderboard entry after game 2: ${JSON.stringify(bobEntry2)}`);
  }
  console.log('OK: leaderboard accumulates across games ->', JSON.stringify({ alice: aliceEntry2, bob: bobEntry2 }));
  room2.a.close();
  room2.b.close();

  console.log('\nALL LEADERBOARD CHECKS PASSED ✅');
  process.exit(0);
})().catch((err) => {
  console.error('TEST ERROR:', err);
  process.exit(1);
});
