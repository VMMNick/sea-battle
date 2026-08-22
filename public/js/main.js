'use strict';
// Entry point: wires every DOM event listener, owns the settings-panel UI,
// and translates incoming server messages (handleMessage) into calls on the
// other modules. Kept as the one "orchestrator" module — everything else
// only flows one way, into here, which avoids any circular imports.

import { state } from './state.js';
import { $, screens, showScreen, setStatus, announce, showOppBanner, hideOppBanner, paintShipHull } from './dom.js';
import {
  saveSession,
  loadSession,
  clearSession,
  settings,
  saveSettings,
  applyTheme,
  recordResult,
  hasSeenOnboarding,
  markOnboardingSeen,
} from './storage.js';
import { vibrationSupported, sfx, vibrate } from './sound.js';
import { connect, sendMsg } from './network.js';
import { resetPlacement, restorePlacementReady, toggleRotation, placeRandomFleet } from './placement.js';
import {
  buildBattleGrids,
  buildBattleGridsFromSnapshot,
  updateTurnUI,
  logShot,
  markCell,
  spawnImpactFx,
  selfCellEl,
  enemyCellEl,
} from './battle.js';
import { resetChat, handleChatMessage, handleReactionMessage, sendChatText, sendReaction } from './chat.js';
import { t, getLocale, setLocale } from './i18n.js';

function setEnemyBoardTitle() {
  $('enemy-board-title').textContent = state.vsBot ? t('battle.enemyFleetBot') : t('battle.enemyFleet');
  // Chatting with the bot serves no purpose, so hide the whole widget for bot games.
  $('chat-wrap').classList.toggle('hidden', state.vsBot);
}

/** The nickname sent along with create/join/quick_match, used only for the global leaderboard. */
function currentNickname() {
  return (settings.nickname || '').trim().slice(0, 20);
}

/** Localizes a server `error`/`resume_failed` message: prefer the errorCode when present, fall back to the raw (Ukrainian) message from the server. */
function localizeServerError(msg, namespace) {
  if (msg.errorCode) return t(`${namespace}.${msg.errorCode}`, msg.errorVars);
  return msg.message;
}

/** @param {import('./state.js').LeaderboardEntry[]} top */
function renderLeaderboard(top) {
  const list = $('leaderboard-list');
  list.innerHTML = '';
  $('leaderboard-empty').classList.toggle('hidden', top.length > 0);
  const medals = ['🥇', '🥈', '🥉'];
  top.forEach((entry, i) => {
    const li = document.createElement('li');
    li.className = 'leaderboard-entry';
    const rank = document.createElement('span');
    rank.className = 'leaderboard-rank';
    rank.textContent = medals[i] || String(i + 1);
    const name = document.createElement('span');
    name.className = 'leaderboard-name';
    name.textContent = entry.name;
    const score = document.createElement('span');
    score.className = 'leaderboard-score';
    score.textContent = t('leaderboard.score', { wins: entry.wins, games: entry.games });
    li.append(rank, name, score);
    list.appendChild(li);
  });
}

// ---------- Invite links (?code=XXXX) ----------
// A shared room link pre-fills the join field and auto-joins on first
// connect, so the other player only has to open the link — no typing.
// Cleared from the address bar immediately so a later refresh (or a
// reconnect after a dropped connection) doesn't retry a stale/used code.
state.inviteCode = (new URLSearchParams(location.search).get('code') || '').toUpperCase().trim();
if (state.inviteCode) {
  $('input-code').value = state.inviteCode;
  history.replaceState(null, '', location.pathname);
}

