'use strict';
// Runs the whole test suite with one command: starts the server once on a
// dedicated port (so it doesn't collide with a dev server you might already
// have running on 8080/8123), runs every other test/*.js file against it in
// order (fast, no-server checks first), prints a pass/fail summary table,
// and exits non-zero if anything failed.
//
// Usage:  npm test
// Playwright-based tests (the e2e*.js and responsive.js files) need the
// `playwright` package and a Chromium build installed once:
//   npx playwright install chromium

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const PORT = process.env.TEST_PORT || 8199;
const HTTP_URL = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}`;
const TEST_DIR = __dirname;

// Ordered roughly fast/no-dependencies first, so a broken environment
// (e.g. Playwright not installed) fails fast instead of after minutes of
// full bot games.
const TESTS = [
  { file: 'bot-ai-sim.js', url: null }, // pure simulation, no server needed
  { file: 'simulate.js', url: WS_URL },
  { file: 'cancel.js', url: WS_URL },
  { file: 'resume.js', url: WS_URL },
  { file: 'e2e.js', url: HTTP_URL },
  { file: 'e2e_cancel.js', url: HTTP_URL },
  { file: 'e2e_resume.js', url: HTTP_URL },
  { file: 'e2e_settings.js', url: HTTP_URL },
  { file: 'responsive.js', url: HTTP_URL },
  { file: 'bot.js', url: WS_URL }, // full games — slowest, run near the end
  { file: 'e2e_bot.js', url: HTTP_URL },
];

function waitForServer(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function attempt() {
      http
        .get(url, (res) => {
          res.resume();
          resolve();
        })
        .on('error', () => {
          if (Date.now() > deadline) return reject(new Error('server did not start in time'));
          setTimeout(attempt, 200);
        });
    })();
  });
}

function runTest(file, url) {
  return new Promise((resolve) => {
    const started = Date.now();
    const env = { ...process.env };
    if (url) env.URL = url;
    const child = spawn(process.execPath, [path.join(TEST_DIR, file)], { env, stdio: 'inherit' });
    child.on('exit', (code) => resolve({ file, ok: code === 0, ms: Date.now() - started }));
    child.on('error', () => resolve({ file, ok: false, ms: Date.now() - started }));
  });
}

(async () => {
  console.log(`Starting server on port ${PORT} for the test run...`);
  const server = spawn(process.execPath, [path.join(TEST_DIR, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  let serverExited = false;
  server.on('exit', () => {
    serverExited = true;
  });

  try {
    await waitForServer(HTTP_URL, 10000);
  } catch (e) {
    console.error('Server failed to start:', e.message);
    if (!serverExited) server.kill();
    process.exit(1);
  }

  const results = [];
  for (const t of TESTS) {
    console.log(`\n=== ${t.file} ${'='.repeat(Math.max(0, 40 - t.file.length))}`);
    const result = await runTest(t.file, t.url);
    results.push(result);
    if (!result.ok) console.error(`✗ ${t.file} FAILED`);
  }

  if (!serverExited) server.kill('SIGTERM');

  console.log('\n===== SUMMARY =====');
  let allOk = true;
  for (const r of results) {
    const status = r.ok ? 'PASS' : 'FAIL';
    if (!r.ok) allOk = false;
    console.log(`${status.padEnd(5)} ${r.file.padEnd(20)} ${(r.ms / 1000).toFixed(1)}s`);
  }
  console.log(allOk ? '\nAll tests passed ✅' : '\nSome tests FAILED ❌');
  process.exit(allOk ? 0 : 1);
})();
