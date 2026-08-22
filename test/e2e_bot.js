'use strict';
// E2E перевірка гри проти бота через реальний браузер:
// кнопка "Грати проти бота" одразу веде до розстановки (без екрана очікування),
// заголовок ворожого флоту показує "Флот бота 🤖", і повну партію можна зіграти
// до кінця (перемога чи поразка) прямо в UI.
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
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  page.on('pageerror', (e) => console.log('pageerror:', e.message));

  await page.goto(URL);
  await page.waitForSelector('#screen-menu:not(.hidden)');

  await page.click('#btn-create-bot');
  // must skip the waiting screen entirely and land straight on placement
  await page.waitForSelector('#screen-placement:not(.hidden)', { timeout: 8000 });
  const waitingHidden = await page.getAttribute('#screen-waiting', 'class');
  console.log(
    'OK: bot game skipped the waiting screen, went straight to placement. (#screen-waiting class:',
    waitingHidden,
    ')',
  );
  if (!waitingHidden.includes('hidden')) throw new Error('waiting screen should stay hidden for a bot game');

  await page.click('#btn-random');
  await page.click('#btn-ready');
  await page.waitForSelector('#screen-battle:not(.hidden)', { timeout: 8000 });
  console.log('Battle started against the bot.');

  const enemyTitle = (await page.textContent('#enemy-board-title')).trim();
  console.log('Enemy board title:', enemyTitle);
  if (!enemyTitle.includes('бота'))
    throw new Error(`expected enemy board title to mention the bot, got "${enemyTitle}"`);

  const chatWrapClass = await page.getAttribute('#chat-wrap', 'class');
  console.log('Chat widget class in a bot game:', chatWrapClass);
  if (!chatWrapClass.includes('hidden')) throw new Error('chat widget should be hidden for a bot game');

  // Sweep the whole enemy board in order whenever it's our turn, letting the
  // bot fire automatically on its own turns, until the game concludes.
  let rounds = 0;
  let finished = false;
  outer: for (let r = 0; r < 10 && !finished; r++) {
    for (let c = 0; c < 10 && !finished; c++) {
      rounds++;
      if (rounds > 400) throw new Error('game did not conclude within round budget');

      // wait until it is our turn or the game is over
      await page.waitForFunction(
        () => {
          const overVisible = !document.getElementById('screen-over').classList.contains('hidden');
          const turnEl = document.getElementById('battle-turn');
          return overVisible || (turnEl && turnEl.classList.contains('my-turn'));
        },
        { timeout: 15000 },
      );

      const overClass = await page.getAttribute('#screen-over', 'class');
      if (!overClass.includes('hidden')) {
        finished = true;
        break outer;
      }

      const cell = page.locator(`#grid-enemy .cell[data-r="${r}"][data-c="${c}"]`);
      const cls = (await cell.getAttribute('class')) || '';
      if (cls.includes('miss') || cls.includes('hit') || cls.includes('sunk')) continue; // already fired here
      await cell.click();
      await page.waitForTimeout(60);
    }
  }

  await page.waitForSelector('#screen-over:not(.hidden)', { timeout: 15000 });
  const overTitle = (await page.textContent('#over-title')).trim();
  console.log('Game over. Title:', overTitle);
  if (!overTitle) throw new Error('expected an over-title message');

  console.log('\nALL BOT E2E CHECKS PASSED ✅');
  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error('BOT E2E TEST ERROR:', err);
  process.exit(1);
});
