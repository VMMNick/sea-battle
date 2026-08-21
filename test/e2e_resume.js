'use strict';
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://localhost:8123';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  // Persistent-ish contexts so localStorage survives a page reload (newContext already does this
  // within the same context — reload() keeps localStorage, only closing the context wipes it).
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();
  page1.on('dialog', (d) => d.dismiss().catch(() => {}));
  page2.on('dialog', (d) => d.dismiss().catch(() => {}));
  page1.on('pageerror', (e) => console.log('P1 pageerror:', e.message));
  page2.on('pageerror', (e) => console.log('P2 pageerror:', e.message));

  await page1.goto(URL);
  await page2.goto(URL);

  await page1.click('#btn-create');
  await page1.waitForSelector('#screen-waiting:not(.hidden)');
  const code = (await page1.textContent('#room-code')).trim();

  await page2.fill('#input-code', code);
  await page2.click('#btn-join');
  await page1.waitForSelector('#screen-placement:not(.hidden)');
  await page2.waitForSelector('#screen-placement:not(.hidden)');

  await page1.click('#btn-random');
  await page2.click('#btn-random');
  await page1.click('#btn-ready');
  await page2.click('#btn-ready');
  await page1.waitForSelector('#screen-battle:not(.hidden)');
  await page2.waitForSelector('#screen-battle:not(.hidden)');
  console.log('Battle started.');

  // whoever's turn it is, fire one confirmed shot so there is state to preserve
  const turnText1 = await page1.textContent('#battle-turn');
  const shooterPage = turnText1.includes('Ваш хід') ? page1 : page2;
  await shooterPage.click('#grid-enemy .cell[data-r="3"][data-c="3"]');
  await shooterPage.waitForTimeout(400);
  const shotClassBefore = await shooterPage.getAttribute('#grid-enemy .cell[data-r="3"][data-c="3"]', 'class');
  console.log('Shot fired, resulting class:', shotClassBefore);

  // --- Test A: reload the page (simulates an accidental refresh / closed tab reopened) ---
  await page1.reload();
  await page1.waitForSelector('#screen-battle:not(.hidden)', { timeout: 8000 });
  const shotClassAfterReload = await page1.getAttribute('#grid-enemy .cell[data-r="3"][data-c="3"]', 'class');
  console.log('After page1 reload, battle screen restored. Shot cell class:', shotClassAfterReload);
  if (
    !shotClassAfterReload.includes('hit') &&
    !shotClassAfterReload.includes('miss') &&
    !shotClassAfterReload.includes('sunk')
  ) {
    throw new Error('Shot history was not restored after reload');
  }

  // own fleet must be repainted too (20 ship cells)
  const shipCells = await page1.$$eval('#grid-self .cell.ship', (els) => els.length);
  console.log('Own fleet cells restored on grid-self:', shipCells, '(expect 20)');
  if (shipCells !== 20) throw new Error('Own fleet was not restored after reload');

  // --- Test B: close and reopen the tab entirely (new page, same context => same localStorage) ---
  await page1.close();
  const page1b = await ctx1.newPage();
  page1b.on('dialog', (d) => d.dismiss().catch(() => {}));
  await page1b.goto(URL);
  await page1b.waitForSelector('#screen-battle:not(.hidden)', { timeout: 8000 });
  console.log('OK: reopening the tab (new page, same browser storage) also restored the battle screen.');

  console.log('\nALL E2E RESUME CHECKS PASSED ✅');
  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error('E2E RESUME TEST ERROR:', err);
  process.exit(1);
});
