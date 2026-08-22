'use strict';
// Both interactive grids (own board while placing, enemy board while firing)
// work as a single roving-tabindex widget: Tab reaches the grid once, then
// arrow keys move focus cell-to-cell and Enter/Space activates the focused
// cell — same action as a click. `grid-self` (read-only fleet display during
// battle) intentionally stays out of the tab order.

import { SIZE } from './state.js';
import { cellLabel } from './dom.js';

/** @param {Element} cell @param {number} r @param {number} c @param {boolean} tabbable */
export function makeCellFocusable(cell, r, c, tabbable) {
  cell.setAttribute('role', 'button');
  cell.tabIndex = tabbable ? 0 : -1;
  cell.setAttribute('aria-label', `Клітинка ${cellLabel(r, c)}`);
}

/**
 * @param {Element} gridEl
 * @param {(cell: Element, r: number, c: number) => void} onActivate
 */
export function attachGridKeyboardNav(gridEl, onActivate) {
  if (gridEl.dataset.kbdBound) return; // container persists across rebuilds — bind once
  gridEl.dataset.kbdBound = '1';
  gridEl.addEventListener('keydown', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    const r = Number(cell.dataset.r),
      c = Number(cell.dataset.c);
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      onActivate(cell, r, c);
      return;
    }
    let nr = r,
      nc = c;
    if (e.key === 'ArrowUp') nr = Math.max(0, r - 1);
    else if (e.key === 'ArrowDown') nr = Math.min(SIZE - 1, r + 1);
    else if (e.key === 'ArrowLeft') nc = Math.max(0, c - 1);
    else if (e.key === 'ArrowRight') nc = Math.min(SIZE - 1, c + 1);
    else return;
    e.preventDefault();
    const next = gridEl.querySelector(`.cell[data-r="${nr}"][data-c="${nc}"]`);
    if (next && next !== cell) {
      cell.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
    }
  });
}
