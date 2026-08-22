'use strict';
// Перевірка швидкої гри (quick match): двоє гравців у черзі паруються між
// собою автоматично; скасування (leave) або розрив з'єднання (close), поки
// гравець ще чекає в черзі, коректно прибирає його звідти, не залишаючи
// "привида", з яким наступний гравець випадково спарувався б.
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

(async () => {
  // ---- Basic pairing ----
  const p1 = await connect();
  p1.send({ type: 'quick_match' });
  const waiting = await p1.waitFor((m) => m.type === 'quick_match_waiting');
  console.log('OK: first player queued and told to wait ->', waiting.type);

  const p2 = await connect();
  p2.send({ type: 'quick_match' });
  const m1 = await p1.waitFor((m) => m.type === 'quick_matched');
  const m2 = await p2.waitFor((m) => m.type === 'quick_matched');
  if (m1.code !== m2.code) throw new Error('paired players got different room codes');
  if (m1.player === m2.player) throw new Error('paired players got the same seat');
  await p1.waitFor((m) => m.type === 'start_placement');
  await p2.waitFor((m) => m.type === 'start_placement');
  console.log('OK: two quick-match players were paired into room', m1.code, 'and moved to placement');

  // ---- Cancel while waiting (leave) frees the queue slot ----
  const p3 = await connect();
  p3.send({ type: 'quick_match' });
  await p3.waitFor((m) => m.type === 'quick_match_waiting');
  p3.send({ type: 'leave' });
  await new Promise((r) => setTimeout(r, 300));

  const p4 = await connect();
  p4.send({ type: 'quick_match' });
  const p4waiting = await p4.waitFor((m) => m.type === 'quick_match_waiting');
  console.log('OK: cancelling out of the queue does not leave a stale entry ->', p4waiting.type);

  // p3 should still be able to start a fresh quick match on the same connection
  p3.send({ type: 'quick_match' });
  const p3rejoin = await p3.waitFor((m) => m.type === 'quick_matched' || m.type === 'quick_match_waiting');
  console.log('OK: same connection can quick-match again after cancelling ->', p3rejoin.type);
  p3.close();
  p4.close();

  // ---- Disconnecting while waiting also frees the queue slot ----
  const p5 = await connect();
  p5.send({ type: 'quick_match' });
  await p5.waitFor((m) => m.type === 'quick_match_waiting');
  p5.close();
  await new Promise((r) => setTimeout(r, 300));

  const p6 = await connect();
  p6.send({ type: 'quick_match' });
  const p6waiting = await p6.waitFor((m) => m.type === 'quick_match_waiting');
  console.log('OK: a closed connection is removed from the quick-match queue ->', p6waiting.type);
  p6.close();

  console.log('\nALL QUICK-MATCH CHECKS PASSED ✅');
  process.exit(0);
})().catch((err) => {
  console.error('TEST ERROR:', err);
  process.exit(1);
});
