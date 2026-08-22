'use strict';
// Перевіряє захист від підбору коду кімнати: після кількох поспіль невдалих
// спроб приєднання з одного з'єднання сервер має тимчасово заблокувати
// подальші спроби приєднання з нього, а не просто відповідати "не знайдено"
// щоразу. Використовує SEABATTLE_JOIN_LOCKOUT_MS, щоб не чекати реальні 30с.
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.JOIN_LOCKOUT_TEST_PORT || 8188;
const HTTP_URL = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}`;
const LOCKOUT_MS = 600;

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
      }, 20);
    });
  }
  send(obj) {
    this.ws.send(JSON.stringify(obj));
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

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), SEABATTLE_JOIN_LOCKOUT_MS: String(LOCKOUT_MS) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await waitForServer(HTTP_URL, 10000);

  const c = await connect();

  // 4 wrong-code attempts should each just get the plain "not found" error.
  for (let i = 0; i < 4; i++) {
    c.send({ type: 'join', code: 'ZZZZ' });
    const err = await c.waitFor((m) => m.type === 'error');
    if (!/не знайдено/.test(err.message)) {
      throw new Error(`attempt ${i + 1}: expected "not found" error, got: ${err.message}`);
    }
  }
  console.log('OK: first 4 wrong-code attempts just report "room not found"');

  // The 5th consecutive failure should trigger the lockout instead.
  c.send({ type: 'join', code: 'ZZZZ' });
  const lockErr = await c.waitFor((m) => m.type === 'error');
  if (!/Забагато невдалих спроб/.test(lockErr.message)) {
    throw new Error('expected lockout message on the 5th failed attempt, got: ' + lockErr.message);
  }
  console.log('OK: 5th consecutive wrong-code attempt triggers a lockout ->', lockErr.message);

  // While locked, even a *correct*, currently-existing code must be refused.
  const host = await connect();
  host.send({ type: 'create' });
  const created = await host.waitFor((m) => m.type === 'created');

  c.send({ type: 'join', code: created.code });
  const stillLocked = await c.waitFor((m) => m.type === 'error');
  if (!/Забагато невдалих спроб/.test(stillLocked.message)) {
    throw new Error('expected still-locked-out error for a correct code during lockout, got: ' + stillLocked.message);
  }
  console.log('OK: correct code is still refused while locked out');

  // After the (shortened) lockout window passes, joining a real room works again.
  await new Promise((r) => setTimeout(r, LOCKOUT_MS + 200));
  c.send({ type: 'join', code: created.code });
  const joined = await c.waitFor((m) => m.type === 'joined' || m.type === 'error', 5000);
  if (joined.type !== 'joined') {
    throw new Error('expected join to succeed after lockout expired, got: ' + JSON.stringify(joined));
  }
  console.log('OK: join succeeds again once the lockout window has passed');

  server.kill('SIGTERM');
  console.log('\nALL JOIN-LOCKOUT CHECKS PASSED ✅');
  process.exit(0);
})().catch((err) => {
  console.error('TEST ERROR:', err);
  process.exit(1);
});
