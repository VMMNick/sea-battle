'use strict';
// Перевірка внутрішньоігрового чату та emoji-реакцій: текст обрізається й
// тримується, доставляється обом (включно з відправником, оскільки клієнт
// малює повідомлення лише за підтвердженням від сервера), довільний emoji
// у реакції відхиляється мовчки (allow-list), а порожнє/пробільне
// повідомлення в чаті — теж мовчки ігнорується.
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
  const p1 = await connect();
  const p2 = await connect();
  p1.send({ type: 'create' });
  const created = await p1.waitFor((m) => m.type === 'created');
  p2.send({ type: 'join', code: created.code });
  await p2.waitFor((m) => m.type === 'joined');
  await p1.waitFor((m) => m.type === 'start_placement');
  await p2.waitFor((m) => m.type === 'start_placement');

  // ---- Chat: trimmed, delivered to both sides including the sender ----
  p1.send({ type: 'chat', text: '  Привіт!  ' });
  const c1 = await p1.waitFor((m) => m.type === 'chat');
  const c2 = await p2.waitFor((m) => m.type === 'chat');
  if (c1.text !== 'Привіт!' || c2.text !== 'Привіт!') throw new Error('chat text was not trimmed correctly');
  if (c1.from !== 'p1' || c2.from !== 'p1') throw new Error('chat "from" field is wrong');
  console.log('OK: chat message trimmed and delivered to both sides, from =', c1.from);

  // ---- Chat: overlong text is capped, not rejected ----
  const longText = 'а'.repeat(500);
  p1.send({ type: 'chat', text: longText });
  const longEcho = await p1.waitFor((m) => m.type === 'chat' && m.text.length > 100);
  if (longEcho.text.length > 200) throw new Error(`chat text was not capped: length ${longEcho.text.length}`);
  console.log('OK: overlong chat text capped to', longEcho.text.length, 'chars');
  await p2.waitFor((m) => m.type === 'chat'); // drain the matching copy on p2's side too

  // ---- Reactions: delivered to both sides including the sender ----
  p2.send({ type: 'reaction', emoji: '🔥' });
  const r1 = await p1.waitFor((m) => m.type === 'reaction');
  const r2 = await p2.waitFor((m) => m.type === 'reaction');
  if (r1.emoji !== '🔥' || r1.from !== 'p2' || r2.emoji !== '🔥' || r2.from !== 'p2') {
    throw new Error(`unexpected reaction payload: ${JSON.stringify(r1)} / ${JSON.stringify(r2)}`);
  }
  console.log('OK: reaction delivered to both sides, from =', r1.from, 'emoji =', r1.emoji);

  // ---- Reactions: an emoji outside the allow-list is silently rejected ----
  p2.send({ type: 'reaction', emoji: '💩' });
  await new Promise((r) => setTimeout(r, 300));
  if (p1.queue.some((m) => m.type === 'reaction')) throw new Error('an out-of-allow-list emoji was NOT filtered');
  console.log('OK: an emoji outside the allow-list is silently rejected');

  // ---- Chat: whitespace-only text is a no-op ----
  p1.send({ type: 'chat', text: '   ' });
  await new Promise((r) => setTimeout(r, 300));
  if (p2.queue.some((m) => m.type === 'chat')) throw new Error('whitespace-only chat was NOT filtered');
  console.log('OK: whitespace-only chat is silently rejected');

  p1.close();
  p2.close();
  console.log('\nALL CHAT/REACTION CHECKS PASSED ✅');
  process.exit(0);
})().catch((err) => {
  console.error('TEST ERROR:', err);
  process.exit(1);
});
