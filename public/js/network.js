'use strict';
// The WebSocket connection: connect/reconnect and the outgoing message
// helper. Incoming messages are handed off to whatever handler main.js
// registers, so this module doesn't need to know about game logic at all.

import { state } from './state.js';
import { setStatus, showScreen } from './dom.js';
import { loadSession } from './storage.js';
import { t } from './i18n.js';

const proto = location.protocol === 'https:' ? 'wss' : 'ws';

/** @type {(msg: import('./state.js').ServerMessage) => void} */
let onMessage = () => {};

/**
 * Establishes the WebSocket connection and keeps reconnecting on drop.
 * Pass `handleMessage` on the first call (from main.js's bootstrap); it's
 * remembered across the automatic reconnects that follow, so later
 * internal calls don't need to (and don't) pass it again.
 * @param {(msg: import('./state.js').ServerMessage) => void} [handleMessage]
 */
export function connect(handleMessage) {
  if (handleMessage) onMessage = handleMessage;
  state.ws = new WebSocket(`${proto}://${location.host}`);
  state.ws.addEventListener('open', () => {
    setStatus(t('status.connected'));
    const saved = loadSession();
    if (saved && saved.code && saved.token) {
      showScreen('resuming');
      sendMsg({ type: 'resume', code: saved.code, token: saved.token });
    } else if (state.inviteCode) {
      sendMsg({ type: 'join', code: state.inviteCode });
      state.inviteCode = ''; // only auto-join once; further reconnects won't retry automatically
    }
  });
  state.ws.addEventListener('close', () => {
    setStatus(t('status.disconnected'));
    setTimeout(() => connect(), 2000);
  });
  state.ws.addEventListener('error', () => setStatus(t('status.connectionError')));
  state.ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    onMessage(msg);
  });
}

/** @param {object} obj */
export function sendMsg(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}
