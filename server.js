'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- Static file server ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, reqPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- Game logic ----------

const SIZE = 10;
// Класичний набір кораблів: 1x4, 2x3, 3x2, 4x1
const SHIP_LENGTHS = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];

function emptyGrid() {
  return Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
}

function inBounds(r, c) {
  return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}

function validateShips(ships) {
  if (!Array.isArray(ships) || ships.length !== SHIP_LENGTHS.length) return null;

  const lengths = ships.map((s) => Array.isArray(s.cells) ? s.cells.length : -1).sort((a, b) => a - b);
  const expected = [...SHIP_LENGTHS].sort((a, b) => a - b);
  if (JSON.stringify(lengths) !== JSON.stringify(expected)) return null;

  const grid = emptyGrid();
  const occupied = new Set();

  for (const ship of ships) {
    const cells = ship.cells;
    for (const cell of cells) {
      if (!Array.isArray(cell) || cell.length !== 2) return null;
      const [r, c] = cell;
      if (!Number.isInteger(r) || !Number.isInteger(c) || !inBounds(r, c)) return null;
    }
    // contiguous straight line check
    const rows = cells.map((c) => c[0]);
    const cols = cells.map((c) => c[1]);
    const sameRow = rows.every((r) => r === rows[0]);
    const sameCol = cols.every((c) => c === cols[0]);
    if (cells.length > 1 && !sameRow && !sameCol) return null;
    if (sameRow) {
      const sorted = [...cols].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] !== sorted[i - 1] + 1) return null;
      }
    }
    if (sameCol) {
      const sorted = [...rows].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] !== sorted[i - 1] + 1) return null;
      }
    }

    // no-touch (including diagonally) against previously placed ships
    for (const [r, c] of cells) {
      const key = `${r},${c}`;
      if (occupied.has(key)) return null; // overlap
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr, nc = c + dc;
          if (inBounds(nr, nc) && grid[nr][nc] && grid[nr][nc] !== ship) {
            // touching a different ship
            if (!cells.some(([cr, cc]) => cr === nr && cc === nc)) return null;
          }
        }
      }
    }
    for (const [r, c] of cells) {
      grid[r][c] = ship;
      occupied.add(`${r},${c}`);
    }
  }

  return ships.map((s) => ({ cells: s.cells, hits: new Set() }));
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function newPlayer(ws) {
  return {
    ws,
    ships: null, // validated ship list with hit tracking
    shotsReceived: emptyGrid(), // what opponent has fired at us: 'hit' | 'miss'
    ready: false,
    connected: true,
  };
}

const rooms = new Map(); // code -> room

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function otherKey(key) {
  return key === 'p1' ? 'p2' : 'p1';
}

function broadcastRoom(room, msg) {
  send(room.players.p1.ws, msg);
  if (room.players.p2) send(room.players.p2.ws, msg);
}

function allShipsSunk(player) {
  return player.ships.every((s) => s.hits.size === s.cells.length);
}

