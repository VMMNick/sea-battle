'use strict';
// Функціональна (не статистична) перевірка, що всі три рівні складності бота
// правильно підключені по мережі: сервер приймає їх, підтверджує тим самим
// значенням у 'bot_created', і партія проти кожного з них реально прогресує
// на кілька обмінів пострілами. Статистичну якість самого алгоритму (чи
// справді 'smart'/'expert' розумніші за випадковість) перевіряє
// test/bot-ai-sim.js — тут лише "не зламана проводка".
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.BOT_DIFFICULTY_TEST_PORT || 8199 + 11;
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
  close() {
    this.ws.close();
  }
}

function connect() {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    ws.on('open', () => resolve(new Client(ws)));
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

function fixedNonTouchingFleet() {
  return [
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
}

async function checkDifficulty(sent, expected) {
  const p1 = await connect();
  p1.send({ type: 'create_bot', difficulty: sent });
  const created = await p1.waitFor((m) => m.type === 'bot_created');
  if (created.difficulty !== expected) {
    throw new Error(`sent difficulty='${sent}', expected server to echo '${expected}', got '${created.difficulty}'`);
  }

  p1.send({ type: 'place', ships: fixedNonTouchingFleet() });
  await p1.waitFor((m) => m.type === 'placement_ok');
  const battleStart = await p1.waitFor((m) => m.type === 'battle_start');
  if (battleStart.turn !== 'p1') throw new Error('expected human to start first in a vs-bot game');

  // Exchange a handful of shots to prove the game actually progresses
  // (the bot fires back automatically) rather than checking a full game.
  let exchanges = 0;
  let turn = battleStart.turn;
  const targets = [
    [1, 1],
    [1, 3],
    [3, 3],
    [3, 5],
    [5, 3],
    [5, 5],
    [7, 3],
    [7, 5],
    [9, 3],
    [9, 5],
  ];
  let idx = 0;
  while (exchanges < 4 && idx < targets.length) {
    if (turn === 'p1') {
      const [r, c] = targets[idx++];
      p1.send({ type: 'fire', r, c });
      const res = await p1.waitFor((m) => m.type === 'fire_result' && m.by === 'p1' && m.r === r && m.c === c);
      turn = res.turn;
      exchanges++;
    } else {
      const res = await p1.waitFor((m) => m.type === 'fire_result' && m.by === 'p2');
      turn = res.turn;
      exchanges++;
    }
  }
  console.log(
    `OK: '${sent}' -> server echoes difficulty '${created.difficulty}', game progressed (${exchanges} exchanges)`,
  );
  p1.close();
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitForServer(HTTP_URL, 10000);

  await checkDifficulty('easy', 'easy');
  await checkDifficulty('smart', 'smart');
  await checkDifficulty('expert', 'expert');
  // Anything unrecognized (missing, typo, tampered client) must default to
  // 'smart' rather than silently misbehaving or crashing the room.
  await checkDifficulty('nonsense', 'smart');
  await checkDifficulty(undefined, 'smart');

  server.kill('SIGTERM');
  console.log('\nALL BOT DIFFICULTY WIRING CHECKS PASSED ✅');
  process.exit(0);
})().catch((err) => {
  console.error('TEST ERROR:', err);
  process.exit(1);
});
