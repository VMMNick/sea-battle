'use strict';
// E2E перевірка чату та emoji-реакцій у бою через реальний браузер: віджет
// видимий у грі проти людини, повідомлення й реакція, надіслані з однієї
// вкладки, зʼявляються в чат-логі обох (включно з відправником), і клік на
// реакцію показує анімовану емодзі-"бульбашку".
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
  page1.on('pageerror', (e) => console.log('P1 pageerror:', e.message));
  page2.on('pageerror', (e) => console.log('P2 pageerror:', e.message));

  await page1.goto(URL);
  await page2.goto(URL);

  await page1.click('#btn-create');
  await page1.waitForSelector('#screen-waiting:not(.hidden)', { timeout: 5000 });
  const code = (await page1.textContent('#room-code')).trim();

  await page2.fill('#input-code', code);
  await page2.click('#btn-join');

  await page1.waitForSelector('#screen-placement:not(.hidden)', { timeout: 5000 });
  await page2.waitForSelector('#screen-placement:not(.hidden)', { timeout: 5000 });

  await page1.click('#btn-random');
  await page2.click('#btn-random');
  await page1.click('#btn-ready');
  await page2.click('#btn-ready');

  await page1.waitForSelector('#screen-battle:not(.hidden)', { timeout: 5000 });
  await page2.waitForSelector('#screen-battle:not(.hidden)', { timeout: 5000 });
  console.log('Both players reached battle screen');

  const chatWrapClass1 = await page1.getAttribute('#chat-wrap', 'class');
  if (chatWrapClass1.includes('hidden')) throw new Error('chat widget should be visible in a human-vs-human game');
  console.log('OK: chat widget visible for a human-vs-human game');

  // ---- Text chat: sent from page1, must show up in both logs ----
  await page1.fill('#chat-input', 'Привіт з UI!');
  await page1.click('#chat-form button[type="submit"]');
  await page1.waitForSelector('#chat-log .chat-entry', { timeout: 3000 });
  await page2.waitForSelector('#chat-log .chat-entry', { timeout: 3000 });

  const log1 = (await page1.textContent('#chat-log')).trim();
  const log2 = (await page2.textContent('#chat-log')).trim();
  console.log('P1 chat log:', log1);
  console.log('P2 chat log:', log2);
  if (!log1.includes('Привіт з UI!')) throw new Error('sender does not see its own chat message');
  if (!log2.includes('Привіт з UI!')) throw new Error('recipient does not see the chat message');

  const inputValueAfterSend = await page1.inputValue('#chat-input');
  if (inputValueAfterSend !== '') throw new Error('chat input should clear after sending');
  console.log('OK: chat message delivered to both sides and input cleared');

  // ---- Emoji reaction: clicked from page2, must show a burst + log entry on both ----
  await page2.click('.btn-reaction[data-emoji="🔥"]');
  await page1.waitForSelector('.reaction-burst', { timeout: 3000 });
  console.log('OK: reaction burst animation appeared on the recipient side');

  await page1.waitForFunction(() => document.getElementById('chat-log').textContent.includes('🔥'), {
    timeout: 3000,
  });
  await page2.waitForFunction(() => document.getElementById('chat-log').textContent.includes('🔥'), {
    timeout: 3000,
  });
  console.log('OK: reaction logged in chat on both sides');

  console.log('\nALL CHAT E2E CHECKS PASSED ✅');
  await browser.close();
  process.exit(0);
})().catch((err) => {
  console.error('CHAT E2E TEST ERROR:', err);
  process.exit(1);
});