// ---------- Settings panel (sound / vibration / theme / language) ----------
function initSettingsUI() {
  const btn = $('btn-settings');
  const panel = $('settings-panel');
  const soundToggle = $('toggle-sound');
  const vibToggle = $('toggle-vibration');
  const themeToggle = $('toggle-theme');
  const nicknameInput = $('input-nickname');
  const langButtons = [$('btn-lang-uk'), $('btn-lang-en')];

  soundToggle.checked = settings.sound;
  vibToggle.checked = settings.vibration;
  themeToggle.checked = settings.lightTheme;
  nicknameInput.value = settings.nickname || '';
  nicknameInput.addEventListener('input', () => {
    settings.nickname = nicknameInput.value;
    saveSettings();
  });

  function syncLangButtons() {
    const locale = getLocale();
    langButtons.forEach((b) => {
      const active = b.dataset.locale === locale;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', String(active));
    });
  }
  syncLangButtons();
  langButtons.forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.locale === getLocale()) return;
      settings.locale = b.dataset.locale;
      saveSettings();
      setLocale(settings.locale);
      syncLangButtons();
      // Re-apply the few pieces of dynamic text that are visible right now
      // and depend on locale but aren't covered by data-i18n (the vibration
      // support notice, and the enemy-board title, which varies by vsBot so
      // it's deliberately not driven by a static data-i18n attribute).
      if (vibToggle.disabled) {
        vibToggle.closest('.settings-row').title = t('settings.vibrationUnsupported');
      }
      setEnemyBoardTitle();
    });
  });

  if (!vibrationSupported) {
    vibToggle.checked = false;
    vibToggle.disabled = true;
    const row = vibToggle.closest('.settings-row');
    row.classList.add('disabled-row');
    row.title = t('settings.vibrationUnsupported');
  }

  soundToggle.addEventListener('change', () => {
    settings.sound = soundToggle.checked;
    saveSettings();
  });
  vibToggle.addEventListener('change', () => {
    settings.vibration = vibToggle.checked;
    saveSettings();
  });
  themeToggle.addEventListener('change', () => {
    settings.lightTheme = themeToggle.checked;
    saveSettings();
    applyTheme();
  });

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('hidden') && e.target !== btn && !panel.contains(e.target)) {
      panel.classList.add('hidden');
    }
  });
}
initSettingsUI();

// ---------- Onboarding tutorial ----------
// Shown automatically once, on a browser's very first visit (no saved
// session — see the boot section at the bottom), and reopenable any time via
// the ❓ button in the header. Dismissing it by any means (close button,
// clicking the backdrop, or Escape) marks it seen so it doesn't pop up again.
function openOnboarding() {
  $('onboarding-overlay').classList.remove('hidden');
  $('btn-onboarding-close').focus();
}
function closeOnboarding() {
  $('onboarding-overlay').classList.add('hidden');
  markOnboardingSeen();
}
$('btn-help').addEventListener('click', openOnboarding);
$('btn-onboarding-close').addEventListener('click', closeOnboarding);
$('onboarding-overlay').addEventListener('click', (e) => {
  if (e.target === $('onboarding-overlay')) closeOnboarding();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('onboarding-overlay').classList.contains('hidden')) closeOnboarding();
});

// ---------- Menu ----------
$('btn-create').addEventListener('click', () => {
  $('menu-error').textContent = '';
  sendMsg({ type: 'create', nickname: currentNickname() });
});

$('btn-quick-match').addEventListener('click', () => {
  $('menu-error').textContent = '';
  showScreen('quickmatch');
  setStatus(t('status.searchingQuickMatch'));
  sendMsg({ type: 'quick_match', nickname: currentNickname() });
});
$('btn-cancel-quickmatch').addEventListener('click', () => {
  sendMsg({ type: 'leave' });
  backToMenu();
});

// ---------- Leaderboard ----------
$('btn-leaderboard').addEventListener('click', () => {
  if (isMidGameScreen() && !confirm(t('confirm.leaveGameForLeaderboard'))) return;
  if (isMidGameScreen()) {
    sendMsg({ type: 'leave' });
    backToMenu();
  }
  $('leaderboard-list').innerHTML = '';
  $('leaderboard-empty').classList.add('hidden');
  showScreen('leaderboard');
  sendMsg({ type: 'get_leaderboard' });
});
$('btn-leaderboard-back').addEventListener('click', () => {
  showScreen('menu');
});

