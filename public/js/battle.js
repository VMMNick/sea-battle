'use strict';
// Battle screen: both grids (own fleet read-only display + enemy grid for
// firing), the shot log, turn indicator, and the cosmetic hit/miss/sunk
// impact animations.

import { SIZE, state } from './state.js';
import { $, paintShipHull, announce, cellLabel } from './dom.js';
import { makeCellFocusable, attachGridKeyboardNav } from './keyboard-nav.js';
import { sfx, vibrate } from './sound.js';
import { sendMsg } from './network.js';
import { t } from './i18n.js';

const MAX_LOG_ENTRIES = 50;

export function resetShotLog() {
  const el = $('shot-log');
  if (el) el.innerHTML = '';
}

/** @param {boolean} iAmShooter @param {number} r @param {number} c @param {string} result */
export function logShot(iAmShooter, r, c, result) {
  const el = $('shot-log');
  if (!el) return;
  const who = iAmShooter ? t('chat.you') : state.vsBot ? t('shotLog.bot') : t('chat.opponent');
  const sunk = result === 'sunk' || result === 'win';
  const cls = result === 'miss' ? 'miss' : sunk ? 'sunk' : 'hit';
  const label = result === 'miss' ? t('shotLog.miss') : sunk ? t('shotLog.sunk') : t('shotLog.hit');
  const li = document.createElement('li');
  li.className = `shot-log-entry shot-log-${cls}`;
  li.textContent = t('shotLog.entry', { who, cell: cellLabel(r, c), label });
  el.insertBefore(li, el.firstChild);
  while (el.children.length > MAX_LOG_ENTRIES) el.removeChild(el.lastChild);
  announce(li.textContent);
}

/** Sets up both battle grids for a fresh game (empty shot history). */
export function buildBattleGrids() {
  state.ownShotsGrid = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  state.enemyShotsGrid = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  resetShotLog();

  const selfGrid = $('grid-self');
  selfGrid.innerHTML = '';
  selfGrid.classList.add('grid-small');
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      selfGrid.appendChild(cell);
    }
  }
  state.placedShips.forEach((s) => paintShipHull(s.cells, selfCellEl));

  const enemyGrid = $('grid-enemy');
  enemyGrid.innerHTML = '';
  enemyGrid.classList.add('grid-enemy');
  enemyGrid.setAttribute('role', 'group');
  enemyGrid.setAttribute('aria-label', t('battle.enemyBoardAria'));
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      cell.addEventListener('click', () => fireAt(r, c));
      makeCellFocusable(cell, r, c, r === 0 && c === 0);
      enemyGrid.appendChild(cell);
    }
  }
  attachGridKeyboardNav(enemyGrid, (cell, r, c) => fireAt(r, c));
  updateTurnUI();
}

// Rebuild the battle screen from a server-provided snapshot (used on resume):
// replays every past shot on both boards so the UI looks exactly as it did
// before the player disconnected.
/** @param {import('./state.js').ServerMessage} msg */
export function buildBattleGridsFromSnapshot(msg) {
  state.placedShips = (msg.myShips || []).map((cells) => ({ cells }));
  buildBattleGrids();

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const against = msg.myShotsReceived[r][c];
      if (against) {
        const cls = against === 'miss' ? 'miss' : 'hit';
        markCell(selfCellEl(r, c), cls);
        state.ownShotsGrid[r][c] = cls;
      }
      const onOpp = msg.myShotsOnOpp[r][c];
      if (onOpp) {
        const cls = onOpp === 'miss' ? 'miss' : 'hit';
        markCell(enemyCellEl(r, c), cls);
        state.enemyShotsGrid[r][c] = cls;
      }
    }
  }

  // own ships that are fully hit get the "sunk" skull styling
  for (const ship of state.placedShips) {
    const allHit = ship.cells.every(([r, c]) => msg.myShotsReceived[r][c]);
    if (allHit) {
      ship.cells.forEach(([r, c]) => {
        markCell(selfCellEl(r, c), 'sunk');
        state.ownShotsGrid[r][c] = 'sunk';
      });
    }
  }

  // server tells us exactly which enemy ships we've sunk
  (msg.sunkEnemyShips || []).forEach((cells) => {
    cells.forEach(([r, c]) => {
      markCell(enemyCellEl(r, c), 'sunk');
      state.enemyShotsGrid[r][c] = 'sunk';
    });
    paintShipHull(cells, enemyCellEl);
  });
}

