'use strict';
// Ship-placement screen: fleet state, legality checks, and the own-board
// grid (preview highlighting, click/keyboard to place a ship).

import { SIZE, SHIP_LENGTHS, state } from './state.js';
import { $ } from './dom.js';
import { paintShipHull, clearShipShape } from './dom.js';
import { makeCellFocusable, attachGridKeyboardNav } from './keyboard-nav.js';
import { t } from './i18n.js';

export function resetPlacement() {
  state.placedShips = [];
  state.occupiedSet = new Set();
  state.rotation = 'h';
  state.shipQueue = [...SHIP_LENGTHS];
  renderFleetStatus();
  buildOwnGrid();
  $('btn-ready').disabled = true;
  $('opp-ready-note').classList.add('hidden');
}

// Rebuild the placement screen showing an already-submitted fleet as read-only
// (used when resuming a session where this player had already clicked "Готово").
/** @param {import('./state.js').Cell[][]} shipsCells */
export function restorePlacementReady(shipsCells) {
  state.placedShips = shipsCells.map((cells) => ({ cells }));
  state.occupiedSet = new Set();
  state.placedShips.forEach((s) => s.cells.forEach(([r, c]) => state.occupiedSet.add(`${r},${c}`)));
  state.rotation = 'h';
  state.shipQueue = [];
  renderFleetStatus();
  buildOwnGrid();
  $('btn-ready').disabled = true;
}

export function renderFleetStatus() {
  const counts = {};
  SHIP_LENGTHS.forEach((l) => {
    counts[l] = (counts[l] || 0) + 1;
  });
  const placedCounts = {};
  state.placedShips.forEach((s) => {
    placedCounts[s.cells.length] = (placedCounts[s.cells.length] || 0) + 1;
  });

  const el = $('fleet-status');
  el.innerHTML = '';
  Object.keys(counts)
    .sort((a, b) => b - a)
    .forEach((len) => {
      const total = counts[len];
      const placed = placedCounts[len] || 0;
      for (let i = 0; i < total; i++) {
        const chip = document.createElement('span');
        chip.className = 'fleet-chip' + (i < placed ? ' done' : '');
        chip.textContent = '▮'.repeat(Number(len));
        el.appendChild(chip);
      }
    });
}

/** @param {import('./state.js').Cell[]} cells */
export function neighborsOf(cells) {
  const set = new Set();
  for (const [r, c] of cells) {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const nr = r + dr,
          nc = c + dc;
        if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE) set.add(`${nr},${nc}`);
      }
    }
  }
  return set;
}

/** @param {import('./state.js').Cell[]} cells */
export function canPlace(cells) {
  for (const [r, c] of cells) {
    if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return false;
    if (state.occupiedSet.has(`${r},${c}`)) return false;
  }
  // no touching existing ships (own cells are excluded below since they're
  // never in occupiedSet yet at this point)
  const forbidden = neighborsOf(cells);
  for (const key of forbidden) {
    if (state.occupiedSet.has(key) && !cells.some(([r, c]) => `${r},${c}` === key)) {
      // touching an occupied cell that's not part of this ship
      return false;
    }
  }
  return true;
}

export function nextShipLength() {
  return state.shipQueue.length ? state.shipQueue[0] : null;
}

/** @param {number} r @param {number} c @param {number} len @param {'h'|'v'} rot */
export function cellsForPlacement(r, c, len, rot) {
  const cells = [];
  for (let i = 0; i < len; i++) {
    cells.push(rot === 'h' ? [r, c + i] : [r + i, c]);
  }
  return cells;
}

export function buildOwnGrid() {
  const grid = $('grid-own');
  grid.innerHTML = '';
  grid.classList.remove('grid-small');
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', t('placement.ownBoardAria'));
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      cell.addEventListener('mouseenter', () => previewAt(r, c));
      cell.addEventListener('mouseleave', clearPreview);
      cell.addEventListener('focus', () => previewAt(r, c));
      cell.addEventListener('blur', clearPreview);
      cell.addEventListener('click', () => placeAt(r, c));
      makeCellFocusable(cell, r, c, r === 0 && c === 0);
      grid.appendChild(cell);
    }
  }
  attachGridKeyboardNav(grid, (cell, r, c) => placeAt(r, c));
  paintOwnShips();
}

export function paintOwnShips() {
  document.querySelectorAll('#grid-own .cell').forEach(clearShipShape);
  for (const ship of state.placedShips) {
    paintShipHull(ship.cells, ownCellEl);
  }
}

/** @param {number} r @param {number} c */
export function ownCellEl(r, c) {
  return document.querySelector(`#grid-own .cell[data-r="${r}"][data-c="${c}"]`);
}

export function clearPreview() {
  document
    .querySelectorAll('#grid-own .cell.preview-ok, #grid-own .cell.preview-bad')
    .forEach((el) => el.classList.remove('preview-ok', 'preview-bad'));
}

/** @param {number} r @param {number} c */
export function previewAt(r, c) {
  clearPreview();
  const len = nextShipLength();
  if (!len) return;
  const cells = cellsForPlacement(r, c, len, state.rotation);
  const ok = canPlace(cells);
  for (const [cr, cc] of cells) {
    const el = ownCellEl(cr, cc);
    if (el) el.classList.add(ok ? 'preview-ok' : 'preview-bad');
  }
}

/** @param {number} r @param {number} c */
export function placeAt(r, c) {
  const len = nextShipLength();
  if (!len) return;
  const cells = cellsForPlacement(r, c, len, state.rotation);
  if (!canPlace(cells)) return;
  state.placedShips.push({ cells });
  cells.forEach(([cr, cc]) => state.occupiedSet.add(`${cr},${cc}`));
  state.shipQueue.shift();
  paintOwnShips();
  renderFleetStatus();
  clearPreview();
  $('btn-ready').disabled = state.shipQueue.length !== 0;
}

export function toggleRotation() {
  state.rotation = state.rotation === 'h' ? 'v' : 'h';
}

/** Randomly (and legally) places the whole fleet — the "🎲 Випадково" button. */
export function placeRandomFleet() {
  resetPlacement();
  const lengths = [...SHIP_LENGTHS];
  for (const len of lengths) {
    let placedOk = false;
    let attempts = 0;
    while (!placedOk && attempts < 500) {
      attempts++;
      const rot = Math.random() < 0.5 ? 'h' : 'v';
      const r = Math.floor(Math.random() * SIZE);
      const c = Math.floor(Math.random() * SIZE);
      const cells = cellsForPlacement(r, c, len, rot);
      if (canPlace(cells)) {
        state.placedShips.push({ cells });
        cells.forEach(([cr, cc]) => state.occupiedSet.add(`${cr},${cc}`));
        state.shipQueue.shift();
        placedOk = true;
      }
    }
  }
  paintOwnShips();
  renderFleetStatus();
  $('btn-ready').disabled = state.shipQueue.length !== 0;
}
