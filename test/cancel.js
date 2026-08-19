'use strict';
// Перевірка: гравець створює кімнату, скасовує очікування, і може створити/приєднатись знову.
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
        if (i !== -1) { clearInterval(iv); resolve(this.queue.splice(i, 1)[0]); }
        else if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error('timeout')); }
      }, 30);
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
}

function connect() {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => resolve(new Client(ws)));
  });
}

(async () => {
  const p1 = await connect();
  p1.send({ type: 'create' });
  const created = await p1.waitFor((m) => m.type === 'created');
  console.log('P1 created room', created.code);

  // cancel while waiting for opponent
  p1.send({ type: 'leave' });
  await new Promise((r) => setTimeout(r, 300));

  // room should be gone now - a second client trying to join must get an error
  const p2 = await connect();
  p2.send({ type: 'join', code: created.code });
  const joinErr = await p2.waitFor((m) => m.type === 'error');
  console.log('OK: joining a cancelled room correctly rejected ->', joinErr.message);

  // p1's same connection should still be usable to create a brand new room
  p1.send({ type: 'create' });
  const created2 = await p1.waitFor((m) => m.type === 'created');
  console.log('OK: same connection can create a new room after cancelling ->', created2.code);
  if (created2.code === created.code) throw new Error('expected a fresh room code');

  // and a real join should now work normally on the new room
  const p3 = await connect();
  p3.send({ type: 'join', code: created2.code });
  const joined = await p3.waitFor((m) => m.type === 'joined');
  await p1.waitFor((m) => m.type === 'start_placement');
  await p3.waitFor((m) => m.type === 'start_placement');
  console.log('OK: fresh room after cancel works end-to-end, joined =', joined.code);

  console.log('ALL CANCEL CHECKS PASSED ✅');
  process.exit(0);
})().catch((err) => {
  console.error('TEST ERROR:', err);
  process.exit(1);
});
