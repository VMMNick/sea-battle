'use strict';
// Перевіряє, що стан кімнати переживає повний перезапуск процесу сервера,
// коли налаштовано REDIS_URL: створюємо гру проти бота, робимо постріл,
// вбиваємо сервер (SIGKILL — імітація краху, без шансу на graceful cleanup),
// піднімаємо новий процес на тому ж REDIS_URL і відновлюємось за токеном.
//
// Якщо REDIS_URL не задано і локального redis-server немає — тест
// пропускається (persistence — опціональна фіча, а не обов'язкова
// залежність для запуску проєкту).
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const REDIS_URL = process.env.PERSISTENCE_TEST_REDIS_URL || process.env.REDIS_URL || '';
const PORT = process.env.PERSISTENCE_TEST_PORT || 8177;
const HTTP_URL = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}`;

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
          reject(new Error('timeout waiting for ' + predicate));
        }
      }, 30);
    });
  }
  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(new Client(ws)));
    ws.on('error', reject);
  });
}

function waitForServer(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function attempt() {
      http
        .get(url, (res) => {
          res.resume();
          resolve();
        })
        .on('error', () => {
          if (Date.now() > deadline) return reject(new Error('server did not start in time'));
          setTimeout(attempt, 200);
        });
    })();
  });
}

function startServer() {
  const env = { ...process.env, PORT: String(PORT), REDIS_URL };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return child;
}

(async () => {
  if (!REDIS_URL) {
    console.log('SKIP: REDIS_URL не задано — тест персистентності Redis пропущено.');
    process.exit(0);
  }

  let server = startServer();
  await waitForServer(HTTP_URL, 10000);
  console.log('Server #1 up, creating a bot game...');

  const p1 = await connect(WS_URL);
  p1.send({ type: 'create_bot', difficulty: 'easy' });
  const created = await p1.waitFor((m) => m.type === 'bot_created');
  const code = created.code;
  const token = created.token;

  // Place a fixed, valid, non-touching fleet so we know exactly where our
  // ships are, then fire a shot so there's real mid-battle state to restore.
  const ships = [
    {
      cells: [
        [0, 0],
        [0, 1],
        [0, 2],
        [0, 3],
      ],
    },
    {
      cells: [
        [2, 0],
        [2, 1],
        [2, 2],
      ],
    },
    {
      cells: [
        [4, 0],
        [4, 1],
        [4, 2],
      ],
    },
    {
      cells: [
        [6, 0],
        [6, 1],
      ],
    },
    {
      cells: [
        [8, 0],
        [8, 1],
      ],
    },
    {
      cells: [
        [2, 4],
        [2, 5],
      ],
    },
    { cells: [[0, 9]] },
    { cells: [[2, 9]] },
    { cells: [[4, 9]] },
    { cells: [[6, 9]] },
  ];
  p1.send({ type: 'place', ships });
  await p1.waitFor((m) => m.type === 'placement_ok');
  const battleStart = await p1.waitFor((m) => m.type === 'battle_start');
  console.log('Battle started, turn =', battleStart.turn);

  // Fire until we know it's our turn and we've landed at least one shot
  // (the bot may go first depending on who starts — 'p1' always starts here
  // since create_bot always makes the human p1 and turn starts at 'p1').
  p1.send({ type: 'fire', r: 5, c: 5 });
  const fireResult = await p1.waitFor((m) => m.type === 'fire_result' && m.r === 5 && m.c === 5);
  console.log('Fired at (5,5), result =', fireResult.result);

  await new Promise((r) => setTimeout(r, 200)); // let the async Redis write land

  console.log('Killing server #1 (SIGKILL, simulating a crash)...');
  server.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));

  console.log('Starting server #2 on the same REDIS_URL...');
  server = startServer();
  await waitForServer(HTTP_URL, 10000);

  const p1b = await connect(WS_URL);
  p1b.send({ type: 'resume', code, token });
  const resumed = await p1b.waitFor((m) => m.type === 'resumed' || m.type === 'resume_failed', 5000);

  if (resumed.type === 'resume_failed') {
    throw new Error('resume failed after restart — room was not restored from Redis');
  }
  if (resumed.phase !== 'battle') {
    throw new Error(`expected phase=battle after restore, got ${resumed.phase}`);
  }
  // The bot's fleet is randomly generated, so the shot at (5,5) could be a
  // hit or a miss — either way the server records 'hit' for hit/sunk and
  // 'miss' for miss, and that's exactly what the restored snapshot must show.
  const expectedMark = fireResult.result === 'miss' ? 'miss' : 'hit';
  if (resumed.myShotsOnOpp[5][5] !== expectedMark) {
    throw new Error(
      `restored room is missing the shot fired before the restart (expected '${expectedMark}', got '${resumed.myShotsOnOpp[5][5]}')`,
    );
  }
  if (!resumed.myShips || resumed.myShips.length !== 10) {
    throw new Error('restored room is missing the placed fleet');
  }
  console.log('OK: room state (phase, shots, fleet) survived a full process restart via Redis');

  server.kill('SIGTERM');
  console.log('\nALL PERSISTENCE CHECKS PASSED ✅');
  process.exit(0);
})().catch((err) => {
  console.error('TEST ERROR:', err);
  process.exit(1);
});
