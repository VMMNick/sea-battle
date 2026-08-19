'use strict';
// Перевірка відновлення гри після втрати з'єднання: розрив WS і повторне
// підключення з тим самим токеном має повернути гравця в те саме місце гри.
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
        else if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error('timeout waiting for ' + predicate)); }
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
  const SIZE = 10;
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
  // ---- Scenario 1: resume while waiting for opponent ----
  {
    const p1 = await connect();
    p1.send({ type: 'create' });
    const created = await p1.waitFor((m) => m.type === 'created');
    if (!created.token) throw new Error('server did not send a reconnect token on create');
    console.log('Scenario 1: room', created.code, 'token received');

    p1.ws.terminate(); // simulate a dropped connection / closed tab (not a clean 'leave')
    await new Promise((r) => setTimeout(r, 300));

    const p1b = await connect();
    p1b.send({ type: 'resume', code: created.code, token: created.token });
    const resumed = await p1b.waitFor((m) => m.type === 'resumed');
    if (resumed.phase !== 'waiting') throw new Error('expected phase=waiting, got ' + resumed.phase);
    if (resumed.player !== 'p1') throw new Error('expected to resume as p1');
    console.log('OK: resumed into "waiting" phase after simulated drop\n');
    p1b.close();
  }

  // ---- Scenario 2: resume mid-battle with full board state restored ----
  {
    const p1 = await connect();
    const p2 = await connect();
    p1.send({ type: 'create' });
    const created = await p1.waitFor((m) => m.type === 'created');
    p2.send({ type: 'join', code: created.code });
    const joined = await p2.waitFor((m) => m.type === 'joined');
    if (!joined.token) throw new Error('server did not send a reconnect token on join');

    await p1.waitFor((m) => m.type === 'start_placement');
    await p2.waitFor((m) => m.type === 'start_placement');

    const fleet1 = randomFleet();
    const fleet2 = randomFleet();
    p1.send({ type: 'place', ships: fleet1 });
    p2.send({ type: 'place', ships: fleet2 });
    await p1.waitFor((m) => m.type === 'placement_ok');
    await p2.waitFor((m) => m.type === 'placement_ok');
    const battleStart = await p1.waitFor((m) => m.type === 'battle_start');
    await p2.waitFor((m) => m.type === 'battle_start');
    console.log('Scenario 2: battle started, turn =', battleStart.turn);

    // fire a couple of real shots so there's state to restore (one guaranteed hit, one guaranteed miss)
    const shooterIsP1 = battleStart.turn === 'p1';
    const shooter = shooterIsP1 ? p1 : p2;
    const shooterKey = shooterIsP1 ? 'p1' : 'p2';
    const targetFleet = shooterIsP1 ? fleet2 : fleet1;
    const [hr, hc] = targetFleet[0].cells[0]; // guaranteed hit
    shooter.send({ type: 'fire', r: hr, c: hc });
    await p1.waitFor((m) => m.type === 'fire_result' && m.r === hr && m.c === hc);
    await p2.waitFor((m) => m.type === 'fire_result' && m.r === hr && m.c === hc);
    console.log(`Fired a confirmed hit at (${hr},${hc}) by ${shooterKey}`);

    // now p2 drops connection unexpectedly (not a clean leave)
    p2.ws.terminate();
    const lostMsg = await p1.waitFor((m) => m.type === 'opponent_connection_lost', 5000);
    console.log('OK: p1 notified opponent connection lost (soft signal, game state kept) ->', lostMsg.type);

    await new Promise((r) => setTimeout(r, 300));

    // p2 reconnects with the saved token and should land right back mid-battle
    const p2b = await connect();
    p2b.send({ type: 'resume', code: created.code, token: joined.token });
    const resumed = await p2b.waitFor((m) => m.type === 'resumed');
    if (resumed.phase !== 'battle') throw new Error('expected phase=battle, got ' + resumed.phase);
    if (resumed.player !== 'p2') throw new Error('expected to resume as p2');

    // verify the restored board reflects the shot that was fired before the drop
    const p2ShouldSeeSelfHit = !shooterIsP1 ? false : true; // if p1 shot p2's fleet, p2's own board shows the hit
    if (shooterIsP1) {
      if (resumed.myShotsReceived[hr][hc] !== 'hit') {
        throw new Error('resumed snapshot missing the shot taken against p2 while they were disconnected');
      }
      console.log('OK: resumed snapshot correctly shows the incoming hit on my own board at', hr, hc);
    } else {
      if (resumed.myShotsOnOpp[hr][hc] !== 'hit') {
        throw new Error('resumed snapshot missing p2\'s own shot on the opponent');
      }
      console.log('OK: resumed snapshot correctly shows my own shot on the opponent at', hr, hc);
    }

    if (!resumed.myShips || resumed.myShips.length !== 10) {
      throw new Error('resumed snapshot did not include my full fleet');
    }
    console.log('OK: resumed snapshot includes my full fleet (' + resumed.myShips.length + ' ships)');

    const p1ReconnectMsg = await p1.waitFor((m) => m.type === 'opponent_reconnected', 5000);
    console.log('OK: p1 notified opponent reconnected ->', p1ReconnectMsg.type);

    // game must still be fully playable after the reconnect: finish it out
    let turn = resumed.turn;
    const targets = { p1: fleet2.flatMap((s) => s.cells), p2: fleet1.flatMap((s) => s.cells) };
    const already = { p1: new Set([`${hr},${hc}`]), p2: new Set() };
    if (shooterIsP1) already.p1.add(`${hr},${hc}`); else already.p2.add(`${hr},${hc}`);
    const idx = { p1: 0, p2: 0 };
    const players = { p1, p2: p2b };
    let winner = null;
    let guard = 0;
    while (!winner && guard < 400) {
      guard++;
      const key = turn;
      const list = targets[key].filter(([r, c]) => !already[key].has(`${r},${c}`));
      const [r, c] = list[0];
      already[key].add(`${r},${c}`);
      players[key].send({ type: 'fire', r, c });
      const res = await players[key].waitFor((m) => m.type === 'fire_result' && m.r === r && m.c === c);
      turn = res.turn;
      if (res.result === 'win') winner = key;
    }
    if (!winner) throw new Error('game did not conclude after reconnect');
    console.log('OK: game completed normally after reconnect, winner =', winner);

    p1.close();
    p2b.close();
  }

  console.log('\nALL RESUME CHECKS PASSED ✅');
  process.exit(0);
})().catch((err) => {
  console.error('TEST ERROR:', err);
  process.exit(1);
});
