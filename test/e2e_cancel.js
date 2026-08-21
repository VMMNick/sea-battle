'use strict';
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://localhost:8123';

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then((c) => c.newPage());
  page.on('pageerror', (e) => console.log('pageerror:', e.message));

  await page.goto(URL);
  await page.click('#btn-create');
  await page.waitForSelector('#screen-waiting:not(.hidden)', { timeout: 5000 });
  const code = (await page.textContent('#room-code')).trim();
  console.log('Room created:', code);

  const cancelVisible = await page.isVisible('#btn-cancel-waiting');
  if (!cancelVisible) throw new Error('Cancel button not visible on waiting screen');

  await page.click('#btn-cancel-waiting');
  await page.waitForSelector('#screen-menu:not(.hidden)', { timeout: 3000 });
  console.log('OK: back on menu screen after cancel');

  // trying to join the cancelled code from a second page should show an error
  const page2 = await browser.newContext().then((c) => c.newPage());
  await page2.goto(URL);
  await page2.fill('#input-code', code);
  await page2.click('#btn-join');
  await page2.waitForFunction(() => document.getElementById('menu-error').textContent.trim().length > 0, {
    timeout: 5000,
  });
  const errText = (await page2.textContent('#menu-error')).trim();
  console.log('OK: join with cancelled code shows error ->', errText);

  // and the original page can create a brand new game right after
  await page.click('#btn-create');
  await page.waitForSelector('#screen-waiting:not(.hidden)', { timeout: 5000 });
  const code2 = (await page.textContent('#room-code')).trim();
  console.log('OK: created a new room after cancelling ->', code2);
  if (code2 === code) throw new Error('expected different room code');

  console.log('ALL UI CANCEL CHECKS PASSED ✅');
  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error('E2E CANCEL TEST ERROR:', err);
  process.exit(1);
});
