'use strict';
// Shared constants and mutable game state. Every other client module reads
// and writes properties on the single exported `state` object below instead
// of module-scoped `let` bindings — this is the direct ES-module equivalent
// of the plain variables the original single-file client.js used, kept this
// way deliberately (rather than introducing a bigger state-management
// rewrite) so behavior stays byte-for-byte identical to before the split.

/**
 * @typedef {[number, number]} Cell A [row, col] board coordinate, 0-9 each.
 */

/**
 * @typedef {Object} Ship
 * @property {Cell[]} cells The cells this ship occupies.
 */

/**
 * @typedef {Object} SessionData Saved in localStorage so a reload/dropped
 *   connection can resume the same seat in the same room.
 * @property {string} code Room code.
 * @property {string} token Secret reconnect token issued by the server.
 * @property {'p1'|'p2'} player Which seat this browser holds.
 * @property {boolean} [vsBot] True when the opponent seat is a bot.
 */

/**
 * @typedef {Object} Settings Per-browser preferences, saved across sessions.
 * @property {boolean} sound
 * @property {boolean} vibration
 * @property {boolean} lightTheme
 * @property {string} nickname Shown on the global leaderboard; empty until the player sets one.
 * @property {'uk'|'en'} locale UI language.
 */

/**
 * @typedef {Object} LeaderboardEntry
 * @property {string} name
 * @property {number} wins
 * @property {number} games
 */

/**
 * @typedef {Object} WinLossRecord
 * @property {number} wins
 * @property {number} losses
 */

/**
 * @typedef {Object} Stats Local win/loss counters, never sent to the server.
 * @property {WinLossRecord} vsBot
 * @property {WinLossRecord} vsHuman
 */

/**
 * @typedef {Object} ServerMessage A message received over the WebSocket.
 *   `type` selects the shape of the rest of the fields; see the big switch
 *   in main.js's handleMessage for the exact shape per type (mirrors the
 *   message types server.js sends via its own `send()` helper).
 * @property {string} type
 */

export const SIZE = 10;
export const SHIP_LENGTHS = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];

/**
 * All mutable game/session state, grouped in one place. Fields are grouped
 * by the area of the game they belong to, matching the original file's
 * section comments.
 */
export const state = {
  // ---- connection / session ----
  /** @type {WebSocket|undefined} */
  ws: undefined,
  /** @type {'p1'|'p2'|null} */
  myPlayer: null,
  /** @type {string|null} */
  roomCode: null,
  /** True once the current screen has been built from real server state. */
  hasHydrated: false,
  /** True when the opponent seat is a bot. */
  vsBot: false,
  /** Room code carried in a `?code=XXXX` invite link, consumed on first connect. */
  inviteCode: '',
  /** @type {'easy'|'smart'|'expert'} */
  botDifficulty: 'smart',
  /** @type {'uk'|'en'} UI language — mirrors settings.locale, kept here too since i18n.js/dom.js read it directly. */
  locale: 'uk',

  // ---- placement ----
  /** @type {Ship[]} */
  placedShips: [],
  /** @type {Set<string>} `"r,c"` keys of every cell any placed ship occupies. */
  occupiedSet: new Set(),
  /** @type {'h'|'v'} */
  rotation: 'h',
  /** Remaining ship lengths still to be placed, longest first. */
  shipQueue: [],

  // ---- battle ----
  myTurn: false,
  /** @type {?Array<Array<null|'hit'|'miss'|'sunk'>>} Shots the opponent made on us. */
  ownShotsGrid: null,
  /** @type {?Array<Array<null|'hit'|'miss'|'sunk'>>} Our shots on the opponent. */
  enemyShotsGrid: null,
};
