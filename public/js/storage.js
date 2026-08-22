'use strict';
// Everything persisted in localStorage: the reconnect session, per-browser
// settings (sound/vibration/theme), and local win/loss stats. Nothing here
// ever talks to the server or the DOM beyond the theme class toggle and the
// stats-bar text, which are cheap, self-contained DOM writes.

import { $ } from './dom.js';
import { t, setLocale } from './i18n.js';

// ---------- Saved session (survives accidental tab close / refresh / dropped wifi) ----------
const SESSION_KEY = 'seabattle_session';

/** @param {import('./state.js').SessionData} data */
export function saveSession(data) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(data));
  } catch {
    /* ignore (private mode etc.) */
  }
}

/** @returns {import('./state.js').SessionData|null} */
export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

// ---------- Onboarding tutorial: has this browser already dismissed it? ----------
// A separate flag rather than part of Settings — it isn't a toggle the player
// chooses, just a one-time "seen it" marker set the first time the modal is
// closed (by any means: the close button, the backdrop, or Escape).
const ONBOARDING_SEEN_KEY = 'seabattle_onboarding_seen';

export function hasSeenOnboarding() {
  try {
    return localStorage.getItem(ONBOARDING_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markOnboardingSeen() {
  try {
    localStorage.setItem(ONBOARDING_SEEN_KEY, '1');
  } catch {
    /* ignore */
  }
}

// ---------- Settings: sound, vibration & theme (saved across sessions) ----------
// Кожен налаштовує це для себе — значення живуть у localStorage конкретного
// браузера/пристрою, тож у різних гравців можуть бути різні перемикачі.
const SETTINGS_KEY = 'seabattle_settings';

/** @returns {import('./state.js').Settings} */
export function loadSettings() {
  // Until the player has ever touched a toggle, follow the system's
  // light/dark preference; the moment any setting is saved, that saved
  // value always wins over the system preference from then on (see the
  // matching detection in the inline <head> script that avoids a flash).
  const systemPrefersLight =
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
  // The UI language always defaults to Ukrainian regardless of the browser's
  // language — deliberately not auto-detected from navigator.language, so
  // switching to English is always an explicit choice in settings.
  const defaults = { sound: true, vibration: true, lightTheme: systemPrefersLight, nickname: '', locale: 'uk' };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
  } catch {
    return defaults;
  }
}

export function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

/** @type {import('./state.js').Settings} */
export const settings = loadSettings();

export function applyTheme() {
  document.documentElement.classList.toggle('light-theme', !!settings.lightTheme);
}
applyTheme(); // синхронізує стан на випадок, якщо ранній inline-скрипт у <head> не спрацював (private mode тощо)

// Applied here (not in main.js) so the static UI text is already translated
// — and state.locale already set — before anything below renders (e.g. the
// stats bar just below), including modules that import settings/state later.
setLocale(settings.locale);

// ---------- Local win/loss stats (per-browser, no server involved) ----------
const STATS_KEY = 'seabattle_stats';

/** @returns {import('./state.js').Stats} */
export function loadStats() {
  const defaults = { vsBot: { wins: 0, losses: 0 }, vsHuman: { wins: 0, losses: 0 } };
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw);
    return {
      vsBot: { ...defaults.vsBot, ...parsed.vsBot },
      vsHuman: { ...defaults.vsHuman, ...parsed.vsHuman },
    };
  } catch {
    return defaults;
  }
}

export function saveStats() {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch {
    /* ignore */
  }
}

/** @type {import('./state.js').Stats} */
export const stats = loadStats();

/**
 * @param {boolean} won
 * @param {boolean} vsBot Whether this game was against the bot.
 */
export function recordResult(won, vsBot) {
  const bucket = vsBot ? stats.vsBot : stats.vsHuman;
  if (won) bucket.wins++;
  else bucket.losses++;
  saveStats();
  renderStats();
}

export function renderStats() {
  const el = $('stats-bar');
  if (!el) return;
  const { vsBot: b, vsHuman: h } = stats;
  const parts = [];
  if (b.wins || b.losses) parts.push(t('stats.vsBot', { wins: b.wins, losses: b.losses }));
  if (h.wins || h.losses) parts.push(t('stats.vsHuman', { wins: h.wins, losses: h.losses }));
  el.textContent = parts.join('   ·   ');
  el.classList.toggle('hidden', parts.length === 0);
}
renderStats();