function resetRoomForRematch(room) {
  for (const key of ['p1', 'p2']) {
    const p = room.players[key];
    if (!p) continue;
    p.ships = null;
    p.shotsReceived = emptyGrid();
    p.ready = false;
  }
  room.phase = 'placement';
  room.turn = 'p1';
}

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let roomCode = null;
  let myKey = null; // 'p1' | 'p2'

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'create') {
      const code = makeRoomCode();
      const room = {
        code,
        players: { p1: newPlayer(ws), p2: null },
        phase: 'waiting', // waiting -> placement -> battle -> over
        turn: 'p1',
      };
      rooms.set(code, room);
      roomCode = code;
      myKey = 'p1';
      send(ws, { type: 'created', code, player: 'p1' });
      return;
    }

    if (msg.type === 'join') {
      const code = String(msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) {
        send(ws, { type: 'error', message: 'Кімнату не знайдено. Перевірте код.' });
        return;
      }
      if (room.players.p2 && room.players.p2.connected) {
        send(ws, { type: 'error', message: 'Кімната вже заповнена.' });
        return;
      }
      room.players.p2 = newPlayer(ws);
      roomCode = code;
      myKey = 'p2';
      room.phase = 'placement';
      send(ws, { type: 'joined', code, player: 'p2' });
      broadcastRoom(room, { type: 'start_placement' });
      return;
    }

    const room = rooms.get(roomCode);
    if (!room || !myKey) return;
    const me = room.players[myKey];
    const opp = room.players[otherKey(myKey)];

    if (msg.type === 'place') {
      const validated = validateShips(msg.ships);
      if (!validated) {
        send(ws, { type: 'error', message: 'Некоректне розташування кораблів.' });
        return;
      }
      me.ships = validated;
      me.ready = true;
      send(ws, { type: 'placement_ok' });
      if (opp) send(opp.ws, { type: 'opponent_ready' });

      if (opp && me.ready && opp.ready) {
        room.phase = 'battle';
        room.turn = 'p1';
        broadcastRoom(room, { type: 'battle_start', turn: room.turn });
      }
      return;
    }

    if (msg.type === 'fire') {
      if (room.phase !== 'battle') return;
      if (room.turn !== myKey) {
        send(ws, { type: 'error', message: 'Зараз не ваш хід.' });
        return;
      }
      const { r, c } = msg;
      if (!Number.isInteger(r) || !Number.isInteger(c) || !inBounds(r, c)) return;
      if (opp.shotsReceived[r][c]) {
        send(ws, { type: 'error', message: 'Сюди вже стріляли.' });
        return;
      }

      let result = 'miss';
      let sunkShip = null;
      for (const ship of opp.ships) {
        if (ship.cells.some(([sr, sc]) => sr === r && sc === c)) {
          ship.hits.add(`${r},${c}`);
          result = ship.hits.size === ship.cells.length ? 'sunk' : 'hit';
          if (result === 'sunk') sunkShip = ship;
          break;
        }
      }
      opp.shotsReceived[r][c] = result === 'miss' ? 'miss' : 'hit';

      const win = result !== 'miss' && allShipsSunk(opp);
      if (result === 'miss') {
        room.turn = otherKey(myKey);
      }
      // on hit or sunk, same player continues (turn unchanged)

      broadcastRoom(room, {
        type: 'fire_result',
        by: myKey,
        r,
        c,
        result: win ? 'win' : result,
        shipCells: sunkShip ? sunkShip.cells : undefined,
        turn: room.turn,
      });

      if (win) {
        room.phase = 'over';
        broadcastRoom(room, { type: 'game_over', winner: myKey });
      }
      return;
    }

    if (msg.type === 'rematch') {
      me.rematchWanted = true;
      if (opp) send(opp.ws, { type: 'opponent_wants_rematch' });
      if (opp && opp.rematchWanted) {
        me.rematchWanted = false;
        opp.rematchWanted = false;
        resetRoomForRematch(room);
        broadcastRoom(room, { type: 'start_placement' });
      }
      return;
    }
  });

  ws.on('close', () => {
    if (!roomCode || !myKey) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    const me = room.players[myKey];
    if (me) me.connected = false;
    const opp = room.players[otherKey(myKey)];
    if (opp && opp.connected) {
      send(opp.ws, { type: 'opponent_disconnected' });
    }
    // Clean up empty rooms after a delay
    setTimeout(() => {
      const r = rooms.get(roomCode);
      if (!r) return;
      const p1gone = !r.players.p1 || !r.players.p1.connected;
      const p2gone = !r.players.p2 || !r.players.p2.connected;
      if (p1gone && p2gone) rooms.delete(roomCode);
    }, 5 * 60 * 1000);
  });
});

// heartbeat to drop dead connections
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(interval));

server.listen(PORT, () => {
  console.log(`Sea Battle server listening on port ${PORT}`);
});
