'use strict';
// Minimal i18n layer: a flat dictionary per locale plus a t(key, vars)
// lookup, and a DOM walker that applies translations to any element marked
// with data-i18n* attributes. There is no framework here on purpose — the
// whole app is small enough that a plain object dictionary is easier to
// audit than pulling in a library.
//
// Switching locale re-translates the static chrome (buttons, labels,
// placeholders, aria-labels) immediately via translateStaticDom(). Text
// that was already written dynamically (the current status-bar message, a
// chat log entry that already arrived, etc.) is intentionally left as-is —
// re-deriving "what should the status bar say right now" for every screen
// would add a lot of state-tracking for a cosmetic mid-game edge case.

import { state } from './state.js';

/** @typedef {'uk'|'en'} Locale */

const STRINGS = {
  uk: {
    // ---- Static chrome: header, settings panel ----
    'app.title': 'Морський бій онлайн',
    'app.heading': '⚓ Морський бій',
    'header.home': 'На головну',
    'header.leaderboard': 'Таблиця лідерів',
    'header.help': 'Як грати',
    'header.settings': 'Налаштування звуку, вібрації та теми',
    'header.settingsTitle': 'Налаштування',
    'settings.nicknameLabel': '🧑‍✈️ Нікнейм',
    'settings.nicknamePlaceholder': 'Капітан',
    'settings.nicknameAria': 'Ваш нікнейм на таблиці лідерів',
    'settings.sound': '🔊 Звук',
    'settings.vibration': '📳 Вібрація',
    'settings.theme': '☀️ Світла тема',
    'settings.language': '🌐 Мова / Language',
    'settings.vibrationUnsupported': 'Вібрація не підтримується цим пристроєм чи браузером',

    // ---- Onboarding tutorial (shown on first visit; reopenable via header ❓) ----
    'onboarding.title': '👋 Як грати',
    'onboarding.step1':
      '🎯 Створіть гру й поділіться кодом, приєднайтеся за кодом друга, або натисніть «⚡ Швидка гра» — сервер миттєво знайде суперника. Можна й проти бота: оберіть складність і починайте одразу.',
    'onboarding.step2':
      '🚢 Розставте кораблі: клік на клітинку — поставити, клавіша R або кнопка ⟳ — обертати, «🎲 Випадково» — розставити миттєво.',
    'onboarding.step3':
      '💥 У бою стріляйте по клітинках суперника (клік по правій дошці). Влучання дає ще один постріл. Перемагає той, хто першим потопить увесь ворожий флот.',
    'onboarding.step4':
      '💬 У грі проти іншого гравця доступні чат і emoji-реакції, а перемоги потрапляють у таблицю лідерів 🏆 — встановіть нікнейм у налаштуваннях ⚙️.',
    'onboarding.step5': '🌐 Мову інтерфейсу, звук, вібрацію й тему можна будь-коли змінити в налаштуваннях ⚙️.',
    'onboarding.close': 'Зрозуміло, почати гру',

    // ---- Resuming screen ----
    'resuming.title': 'Відновлюємо вашу гру…',
    'resuming.hint': 'Ви виходили з незавершеної партії — повертаємо вас туди, де зупинились.',

    // ---- Menu screen ----
    'menu.createTitle': '🎯 Створити гру',
    'menu.createBody': 'Отримайте код і надішліть його другу, щоб пограти онлайн.',
    'menu.createBtn': 'Створити нову гру',
    'menu.quickTitle': '⚡ Швидка гра',
    'menu.quickBody': 'Миттєво приєднаємо вас до іншого гравця, який теж шукає партію просто зараз.',
    'menu.quickBtn': 'Знайти суперника',
    'menu.botTitle': '🤖 Грати проти бота',
    'menu.botBody': "Без другого гравця — розставте кораблі й одразу починайте бій проти комп'ютера.",
    'menu.diffEasy': '🎯 Легкий',
    'menu.diffSmart': '🧠 Розумний',
    'menu.diffExpert': '🎓 Експерт',
    'menu.botBtn': 'Грати проти бота',
    'menu.joinTitle': 'Приєднатися до гри',
    'menu.joinBody': 'Введіть код кімнати, який вам надіслали.',
    'menu.joinCodePlaceholder': 'КОД',
    'menu.joinBtn': 'Приєднатися',

    // ---- Leaderboard screen ----
    'leaderboard.title': '🏆 Таблиця лідерів',
    'leaderboard.hint':
      "Перемоги в іграх проти інших гравців (не проти бота). Встановіть свій нікнейм у налаштуваннях ⚙️, щоб з'явитися тут.",
    'leaderboard.empty': 'Поки що немає жодної завершеної гри між гравцями.',
    'leaderboard.back': 'У головне меню',
    'leaderboard.score': '{wins} перемог · {games} ігор',

    // ---- Waiting / quick-match screens ----
    'waiting.title': 'Очікуємо суперника…',
    'waiting.body': 'Надішліть цей код другу або скопіюйте посилання — за ним гра відкриється й одразу приєднає:',
    'waiting.copy': 'Скопіювати посилання',
    'waiting.copied': 'Посилання скопійовано!',
    'waiting.cancel': 'Скасувати',
    'quickmatch.title': 'Шукаємо суперника…',
    'quickmatch.body': 'Ви приєднаєтесь автоматично, щойно знайдеться інший гравець, який теж шукає партію.',
    'quickmatch.cancel': 'Скасувати',

    // ---- Placement screen ----
    'placement.title': 'Розставте кораблі',
    'placement.hintHtml':
      'Клікніть на клітинку, щоб поставити корабель. Клавіша <b>R</b> або кнопка — обертання. Кораблі не можуть торкатися одне одного.',
    'placement.rotate': '⟳ Обертати (R)',
    'placement.random': '🎲 Випадково',
    'placement.clear': '✕ Очистити',
    'placement.ready': 'Готово, чекати суперника',
    'placement.oppReady': 'Суперник вже готовий і чекає на вас!',
    'placement.ownBoardAria': 'Ваше поле для розстановки кораблів',

    // ---- Battle screen ----
    'battle.turnPlaceholder': 'Хід гравця…',
    'battle.myFleet': 'Ваш флот',
    'battle.enemyFleet': 'Флот суперника',
    'battle.enemyFleetBot': 'Флот бота 🤖',
    'battle.enemyBoardAria': 'Поле суперника — обирайте клітинку для пострілу',
    'battle.myTurn': 'Ваш хід — стріляйте по флоту суперника',
    'battle.oppTurn': 'Хід суперника — очікуйте',
    'battle.shotLogTitle': 'Історія пострілів',
    'battle.shotLogEmpty': "Постріли з'являться тут",

    // ---- Over screen ----
    'over.title': 'Гру завершено',
    'over.rematch': 'Реванш',
    'over.menu': 'У головне меню',
    'over.oppWantsRematch': 'Суперник хоче реванш!',
    'over.win': '🎉 Перемога! Ви розгромили флот суперника.',
    'over.lose': '💥 Поразка. Ваш флот знищено.',

    // ---- Chat & reactions ----
    'chat.title': '💬 Чат із суперником',
    'chat.empty': 'Напишіть щось суперникові — повідомлення бачите тільки ви двоє.',
    'chat.inputPlaceholder': 'Повідомлення…',
    'chat.inputAria': 'Повідомлення в чат',
    'chat.you': 'Ви',
    'chat.opponent': 'Суперник',
    'chat.entry': '{who}: {text}',
    'chat.reactionThumbsUp': 'Реакція: палець вгору',
    'chat.reactionLaugh': 'Реакція: сміх',
    'chat.reactionShock': 'Реакція: шок',
    'chat.reactionFire': 'Реакція: вогонь',
    'chat.reactionTarget': 'Реакція: влучання',
    'chat.reactionClap': 'Реакція: оплески',

    // ---- Shot log & cell labels (battle.js) ----
    'shotLog.bot': 'Бот',
    'shotLog.miss': 'промах',
    'shotLog.sunk': 'потоплено!',
    'shotLog.hit': 'влучання',
    'shotLog.entry': '{who}: {cell} — {label}',
    'cellState.miss': 'промах',
    'cellState.hit': 'влучання',
    'cellState.sunk': 'потоплено',
    'cell.ariaLabel': 'Клітинка {cell} — {state}',

    // ---- Status bar / banners / dialogs (main.js) ----
    'status.connecting': 'Підключення до сервера…',
    'status.connected': 'Підключено до сервера',
    'status.disconnected': 'З’єднання втрачено. Перепідключення…',
    'status.connectionError': 'Помилка з’єднання',
    'status.roomCreated': 'Кімната {code} створена. Ви — гравець 1.',
    'status.joinedRoom': 'Ви приєдналися до кімнати {code}. Ви — гравець 2.',
    'status.botGame': 'Гра проти бота ({level} рівень). Розставте кораблі та натисніть «Готово».',
    'status.searchingQuickMatch': 'Шукаємо суперника для швидкої гри…',
    'status.quickMatched': 'Суперника знайдено! Готуємось до розстановки…',
    'status.waitingRoom': 'Кімната {code}. Очікуємо суперника…',
    'status.placeShips': 'Розставте кораблі та натисніть «Готово».',
    'status.battleResumed': 'Бій триває — з поверненням!',
    'status.gameOver': 'Гру завершено.',
    'status.placementAccepted': 'Кораблі прийнято сервером. Очікуємо суперника…',
    'status.battleStarted': 'Бій розпочався!',
    'status.serverRestarting': 'Сервер оновлюється. Перепідключення…',
    'status.opponentGaveUp': 'Суперник не повернувся вчасно — гру завершено.',
    'status.opponentLeft': 'Суперник скасував гру.',
    'banner.serverRestartingAnnounce': 'Сервер оновлюється, зачекайте на перепідключення.',
    'banner.opponentOffline': 'Суперник наразі офлайн — очікуємо, поки він повернеться…',
    'banner.opponentDisconnected': "Суперник тимчасово втратив з'єднання — очікуємо, поки він повернеться…",
    'banner.opponentReconnected': 'Суперник повернувся!',
    'alert.opponentGaveUp': 'Суперник не повернувся вчасно. Гру завершено.',
    'alert.opponentLeft': 'Суперник скасував гру.',
    'confirm.leaveGame': 'Покинути поточну гру та повернутися на головну?',
    'confirm.leaveGameForLeaderboard': 'Покинути поточну гру та переглянути таблицю лідерів?',
    'difficulty.easy': 'легкий',
    'difficulty.smart': 'розумний',
    'difficulty.expert': 'експерт',

    // ---- Local stats (storage.js) ----
    'stats.vsBot': '🤖 проти бота — {wins} перемог, {losses} поразок',
    'stats.vsHuman': '👤 проти людей — {wins} перемог, {losses} поразок',

    // ---- Server-sent error codes (server.js `errorCode`) ----
    'serverError.too_many_room_actions': 'Забагато спроб поспіль. Зачекайте трохи і спробуйте ще раз.',
    'serverError.join_locked': 'Забагато невдалих спроб приєднання. Спробуйте ще раз через {seconds} с.',
    'serverError.room_not_found': 'Кімнату не знайдено. Перевірте код.',
    'serverError.room_full': 'Кімната вже заповнена.',
    'serverError.too_many_chat': 'Забагато повідомлень поспіль. Зачекайте трохи.',
    'serverError.invalid_placement': 'Некоректне розташування кораблів.',
    'serverError.too_many_shots': 'Забагато пострілів поспіль. Зачекайте секунду.',
    'serverError.not_your_turn': 'Зараз не ваш хід.',
    'serverError.already_fired': 'Сюди вже стріляли.',
    'serverResumeError.resume_not_found': 'Цю гру не знайдено — можливо, вона вже завершилась.',
    'serverResumeError.resume_lost': 'Не вдалося відновити сесію цієї гри.',
  },
  en: {
    'app.title': 'Battleship Online',
    'app.heading': '⚓ Battleship',
    'header.home': 'Home',
    'header.leaderboard': 'Leaderboard',
    'header.help': 'How to play',
    'header.settings': 'Sound, vibration & theme settings',
    'header.settingsTitle': 'Settings',
    'settings.nicknameLabel': '🧑‍✈️ Nickname',
    'settings.nicknamePlaceholder': 'Captain',
    'settings.nicknameAria': 'Your nickname on the leaderboard',
    'settings.sound': '🔊 Sound',
    'settings.vibration': '📳 Vibration',
    'settings.theme': '☀️ Light theme',
    'settings.language': '🌐 Мова / Language',
    'settings.vibrationUnsupported': "Vibration isn't supported by this device or browser",

    'onboarding.title': '👋 How to play',
    'onboarding.step1':
      '🎯 Create a game and share the code, join with a friend\'s code, or hit "⚡ Quick match" and we\'ll instantly pair you with someone. You can also play against the bot — pick a difficulty and start right away.',
    'onboarding.step2':
      '🚢 Place your ships: click a cell to place one, press R or the ⟳ button to rotate, "🎲 Random" places your whole fleet instantly.',
    'onboarding.step3':
      "💥 In battle, fire at your opponent's cells (click the board on the right). A hit earns you another shot. First to sink the entire enemy fleet wins.",
    'onboarding.step4':
      '💬 Games against another player include chat and emoji reactions, and wins count toward the leaderboard 🏆 — set a nickname in settings ⚙️.',
    'onboarding.step5': '🌐 Language, sound, vibration and theme can all be changed anytime in settings ⚙️.',
    'onboarding.close': "Got it, let's play",

    'resuming.title': 'Resuming your game…',
    'resuming.hint': 'You left an unfinished game — taking you back where you left off.',

    'menu.createTitle': '🎯 Create a game',
    'menu.createBody': 'Get a room code and send it to a friend to play online.',
    'menu.createBtn': 'Create new game',
    'menu.quickTitle': '⚡ Quick match',
    'menu.quickBody': "We'll instantly pair you with another player who's also looking for a game right now.",
    'menu.quickBtn': 'Find opponent',
    'menu.botTitle': '🤖 Play vs bot',
    'menu.botBody': 'No second player needed — place your ships and start battling the computer right away.',
    'menu.diffEasy': '🎯 Easy',
    'menu.diffSmart': '🧠 Smart',
    'menu.diffExpert': '🎓 Expert',
    'menu.botBtn': 'Play vs bot',
    'menu.joinTitle': 'Join a game',
    'menu.joinBody': 'Enter the room code you were sent.',
    'menu.joinCodePlaceholder': 'CODE',
    'menu.joinBtn': 'Join',

    'leaderboard.title': '🏆 Leaderboard',
    'leaderboard.hint':
      'Wins in games against other players (not the bot). Set a nickname in settings ⚙️ to show up here.',
    'leaderboard.empty': 'No completed games between players yet.',
    'leaderboard.back': 'Back to menu',
    'leaderboard.score': '{wins} wins · {games} games',

    'waiting.title': 'Waiting for an opponent…',
    'waiting.body': 'Send this code to a friend, or copy the link — opening it joins the game instantly:',
    'waiting.copy': 'Copy link',
    'waiting.copied': 'Link copied!',
    'waiting.cancel': 'Cancel',
    'quickmatch.title': 'Looking for an opponent…',
    'quickmatch.body': "You'll be paired automatically as soon as another player is looking for a game too.",
    'quickmatch.cancel': 'Cancel',

    'placement.title': 'Place your ships',
    'placement.hintHtml':
      'Click a cell to place a ship. Press <b>R</b> or the button to rotate. Ships can’t touch each other.',
    'placement.rotate': '⟳ Rotate (R)',
    'placement.random': '🎲 Random',
    'placement.clear': '✕ Clear',
    'placement.ready': 'Ready, wait for opponent',
    'placement.oppReady': 'Your opponent is already ready and waiting for you!',
    'placement.ownBoardAria': 'Your board for placing ships',

    'battle.turnPlaceholder': "Player's turn…",
    'battle.myFleet': 'Your fleet',
    'battle.enemyFleet': "Opponent's fleet",
    'battle.enemyFleetBot': "Bot's fleet 🤖",
    'battle.enemyBoardAria': "Opponent's board — pick a cell to fire at",
    'battle.myTurn': 'Your turn — fire at the enemy fleet',
    'battle.oppTurn': "Opponent's turn — please wait",
    'battle.shotLogTitle': 'Shot history',
    'battle.shotLogEmpty': 'Shots will appear here',

    'over.title': 'Game over',
    'over.rematch': 'Rematch',
    'over.menu': 'Back to menu',
    'over.oppWantsRematch': 'Your opponent wants a rematch!',
    'over.win': '🎉 Victory! You destroyed the enemy fleet.',
    'over.lose': '💥 Defeat. Your fleet has been sunk.',

    'chat.title': '💬 Chat with opponent',
    'chat.empty': 'Say something to your opponent — only the two of you can see it.',
    'chat.inputPlaceholder': 'Message…',
    'chat.inputAria': 'Chat message',
    'chat.you': 'You',
    'chat.opponent': 'Opponent',
    'chat.entry': '{who}: {text}',
    'chat.reactionThumbsUp': 'Reaction: thumbs up',
    'chat.reactionLaugh': 'Reaction: laugh',
    'chat.reactionShock': 'Reaction: shock',
    'chat.reactionFire': 'Reaction: fire',
    'chat.reactionTarget': 'Reaction: bullseye',
    'chat.reactionClap': 'Reaction: applause',

    'shotLog.bot': 'Bot',
    'shotLog.miss': 'miss',
    'shotLog.sunk': 'sunk!',
    'shotLog.hit': 'hit',
    'shotLog.entry': '{who}: {cell} — {label}',
    'cellState.miss': 'miss',
    'cellState.hit': 'hit',
    'cellState.sunk': 'sunk',
    'cell.ariaLabel': 'Cell {cell} — {state}',

    'status.connecting': 'Connecting to server…',
    'status.connected': 'Connected to server',
    'status.disconnected': 'Connection lost. Reconnecting…',
    'status.connectionError': 'Connection error',
    'status.roomCreated': 'Room {code} created. You are player 1.',
    'status.joinedRoom': 'You joined room {code}. You are player 2.',
    'status.botGame': 'Game vs bot ({level} level). Place your ships and click "Ready".',
    'status.searchingQuickMatch': 'Looking for an opponent for a quick match…',
    'status.quickMatched': 'Opponent found! Getting ready to place ships…',
    'status.waitingRoom': 'Room {code}. Waiting for an opponent…',
    'status.placeShips': 'Place your ships and click "Ready".',
    'status.battleResumed': 'Battle in progress — welcome back!',
    'status.gameOver': 'Game over.',
    'status.placementAccepted': 'Ships accepted by the server. Waiting for opponent…',
    'status.battleStarted': 'Battle started!',
    'status.serverRestarting': 'Server is updating. Reconnecting…',
    'status.opponentGaveUp': "Opponent didn't come back in time — game over.",
    'status.opponentLeft': 'Opponent cancelled the game.',
    'banner.serverRestartingAnnounce': 'Server is updating, please wait to reconnect.',
    'banner.opponentOffline': 'Opponent is currently offline — waiting for them to return…',
    'banner.opponentDisconnected': 'Opponent lost connection temporarily — waiting for them to return…',
    'banner.opponentReconnected': 'Opponent is back!',
    'alert.opponentGaveUp': "Opponent didn't come back in time. Game over.",
    'alert.opponentLeft': 'Opponent cancelled the game.',
    'confirm.leaveGame': 'Leave the current game and go back to the menu?',
    'confirm.leaveGameForLeaderboard': 'Leave the current game and view the leaderboard?',
    'difficulty.easy': 'easy',
    'difficulty.smart': 'smart',
    'difficulty.expert': 'expert',

    'stats.vsBot': '🤖 vs bot — {wins} wins, {losses} losses',
    'stats.vsHuman': '👤 vs players — {wins} wins, {losses} losses',

    'serverError.too_many_room_actions': 'Too many attempts in a row. Wait a bit and try again.',
    'serverError.join_locked': 'Too many failed join attempts. Try again in {seconds}s.',
    'serverError.room_not_found': 'Room not found. Check the code.',
    'serverError.room_full': 'This room is already full.',
    'serverError.too_many_chat': 'Too many messages in a row. Wait a bit.',
    'serverError.invalid_placement': 'Invalid ship placement.',
    'serverError.too_many_shots': 'Too many shots in a row. Wait a second.',
    'serverError.not_your_turn': "It's not your turn.",
    'serverError.already_fired': "You've already fired there.",
    'serverResumeError.resume_not_found': "This game wasn't found — it may have already ended.",
    'serverResumeError.resume_lost': "Couldn't restore this game session.",
  },
};

