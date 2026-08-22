'use strict';
// E2E перевірка вступного туру (онбордингу) через реальний браузер: вікно
// саме з'являється при першому візиті (немає збереженої сесії), закриття
// будь-яким способом (кнопка, клік по фону, Escape) запам'ятовується в
// localStorage і тур більше не зʼявляється сам, а кнопка ❓ у шапці завжди
// відкриває його знову — і текст перекладається разом з рештою інтерфейсу.
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://localhost:8123';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));

  const overlayHidden = () =>
    page.evaluate(() => document.getElementById('onboarding-overlay').classList.contains('hidden'));

  // ---- Shows automatically on first visit (no saved session yet) ----
  await page.goto(URL);
  await page.waitForSelector('#onboarding-overlay:not(.hidden)', { timeout: 3000 });
  const title = (await page.textContent('#onboarding-title')).trim();
  console.log('Onboarding title on first visit:', title);
  if (!title.includes('Як грати')) throw new Error(`unexpected onboarding title: "${title}"`);

  // ---- Closing (button) marks it seen ----
  await page.click('#btn-onboarding-close');
  await page.waitForFunction(() => document.getElementById('onboarding-overlay').classList.contains('hidden'), {
    timeout: 2000,
  });
  const seenFlag = await page.evaluate(() => localStorage.getItem('seabattle_onboarding_seen'));
  console.log('seen flag after close:', seenFlag);
  if (seenFlag !== '1') throw new Error('closing onboarding did not persist the "seen" flag');

  // ---- Does not reappear on reload ----
  await page.reload();
  await page.waitForSelector('#screen-menu:not(.hidden)');
  if (!(await overlayHidden())) throw new Error('onboarding reappeared on reload after being dismissed');

  // ---- Reopenable any time via the ❓ header button ----
  await page.click('#btn-help');
  await page.waitForSelector('#onboarding-overlay:not(.hidden)', { timeout: 2000 });
  console.log('OK: ❓ button reopens the onboarding tour');

  // ---- Escape closes it ----
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('onboarding-overlay').classList.contains('hidden'), {
    timeout: 2000,
  });
  console.log('OK: Escape dismisses the onboarding tour');

  // ---- Clicking the backdrop closes it ----
  await page.click('#btn-help');
  await page.waitForSelector('#onboarding-overlay:not(.hidden)', { timeout: 2000 });
  await page.click('#onboarding-overlay', { position: { x: 5, y: 5 } });
  await page.waitForFunction(() => document.getElementById('onboarding-overlay').classList.contains('hidden'), {
    timeout: 2000,
  });
  console.log('OK: clicking the backdrop dismisses the onboarding tour');

  // ---- Translates along with the rest of the UI (EN) ----
  await page.click('#btn-settings');
  await page.click('#btn-lang-en');
  await page.click('h1'); // click outside to close the settings panel
  await page.click('#btn-help');
  await page.waitForSelector('#onboarding-overlay:not(.hidden)', { timeout: 2000 });
  const titleEn = (await page.textContent('#onboarding-title')).trim();
  const closeBtnEn = (await page.textContent('#btn-onboarding-close')).trim();
  console.log('Onboarding title (EN):', titleEn, '| close button:', closeBtnEn);
  if (!titleEn.includes('How to play')) throw new Error(`onboarding title not translated: "${titleEn}"`);
  if (!closeBtnEn.includes('Got it')) throw new Error(`close button not translated: "${closeBtnEn}"`);
  await page.click('#btn-onboarding-close');

  console.log('\nALL ONBOARDING E2E CHECKS PASSED ✅');
  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error('ONBOARDING E2E TEST ERROR:', err);
  process.exit(1);
});
