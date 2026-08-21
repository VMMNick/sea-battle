'use strict';
const { chromium } = require('playwright');
const URL = process.env.URL || 'http://localhost:9001';

const VIEWPORTS = [
  { name: 'iPhone SE (320x568)', width: 320, height: 568 },
  { name: 'iPhone 12/13 (390x844)', width: 390, height: 844 },
  { name: 'Android small (360x740)', width: 360, height: 740 },
  { name: 'iPad portrait (768x1024)', width: 768, height: 1024 },
  { name: 'iPad landscape (1024x768)', width: 1024, height: 768 },
  { name: 'Small landscape phone (667x375)', width: 667, height: 375 },
  { name: 'Desktop (1440x900)', width: 1440, height: 900 },
];

async function checkNoOverflow(page, label) {
  const result = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  const overflow = result.scrollWidth - result.clientWidth;
  const status = overflow > 1 ? `OVERFLOW by ${overflow}px` : 'OK';
  console.log(`  [${label}] scrollWidth=${result.scrollWidth} clientWidth=${result.clientWidth} -> ${status}`);
  return overflow <= 1;
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  let anyFailure = false;

  for (const vp of VIEWPORTS) {
    console.log(`\n=== ${vp.name} ===`);
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('  pageerror:', e.message));
    page.on('dialog', (d) => d.dismiss().catch(() => {}));

    await page.goto(URL);
    let ok = await checkNoOverflow(page, 'menu');
    anyFailure = anyFailure || !ok;

    await page.click('#btn-create');
    await page.waitForSelector('#screen-waiting:not(.hidden)', { timeout: 5000 });
    ok = await checkNoOverflow(page, 'waiting');
    anyFailure = anyFailure || !ok;

    // second player joins to trigger placement screen
    const code = (await page.textContent('#room-code')).trim();
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    page2.on('dialog', (d) => d.dismiss().catch(() => {}));
    await page2.goto(URL);
    await page2.fill('#input-code', code);
    await page2.click('#btn-join');

    await page.waitForSelector('#screen-placement:not(.hidden)', { timeout: 5000 });
    ok = await checkNoOverflow(page, 'placement');
    anyFailure = anyFailure || !ok;

    await page.click('#btn-random');
    await page2.click('#btn-random');
    await page.click('#btn-ready');
    await page2.click('#btn-ready');

    await page.waitForSelector('#screen-battle:not(.hidden)', { timeout: 5000 });
    ok = await checkNoOverflow(page, 'battle');
    anyFailure = anyFailure || !ok;

    // sanity: enemy grid must be tappable within viewport bounds
    const box = await page.$eval('#grid-enemy', (el) => {
      const r = el.getBoundingClientRect();
      return { right: r.right, bottom: r.bottom };
    });
    const withinBounds = box.right <= vp.width + 1;
    console.log(
      `  [battle] enemy grid right edge = ${box.right.toFixed(1)} (viewport width ${vp.width}) -> ${withinBounds ? 'OK' : 'OUT OF BOUNDS'}`,
    );
    anyFailure = anyFailure || !withinBounds;

    await ctx.close();
    await ctx2.close();
  }

  await browser.close();
  if (anyFailure) {
    console.error('\nRESPONSIVE TEST FAILED — see OVERFLOW/OUT OF BOUNDS lines above');
    process.exit(1);
  }
  console.log('\nALL RESPONSIVE CHECKS PASSED ✅ (no horizontal overflow on any viewport/screen)');
  process.exit(0);
})().catch((err) => {
  console.error('TEST ERROR:', err);
  process.exit(1);
});
