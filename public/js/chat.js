'use strict';
// In-battle chat + emoji quick-reactions between the two players in a room.
// Purely ephemeral: nothing here is persisted server-side or survives a
// resume/restart, and the widget itself is hidden entirely for bot games
// (see setEnemyBoardTitle's sibling toggle in main.js).

import { state } from './state.js';
import { $ } from './dom.js';
import { sendMsg } from './network.js';
import { vibrate } from './sound.js';
import { t } from './i18n.js';

const MAX_LOG_ENTRIES = 100;

export const REACTION_EMOJI = ['👍', '😂', '😱', '🔥', '🎯', '🙌'];

export function resetChat() {
  const log = $('chat-log');
  if (log) log.innerHTML = '';
  const input = $('chat-input');
  if (input) input.value = '';
}

function appendLogEntry(cls, text) {
  const log = $('chat-log');
  if (!log) return;
  const li = document.createElement('li');
  li.className = `chat-entry ${cls}`;
  li.textContent = text;
  log.appendChild(li);
  while (log.children.length > MAX_LOG_ENTRIES) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

/** @param {'p1'|'p2'} from @param {string} text Incoming `chat` message from the server. */
export function handleChatMessage(from, text) {
  const isMe = from === state.myPlayer;
  const who = isMe ? t('chat.you') : t('chat.opponent');
  appendLogEntry(isMe ? 'chat-me' : 'chat-opp', t('chat.entry', { who, text }));
}

/** @param {'p1'|'p2'} from @param {string} emoji Incoming `reaction` message from the server. */
export function handleReactionMessage(from, emoji) {
  const isMe = from === state.myPlayer;
  const who = isMe ? t('chat.you') : t('chat.opponent');
  appendLogEntry(isMe ? 'chat-me chat-reaction' : 'chat-opp chat-reaction', t('chat.entry', { who, text: emoji }));
  showReactionBurst(emoji);
  if (!isMe) vibrate(20);
}

// A single emoji that floats up and fades near the middle of the screen —
// cosmetic only, auto-removes itself after the animation finishes.
function showReactionBurst(emoji) {
  const el = document.createElement('div');
  el.className = 'reaction-burst';
  el.textContent = emoji;
  el.style.left = `${38 + Math.random() * 24}%`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

export function sendChatText(rawText) {
  const text = rawText.trim();
  if (!text) return;
  sendMsg({ type: 'chat', text });
}

/** @param {string} emoji */
export function sendReaction(emoji) {
  sendMsg({ type: 'reaction', emoji });
  vibrate(10);
}