// ---------- Bot difficulty picker ----------
const DIFFICULTY_LABEL_KEY = { easy: 'difficulty.easy', smart: 'difficulty.smart', expert: 'difficulty.expert' };
document.querySelectorAll('.btn-diff').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.botDifficulty = btn.dataset.difficulty;
    document.querySelectorAll('.btn-diff').forEach((b) => {
      const active = b === btn;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', String(active));
    });
  });
});

$('btn-create-bot').addEventListener('click', () => {
  $('menu-error').textContent = '';
  sendMsg({ type: 'create_bot', difficulty: state.botDifficulty, nickname: currentNickname() });
});
$('btn-join').addEventListener('click', joinRoom);
$('input-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});
function joinRoom() {
  const code = $('input-code').value.trim().toUpperCase();
  $('menu-error').textContent = '';
  if (!code) return;
  sendMsg({ type: 'join', code, nickname: currentNickname() });
}

$('btn-copy-code').addEventListener('click', () => {
  const link = `${location.origin}${location.pathname}?code=${state.roomCode}`;
  navigator.clipboard?.writeText(link).catch(() => {});
  $('btn-copy-code').textContent = t('waiting.copied');
  setTimeout(() => {
    $('btn-copy-code').textContent = t('waiting.copy');
  }, 1800);
});

function backToMenu() {
  state.myPlayer = null;
  state.roomCode = null;
  state.hasHydrated = false;
  state.vsBot = false;
  clearSession();
  hideOppBanner();
  $('input-code').value = '';
  $('menu-error').textContent = '';
  showScreen('menu');
  setStatus(t('status.connected'));
}

// ---------- Кнопка "на головну" (доступна з будь-якого екрана) ----------
function isMidGameScreen() {
  return (
    !screens.waiting.classList.contains('hidden') ||
    !screens.quickmatch.classList.contains('hidden') ||
    !screens.placement.classList.contains('hidden') ||
    !screens.battle.classList.contains('hidden')
  );
}
$('btn-home').addEventListener('click', () => {
  const alreadyHome = !screens.menu.classList.contains('hidden') || !screens.resuming.classList.contains('hidden');
  if (alreadyHome) return;
  if (isMidGameScreen() && !confirm(t('confirm.leaveGame'))) return;
  sendMsg({ type: 'leave' });
  backToMenu();
});

$('btn-cancel-waiting').addEventListener('click', () => {
  sendMsg({ type: 'leave' });
  backToMenu();
});

// ---------- Placement wiring ----------
$('btn-rotate').addEventListener('click', toggleRotation);
window.addEventListener('keydown', (e) => {
  if ((e.key === 'r' || e.key === 'R') && !screens.placement.classList.contains('hidden')) {
    toggleRotation();
  }
});
$('btn-clear').addEventListener('click', resetPlacement);
$('btn-random').addEventListener('click', placeRandomFleet);
$('btn-ready').addEventListener('click', () => {
  sendMsg({ type: 'place', ships: state.placedShips });
  $('btn-ready').disabled = true;
});

// ---------- Chat & emoji-reaction wiring ----------
document.querySelectorAll('.btn-reaction').forEach((btn) => {
  btn.addEventListener('click', () => sendReaction(btn.dataset.emoji));
});
$('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chat-input');
  sendChatText(input.value);
  input.value = '';
});