/** @param {number} r @param {number} c */
export function selfCellEl(r, c) {
  return document.querySelector(`#grid-self .cell[data-r="${r}"][data-c="${c}"]`);
}
/** @param {number} r @param {number} c */
export function enemyCellEl(r, c) {
  return document.querySelector(`#grid-enemy .cell[data-r="${r}"][data-c="${c}"]`);
}

export function updateTurnUI() {
  const el = $('battle-turn');
  el.textContent = state.myTurn ? t('battle.myTurn') : t('battle.oppTurn');
  el.className = 'battle-turn ' + (state.myTurn ? 'my-turn' : 'opp-turn');
  $('grid-enemy')
    .querySelectorAll('.cell')
    .forEach((el) => {
      el.classList.toggle('disabled', !state.myTurn);
    });
  announce(el.textContent);
}

/** @param {number} r @param {number} c */
export function fireAt(r, c) {
  if (!state.myTurn) return;
  if (state.enemyShotsGrid[r][c]) return;
  sfx.fire();
  vibrate(15); // tiny tactile tick on the tap itself
  sendMsg({ type: 'fire', r, c });
}

/** @param {Element|null} el @param {'miss'|'hit'|'sunk'} cls */
export function markCell(el, cls) {
  if (!el) return;
  el.classList.remove('miss', 'hit', 'sunk');
  el.classList.add(cls);
  if (el.hasAttribute('role')) {
    const stateLabel = cls === 'miss' ? t('cellState.miss') : cls === 'sunk' ? t('cellState.sunk') : t('cellState.hit');
    el.setAttribute(
      'aria-label',
      t('cell.ariaLabel', { cell: cellLabel(Number(el.dataset.r), Number(el.dataset.c)), state: stateLabel }),
    );
  }
}

// Plays a one-shot explosion/splash/sinking animation over a cell. Purely
// cosmetic — only called for shots that just happened live, never when
// silently rebuilding the board after a resume/reload.
/** @param {Element|null} el @param {'miss'|'hit'|'sunk'} kind */
export function spawnImpactFx(el, kind) {
  if (!el) return;
  const fx = document.createElement('div');
  fx.className = `fx fx-${kind}`;
  if (kind === 'miss') {
    fx.innerHTML = '<span class="fx-splash-ring"></span><span class="fx-splash-ring fx-splash-ring2"></span>';
  } else {
    const sparkCount = kind === 'sunk' ? 8 : 6;
    let sparks = '';
    for (let i = 0; i < sparkCount; i++) {
      sparks += `<span class="fx-spark" style="--angle:${Math.round((360 / sparkCount) * i)}deg"></span>`;
    }
    let bubbles = '';
    if (kind === 'sunk') {
      for (let i = 0; i < 4; i++) {
        bubbles += `<span class="fx-bubble" style="--bx:${15 + i * 22}%; animation-delay:${260 + i * 90}ms"></span>`;
      }
    }
    fx.innerHTML = `<span class="fx-ring"></span><span class="fx-core"></span>${sparks}${bubbles}`;
  }
  el.appendChild(fx);
  const impactClass = kind === 'sunk' ? 'impact-sunk' : kind === 'hit' ? 'impact-hit' : 'impact-miss';
  el.classList.add(impactClass);
  const cleanupDelay = kind === 'sunk' ? 900 : 550;
  setTimeout(() => {
    fx.remove();
    el.classList.remove(impactClass);
  }, cleanupDelay);
}