export function getLocale() {
  return state.locale;
}

/** @param {Locale} loc */
export function setLocale(loc) {
  state.locale = STRINGS[loc] ? loc : 'uk';
  document.documentElement.lang = state.locale;
  document.documentElement.setAttribute('data-locale', state.locale);
  translateStaticDom();
}

/**
 * @param {string} key
 * @param {Record<string, string|number>} [vars]
 */
export function t(key, vars) {
  const dict = STRINGS[state.locale] || STRINGS.uk;
  let str = dict[key] ?? STRINGS.uk[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replaceAll(`{${k}}`, String(v));
    }
  }
  return str;
}

// Re-applies translations to every element in the current DOM marked with a
// data-i18n* attribute. Safe to call any time (boot, or after a language
// switch) — it only ever touches elements that opted in via the attribute.
export function translateStaticDom() {
  document.title = t('app.title');
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
}

/** Column letters for board cell labels ("Б4" / "B4") — locale-specific so English boards read as classic A–J notation. */
const COLS_BY_LOCALE = {
  uk: 'АБВГДЕЖЗИК'.split(''),
  en: 'ABCDEFGHIJ'.split(''),
};
export function currentCols() {
  return COLS_BY_LOCALE[state.locale] || COLS_BY_LOCALE.uk;
}