// ---------- Message handling ----------
/** @param {import('./state.js').ServerMessage} msg */
function handleMessage(msg) {
  switch (msg.type) {
    case 'created':
      state.myPlayer = msg.player;
      state.roomCode = msg.code;
      state.hasHydrated = true;
      state.vsBot = false;
      setEnemyBoardTitle();
      saveSession({ code: msg.code, token: msg.token, player: msg.player });
      $('room-code').textContent = state.roomCode;
      showScreen('waiting');
      setStatus(t('status.roomCreated', { code: state.roomCode }));
      break;

    case 'joined':
      state.myPlayer = msg.player;
      state.roomCode = msg.code;
      state.hasHydrated = true;
      state.vsBot = false;
      setEnemyBoardTitle();
      saveSession({ code: msg.code, token: msg.token, player: msg.player });
      setStatus(t('status.joinedRoom', { code: state.roomCode }));
      break;

    case 'bot_created':
      state.myPlayer = msg.player;
      state.roomCode = msg.code;
      state.hasHydrated = true;
      state.vsBot = true;
      saveSession({ code: msg.code, token: msg.token, player: msg.player, vsBot: true });
      setEnemyBoardTitle();
      resetPlacement();
      showScreen('placement');
      setStatus(t('status.botGame', { level: t(DIFFICULTY_LABEL_KEY[msg.difficulty] || 'difficulty.smart') }));
      break;

    case 'quick_match_waiting':
      showScreen('quickmatch');
      setStatus(t('status.searchingQuickMatch'));
      break;

    case 'quick_matched':
      state.myPlayer = msg.player;
      state.roomCode = msg.code;
      state.hasHydrated = true;
      state.vsBot = false;
      setEnemyBoardTitle();
      saveSession({ code: msg.code, token: msg.token, player: msg.player });
      setStatus(t('status.quickMatched'));
      break;

    case 'leaderboard':
      renderLeaderboard(msg.top || []);
      break;

    case 'error':
      $('menu-error').textContent = localizeServerError(msg, 'serverError');
      break;

    case 'server_restarting':
      // The server is about to close every connection for a deploy/restart.
      // The regular reconnect loop (see connect()) will keep retrying and
      // pick the session back up automatically once it's back — this is
      // just an early, friendlier heads-up before the "connection lost"
      // message would otherwise appear. The server always sends this in
      // Ukrainian, so it's ignored in favor of the localized text below.
      setStatus(t('status.serverRestarting'));
      announce(t('banner.serverRestartingAnnounce'));
      break;

    case 'resumed': {
      state.myPlayer = msg.player;
      state.roomCode = msg.code;
      state.vsBot = !!msg.oppIsBot;
      setEnemyBoardTitle();
      hideOppBanner();
      if (!msg.oppConnected && msg.oppPresent && (msg.phase === 'placement' || msg.phase === 'battle')) {
        showOppBanner(t('banner.opponentOffline'));
      }

      if (msg.phase === 'waiting') {
        $('room-code').textContent = state.roomCode;
        showScreen('waiting');
        setStatus(t('status.waitingRoom', { code: state.roomCode }));
      } else if (msg.phase === 'placement') {
        if (msg.amReady && msg.myShips) {
          restorePlacementReady(msg.myShips);
        } else if (!state.hasHydrated || state.placedShips.length === 0) {
          resetPlacement();
        } // else: keep whatever the player was already placing locally (quiet reconnect)
        $('opp-ready-note').classList.toggle('hidden', !msg.oppReady);
        showScreen('placement');
        setStatus(t('status.placeShips'));
      } else if (msg.phase === 'battle') {
        state.myTurn = msg.turn === state.myPlayer;
        buildBattleGridsFromSnapshot(msg);
        showScreen('battle');
        setStatus(t('status.battleResumed'));
      } else if (msg.phase === 'over') {
        const iWon = msg.winner === state.myPlayer;
        $('over-title').textContent = iWon ? t('over.win') : t('over.lose');
        $('rematch-note').classList.add('hidden');
        showScreen('over');
        setStatus(t('status.gameOver'));
      }
      state.hasHydrated = true;
      break;
    }

    case 'resume_failed':
      clearSession();
      backToMenu();
      $('menu-error').textContent = localizeServerError(msg, 'serverResumeError');
      break;

    case 'start_placement':
      resetPlacement();
      hideOppBanner();
      showScreen('placement');
      setStatus(t('status.placeShips'));
      break;

    case 'placement_ok':
      setStatus(t('status.placementAccepted'));
      break;

    case 'opponent_ready':
      $('opp-ready-note').classList.remove('hidden');
      break;

    case 'battle_start':
      state.myTurn = msg.turn === state.myPlayer;
      buildBattleGrids();
      resetChat();
      showScreen('battle');
      setStatus(t('status.battleStarted'));
      break;

    case 'chat':
      handleChatMessage(msg.from, msg.text);
      break;

    case 'reaction':
      handleReactionMessage(msg.from, msg.emoji);
      break;

    case 'fire_result': {
      const { by, r, c, result, shipCells, turn } = msg;
      const iAmShooter = by === state.myPlayer;
      const cellFor = iAmShooter ? enemyCellEl : selfCellEl;
      const gridFor = iAmShooter ? state.enemyShotsGrid : state.ownShotsGrid;
      logShot(iAmShooter, r, c, result);
      if (result === 'sunk' || result === 'win') {
        // reveal + animate every cell of the ship that just went down
        const cells = shipCells && shipCells.length ? shipCells : [[r, c]];
        cells.forEach(([sr, sc]) => {
          const el = cellFor(sr, sc);
          markCell(el, 'sunk');
          gridFor[sr][sc] = 'sunk';
          spawnImpactFx(el, 'sunk');
        });
        paintShipHull(cells, cellFor); // own ships are already painted; this reveals a sunk enemy hull
        sfx.sunk();
        vibrate(iAmShooter ? [50, 40, 50, 40, 100] : [80, 50, 80, 50, 150]);
      } else {
        const cls = result === 'miss' ? 'miss' : 'hit';
        const el = cellFor(r, c);
        markCell(el, cls);
        gridFor[r][c] = cls;
        spawnImpactFx(el, cls);
        if (cls === 'miss') {
          sfx.miss();
        } else if (iAmShooter) {
          sfx.hit();
          vibrate(60);
        } else {
          sfx.hitOnMe();
          vibrate(90);
        }
      }
      state.myTurn = turn === state.myPlayer;
      updateTurnUI();
      break;
    }

    case 'game_over': {
      const iWon = msg.winner === state.myPlayer;
      $('over-title').textContent = iWon ? t('over.win') : t('over.lose');
      $('rematch-note').classList.add('hidden');
      showScreen('over');
      setStatus(t('status.gameOver'));
      announce($('over-title').textContent);
      recordResult(iWon, state.vsBot);
      if (iWon) {
        sfx.win();
        vibrate([100, 50, 100, 50, 200]);
      } else {
        sfx.lose();
        vibrate(300);
      }
      break;
    }

    case 'opponent_wants_rematch':
      $('rematch-note').classList.remove('hidden');
      break;

    case 'opponent_connection_lost':
      // Soft signal: the opponent's connection dropped, but the game state is
      // preserved server-side — they have a few minutes to reconnect. Don't
      // interrupt the current screen, just let the player know.
      showOppBanner(t('banner.opponentDisconnected'));
      break;

    case 'opponent_reconnected':
      showOppBanner(t('banner.opponentReconnected'), true);
      setTimeout(hideOppBanner, 2500);
      break;

    case 'opponent_gave_up':
      hideOppBanner();
      clearSession();
      setStatus(t('status.opponentGaveUp'));
      alert(t('alert.opponentGaveUp'));
      backToMenu();
      break;

    case 'opponent_left':
      setStatus(t('status.opponentLeft'));
      alert(t('alert.opponentLeft'));
      backToMenu();
      break;
  }
}

$('btn-rematch').addEventListener('click', () => {
  sendMsg({ type: 'rematch' });
  $('btn-rematch').disabled = true;
});

$('btn-menu').addEventListener('click', () => {
  clearSession();
  location.reload();
});

// ---------- Boot ----------
// Show the "resuming" screen immediately (before the socket even connects) so
// returning players don't see a flash of the main menu first.
if (loadSession()) {
  showScreen('resuming');
} else if (!hasSeenOnboarding()) {
  // First-ever visit (no saved session, tutorial never dismissed before) —
  // show the onboarding tutorial on top of the menu screen. Skipped for a
  // returning/resuming session so it never interrupts a reconnect.
  openOnboarding();
}
connect(handleMessage);
