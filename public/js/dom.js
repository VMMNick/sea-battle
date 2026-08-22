'use strict';
// Small, dependency-light DOM helpers shared across the other modules:
// element lookup, screen switching, ship-hull painting, the status bar,
// screen-reader announcements, the opponent-status banner, and the
// row/column cell-label formatter.

import { currentCols } from './i18n.js';

/** @param {string} id @returns {HTMLElement} */
export const $ = (id) => document.getElementById(id);

export const screens = {
  resuming: $('screen-resuming'),
  menu: $('screen-menu'),
  waiting: $('screen-waiting'),
  quickmatch: $('screen-quickmatch'),
  leaderboard: $('screen-leaderboard'),
  placement: $('screen-placement'),
  battle: $('screen-battle'),
  over: $('screen-over'),
};

/** @param {keyof typeof screens} name */
export function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

// ---------- Ship hull rendering ----------
// Paints a ship's cells so the group reads as one vessel (pointed bow,
// rounded stern, a deck line, and a small bridge block on longer ships)
// instead of a row of identical squares.
export const SHIP_SHAPE_CLASSES = [
  'ship',
  'ship-solo',
  'ship-h-start',
  'ship-h-mid',
  'ship-h-end',
  'ship-v-start',
  'ship-v-mid',
  'ship-v-end',
];

/** @param {Element|null} el */
export function clearShipShape(el) {
  if (!el) return;
  el.classList.remove(...SHIP_SHAPE_CLASSES);
  const cabin = el.querySelector('.ship-cabin');
  if (cabin) cabin.remove();
}

/**
 * @param {import('./state.js').Cell[]} cells
 * @param {(r: number, c: number) => Element|null} cellElFn
 */
export function paintShipHull(cells, cellElFn) {
  const sorted = [...cells].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const orientation = sorted.length === 1 ? 'solo' : sorted[0][0] === sorted[1][0] ? 'h' : 'v';
  sorted.forEach(([r, c], i) => {
    const el = cellElFn(r, c);
    if (!el) return;
    el.classList.add('ship');
    if (orientation === 'solo') {
      el.classList.add('ship-solo');
    } else {
      const pos = i === 0 ? 'start' : i === sorted.length - 1 ? 'end' : 'mid';
      el.classList.add(`ship-${orientation}-${pos}`);
    }
    // small bridge/superstructure block on the second segment of longer ships
    if (sorted.length >= 3 && i === 1 && !el.querySelector('.ship-cabin')) {
      const cabin = document.createElement('span');
      cabin.className = 'ship-cabin';
      el.appendChild(cabin);
    }
  });
}

const statusBar = $('status-bar');
/** @param {string} text */
export function setStatus(text) {
  statusBar.textContent = text;
}

// ---------- Screen-reader announcements (turn changes, shot results, game over) ----------
/** @param {string} text */
export function announce(text) {
  const el = $('aria-announcer');
  if (!el) return;
  el.textContent = '';
  // clearing first (then setting on the next frame) makes the live region
  // announce even when the new text is identical to what was just read out
  requestAnimationFrame(() => {
    el.textContent = text;
  });
}

const oppBanner = $('opp-status-banner');
/** @param {string} text @param {boolean} [ok] */
export function showOppBanner(text, ok) {
  oppBanner.textContent = text;
  oppBanner.classList.remove('hidden');
  oppBanner.classList.toggle('ok', !!ok);
}
export function hideOppBanner() {
  oppBanner.classList.add('hidden');
}

/** Formats a board coordinate as e.g. "Б4"/"B4" (locale-dependent) for shot logs and aria-labels. */
export function cellLabel(r, c) {
  return `${currentCols()[c]}${r + 1}`;
}
