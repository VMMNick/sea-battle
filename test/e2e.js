'use strict';
const { chromium } = require('playwright');

const URL = process.env.URL || 'http://localhost:8123';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  // This test isn't exercising the onboarding tutorial — pre-seed the "seen"
  // flag so the modal doesn't pop up and intercept clicks on the menu
  // buttons (see test/e2e_onboarding.js for the dedicated onboarding test).
  await ctx1.addInitScript(() => localStorage.setItem('seabattle_onboarding_seen', '1'));
  await ctx2.addInitScript(() => localStorage.setItem('seabattle_onboarding_seen', '1'));
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();

  page1.on('console', (m) => {
    if (m.type() === 'error') console.log('P1 console error:', m.text());
  });
  page2.on('console', (m) => {
    if (m.type() === 'error') console.log('P2 console error:', m.text());
  });
  page1.on('pageerror', (e) => console.log('P1 pageerror:', e.message));
  page2.on('pageerror', (e) => console.log('P2 pageerror:', e.message));

  await page1.goto(URL);
  await page2.goto(URL);

  await page1.click('#btn-create');
  await page1.waitForSelector('#screen-waiting:not(.hidden)', { timeout: 5000 });
  const code = (await page1.textContent('#room-code')).trim();
  console.log('Room code shown in UI:', code);
  if (!/^[A-Z0-9]{4}$/.test(code)) throw new Error('Room code format unexpected: ' + code);

  await page2.fill('#input-code', code);
  await page2.click('#btn-join');

  await page1.waitForSelector('#screen-placement:not(.hidden)', { timeout: 5000 });
  await page2.waitForSelector('#screen-placement:not(.hidden)', { timeout: 5000 });
  console.log('Both players reached placement screen');

  // Use the random placement button on both
  await page1.click('#btn-random');
  await page2.click('#btn-random');

  const readyEnabled1 = await page1.isEnabled('#btn-ready');
  const readyEnabled2 = await page2.isEnabled('#btn-ready');
  if (!readyEnabled1 || !readyEnabled2) throw new Error('Ready button not enabled after random placement');
  console.log('Ready button enabled after random fleet placement on both sides');

  const shipCellCount1 = await page1.$$eval('#grid-own .cell.ship', (els) => els.length);
  const shipCellCount2 = await page2.$$eval('#grid-own .cell.ship', (els) => els.length);
  console.log('Ship cells painted:', shipCellCount1, shipCellCount2, '(expected 20 each)');
  if (shipCellCount1 !== 20 || shipCellCount2 !== 20) throw new Error('Unexpected ship cell count');

  await page1.click('#btn-ready');
  await page2.click('#btn-ready');

  await page1.waitForSelector('#screen-battle:not(.hidden)', { timeout: 5000 });
  await page2.waitForSelector('#screen-battle:not(.hidden)', { timeout: 5000 });
  console.log('Both players reached battle screen');

  const turnText1 = await page1.textContent('#battle-turn');
  const turnText2 = await page2.textContent('#battle-turn');
  console.log('Turn indicator P1:', turnText1.trim());
  console.log('Turn indicator P2:', turnText2.trim());
  const oneIsMyTurn = turnText1.includes('Ваш хід') || turnText2.includes('Ваш хід');
  if (!oneIsMyTurn) throw new Error('Neither player shows "Ваш хід" - turn logic broken in UI');

  // Determine whose turn it is and fire a shot on the enemy grid
  const activePage = turnText1.includes('Ваш хід') ? page1 : page2;
  const otherPage = activePage === page1 ? page2 : page1;

  await activePage.click('#grid-enemy .cell[data-r="5"][data-c="5"]');
  await activePage.waitForTimeout(500);

  const cellClass = await activePage.getAttribute('#grid-enemy .cell[data-r="5"][data-c="5"]', 'class');
  console.log('Fired cell class after shot:', cellClass);
  if (!cellClass.includes('hit') && !cellClass.includes('miss') && !cellClass.includes('sunk')) {
    throw new Error('Fired cell did not update with hit/miss/sunk class');
  }

  // check turn indicator flipped on the other page too (UI synced via websocket)
  await otherPage.waitForTimeout(300);
  const otherTurnText = await otherPage.textContent('#battle-turn');
  console.log('Other player turn text after shot:', otherTurnText.trim());

  console.log('ALL UI CHECKS PASSED ✅');
  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error('E2E TEST ERROR:', err);
  process.exit(1);
});
