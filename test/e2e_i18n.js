'use strict';
// E2E перевірка англійської локалізації та перемикача мови через реальний
// браузер: перемикання UA/EN миттєво перекладає статичний інтерфейс,
// вибір мови зберігається після перезавантаження сторінки, динамічні
// рядки (статус-бар, історія пострілів, aria-label клітинок з англійськими
// літерами колонок, локалізовані повідомлення про помилки від сервера)
// теж перекладаються, і кнопка таблиці лідерів реально клікабельна (раніше
// вона була перекрита кнопкою налаштувань — регресійна перевірка).
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://localhost:8123';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  // This test isn't exercising the onboarding tutorial — pre-seed the "seen"
  // flag so the modal doesn't pop up and intercept clicks (see
  // test/e2e_onboarding.js for the dedicated onboarding test).
  await ctx.addInitScript(() => localStorage.setItem('seabattle_onboarding_seen', '1'));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));

  await page.goto(URL);
  await page.waitForSelector('#screen-menu:not(.hidden)');

  const titleUk = await page.title();
  const createBtnUk = (await page.textContent('#btn-create')).trim();
  console.log('Default locale — title:', titleUk, '| create button:', createBtnUk);
  if (!titleUk.includes('Морський') || !createBtnUk.includes('Створити'))
    throw new Error('default locale is not Ukrainian as expected');

  // ---- Switch to English ----
  await page.click('#btn-settings');
  await page.click('#btn-lang-en');
  await page.click('h1'); // click outside to close the settings panel
  await page.waitForTimeout(150);

  const titleEn = await page.title();
  const createBtnEn = (await page.textContent('#btn-create')).trim();
  const htmlLang = await page.getAttribute('html', 'lang');
  console.log('After switching to EN — title:', titleEn, '| create button:', createBtnEn, '| <html lang>:', htmlLang);
  if (titleEn !== 'Battleship Online') throw new Error(`unexpected <title> after EN switch: "${titleEn}"`);
  if (createBtnEn !== 'Create new game') throw new Error(`unexpected create button text: "${createBtnEn}"`);
  if (htmlLang !== 'en') throw new Error(`<html lang> not updated: "${htmlLang}"`);

  // ---- Persists across reload ----
  await page.reload();
  await page.waitForSelector('#screen-menu:not(.hidden)');
  const createBtnAfterReload = (await page.textContent('#btn-create')).trim();
  console.log('After reload — create button:', createBtnAfterReload);
  if (createBtnAfterReload !== 'Create new game') throw new Error('English locale did not persist across reload');

  // ---- Leaderboard button is actually clickable (regression: was overlapped by settings button) ----
  await page.click('#btn-leaderboard', { timeout: 5000 });
  await page.waitForSelector('#screen-leaderboard:not(.hidden)', { timeout: 3000 });
  const leaderboardTitle = (await page.textContent('#screen-leaderboard h2')).trim();
  console.log('OK: leaderboard button is clickable, title:', leaderboardTitle);
  if (!leaderboardTitle.includes('Leaderboard')) throw new Error('leaderboard title not translated');
  await page.click('#btn-leaderboard-back');
  await page.waitForSelector('#screen-menu:not(.hidden)');

  // ---- Server-side error localization (errorCode -> translated text) ----
  await page.fill('#input-code', 'ZZZZ');
  await page.click('#btn-join');
  await page.waitForFunction(() => document.getElementById('menu-error').textContent.trim().length > 0, {
    timeout: 3000,
  });
  const joinError = (await page.textContent('#menu-error')).trim();
  console.log('Join error (EN):', joinError);
  if (!/room not found/i.test(joinError)) throw new Error(`join error not localized to English: "${joinError}"`);

  // ---- Dynamic in-game strings + locale-specific column letters ----
  await page.click('#btn-create-bot');
  await page.waitForSelector('#screen-placement:not(.hidden)', { timeout: 8000 });
  const placementTitle = (await page.textContent('#screen-placement h2')).trim();
  if (placementTitle !== 'Place your ships') throw new Error(`placement title not translated: "${placementTitle}"`);

  await page.click('#btn-random');
  await page.click('#btn-ready');
  await page.waitForSelector('#screen-battle:not(.hidden)', { timeout: 8000 });

  const enemyTitle = (await page.textContent('#enemy-board-title')).trim();
  console.log('Enemy fleet title (EN, bot game):', enemyTitle);
  if (!enemyTitle.startsWith("Bot's fleet")) throw new Error(`enemy fleet title not translated: "${enemyTitle}"`);

  await page.click('#grid-enemy .cell[data-r="5"][data-c="5"]');
  await page.waitForTimeout(500);
  const shotLogEntry = (await page.textContent('#shot-log li')).trim();
  console.log('Shot log entry (EN):', shotLogEntry);
  if (!/^You: F6 —/.test(shotLogEntry))
    throw new Error(`shot log entry not in English/wrong column letters: "${shotLogEntry}"`);

  const cellAria = await page.getAttribute('#grid-enemy .cell[data-r="5"][data-c="5"]', 'aria-label');
  console.log('Cell aria-label (EN):', cellAria);
  if (!cellAria.startsWith('Cell F6')) throw new Error(`cell aria-label not translated: "${cellAria}"`);

  // ---- Switch back to Ukrainian ----
  await page.click('#btn-settings');
  await page.click('#btn-lang-uk');
  await page.click('.battle-turn');
  await page.waitForTimeout(150);
  const enemyTitleUk = (await page.textContent('#enemy-board-title')).trim();
  console.log('Enemy fleet title after switching back to UK:', enemyTitleUk);
  if (!enemyTitleUk.includes('бота'))
    throw new Error(`switching back to Ukrainian did not retranslate: "${enemyTitleUk}"`);

  console.log('\nALL I18N E2E CHECKS PASSED ✅');
  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error('I18N E2E TEST ERROR:', err);
  process.exit(1);
});
