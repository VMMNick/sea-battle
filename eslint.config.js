'use strict';

const js = require('@eslint/js');

// Kept deliberately small: no framework-specific plugins, just enough to
// catch real bugs (undefined variables, unreachable code, accidental
// globals) without fighting the project's existing style. Browser globals
// are listed by hand instead of pulling in the `globals` package, since the
// project only needs a couple dozen of them across public/js/*.
const browserGlobals = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  WebSocket: 'readonly',
  AudioContext: 'readonly',
  webkitAudioContext: 'readonly',
  URLSearchParams: 'readonly',
  MutationObserver: 'readonly',
  history: 'readonly',
  location: 'readonly',
  requestAnimationFrame: 'readonly',
  confirm: 'readonly',
  alert: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
};

const nodeGlobals = {
  require: 'readonly',
  module: 'readonly',
  exports: 'writable',
  process: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
};

module.exports = [
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  {
    files: ['server.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Playwright test scripts run in Node but pass callbacks into the page
    // (page.evaluate/waitForFunction) that reference DOM globals — so both
    // global sets apply here.
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...nodeGlobals, ...browserGlobals },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      // Defensive "stop looping" flags that also get a labeled `break` right
      // after are common in these scripts and read fine even though the
      // assignment's effect is technically never observed.
      'no-useless-assignment': 'off',
    },
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: browserGlobals,
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
];
