'use strict';
// Перевірка налаштувань звуку/вібрації: кнопка відкриває панель, перемикачі
// зберігаються між перезавантаженнями (localStorage), і клік поза панеллю
// закриває її. Також грає невеликий шматок партії проти бота з увімкненим
// звуком, щоб переконатись, що синтез аудіо/виклики вібрації не кидають
// винятків і не ламають гру (у headless Chromium AudioContext все одно
// залишається suspended без користувацького жесту — тест лише перевіряє,
// що це не призводить до помилок).
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://localhost:8123';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(URL);
  await page.waitForSelector('#screen-menu:not(.hidden)');

  // panel starts hidden, both toggles on by default
  const panelHiddenInitially = (await page.getAttribute('#settings-panel', 'class')).includes('hidden');
  if (!panelHiddenInitially) throw new Error('settings panel should start hidden');

  await page.click('#btn-settings');
  await page.waitForSelector('#settings-panel:not(.hidden)');
  const soundChecked = await page.isChecked('#toggle-sound');
  const vibChecked = await page.isChecked('#toggle-vibration');
  console.log('Defaults — sound:', soundChecked, 'vibration:', vibChecked);
  if (!soundChecked) throw new Error('sound should default to ON');

  // turn sound off, close panel by clicking elsewhere, reload, and confirm it stuck
  await page.uncheck('#toggle-sound');
  await page.click('h1'); // click outside the panel
  await page.waitForFunction(() => document.getElementById('settings-panel').classList.contains('hidden'));
  console.log('OK: clicking outside the panel closes it');

  await page.reload();
  await page.waitForSelector('#screen-menu:not(.hidden)');
  await page.click('#btn-settings');
  const soundAfterReload = await page.isChecked('#toggle-sound');
  console.log('Sound setting after reload:', soundAfterReload);
  if (soundAfterReload) throw new Error('sound=off setting should have persisted across reload');

  // turn sound back on for the rest of the test (exercises the synth code paths)
  await page.check('#toggle-sound');
  await page.click('h1');

  // play a few turns against the bot to exercise fire/hit/miss/sunk sound + vibrate calls
  await page.click('#btn-create-bot');
  await page.waitForSelector('#screen-placement:not(.hidden)');
  await page.click('#btn-random');
  await page.click('#btn-ready');
  await page.waitForSelector('#screen-battle:not(.hidden)');

  for (let i = 0; i < 8; i++) {
    await page.waitForFunction(() => {
      const over = !document.getElementById('screen-over').classList.contains('hidden');
      const t = document.getElementById('battle-turn');
      return over || (t && t.classList.contains('my-turn'));
    }, { timeout: 15000 });
    if (!(await page.getAttribute('#screen-over', 'class')).includes('hidden')) break;
    const r = Math.floor(i / 10), c = i % 10;
    const cell = page.locator(`#grid-enemy .cell[data-r="${r}"][data-c="${c}"]`);
    await cell.click();
    await page.waitForTimeout(150);
  }

  if (pageErrors.length) {
    throw new Error('Page threw errors during play with sound/vibration enabled:\n' + pageErrors.join('\n'));
  }
  console.log('OK: no page errors while sound/vibration hooks fired during play');

  console.log('\nALL SETTINGS CHECKS PASSED ✅');
  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error('SETTINGS TEST ERROR:', err);
  process.exit(1);
});
