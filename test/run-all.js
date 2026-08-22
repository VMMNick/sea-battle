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

const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');

const PORT = process.env.TEST_PORT || 8199;
const HTTP_URL = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}`;
const TEST_DIR = __dirname;
const TEMP_REDIS_PORT = 6390;

// Ordered roughly fast/no-dependencies first, so a broken environment
// (e.g. Playwright not installed) fails fast instead of after minutes of
// full bot games. persistence.js manages its own short-lived server
// processes on its own port, so it doesn't need the shared server/url above.
const TESTS = [
  { file: 'bot-ai-sim.js', url: null }, // pure simulation, no server needed
  { file: 'simulate.js', url: WS_URL },
  { file: 'cancel.js', url: WS_URL },
  { file: 'quick-match.js', url: WS_URL },
  { file: 'leaderboard.js', url: WS_URL },
  { file: 'chat.js', url: WS_URL },
  { file: 'resume.js', url: WS_URL },
  { file: 'join-lockout.js', url: null }, // spawns its own short-lockout server instance
  { file: 'e2e.js', url: HTTP_URL },
  { file: 'e2e_cancel.js', url: HTTP_URL },
  { file: 'e2e_resume.js', url: HTTP_URL },
  { file: 'e2e_settings.js', url: HTTP_URL },
  { file: 'e2e_chat.js', url: HTTP_URL },
  { file: 'e2e_i18n.js', url: HTTP_URL },
  { file: 'e2e_onboarding.js', url: HTTP_URL },
  { file: 'bot-difficulty.js', url: null }, // spawns its own server instance
  { file: 'responsive.js', url: HTTP_URL },
  { file: 'bot.js', url: WS_URL }, // full games — slowest, run near the end
  { file: 'e2e_bot.js', url: HTTP_URL },
  { file: 'persistence.js', url: null, redis: true }, // self-skips if no Redis is available
];

// persistence.js needs a REDIS_URL to actually exercise anything. If one is
// already set (e.g. a CI service container) we just forward it. Otherwise,
// if a local `redis-server` binary happens to be available, spin up a
// throwaway instance for the duration of that one test. If neither is
// available the test isn't blocked — it prints SKIP and passes trivially,
// since Redis persistence is an optional feature, not a hard dependency.
function findRedisServerBinary() {
  try {
    execSync('which redis-server', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function waitForTcp(port, timeoutMs) {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    (function attempt() {
      const sock = net.connect(port, '127.0.0.1');
      sock.on('connect', () => {
        sock.end();
        resolve();
      });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() > deadline) return reject(new Error('redis-server did not start in time'));
        setTimeout(attempt, 150);
      });
    })();
  });
}

async function setupRedisForTests() {
  if (process.env.REDIS_URL) return { url: process.env.REDIS_URL, proc: null };
  if (!findRedisServerBinary()) return { url: '', proc: null };
  const proc = spawn('redis-server', ['--port', String(TEMP_REDIS_PORT), '--save', '', '--daemonize', 'no'], {
    stdio: 'ignore',
  });
  try {
    await waitForTcp(TEMP_REDIS_PORT, 5000);
    return { url: `redis://127.0.0.1:${TEMP_REDIS_PORT}`, proc };
  } catch {
    proc.kill();
    return { url: '', proc: null };
  }
}

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

function runTest(file, url, extraEnv) {
  return new Promise((resolve) => {
    const started = Date.now();
    const env = { ...process.env, ...(extraEnv || {}) };
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

  const redisSetup = await setupRedisForTests();
  if (redisSetup.url) {
    console.log(`Redis available for persistence test (${redisSetup.proc ? 'temporary local instance' : 'REDIS_URL'})`);
  } else {
    console.log('No Redis available — persistence.js will skip itself.');
  }

  const results = [];
  for (const t of TESTS) {
    console.log(`\n=== ${t.file} ${'='.repeat(Math.max(0, 40 - t.file.length))}`);
    const extraEnv = t.redis ? { REDIS_URL: redisSetup.url } : undefined;
    const result = await runTest(t.file, t.url, extraEnv);
    results.push(result);
    if (!result.ok) console.error(`✗ ${t.file} FAILED`);
  }

  if (redisSetup.proc) redisSetup.proc.kill();
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
