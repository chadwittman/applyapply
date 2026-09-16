// Narrow on purpose. node --check parses a file but cannot tell that an
// identifier was never declared, which is how a removed variable left three
// live references behind and took sourcing down in production. This catches
// that class and nothing else, so it stays quiet enough to be worth running.
const globals = {
  require: 'readonly', module: 'writable', exports: 'writable',
  process: 'readonly', console: 'readonly', Buffer: 'readonly',
  __dirname: 'readonly', __filename: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly',
  setInterval: 'readonly', clearInterval: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', fetch: 'readonly',
  TextEncoder: 'readonly', TextDecoder: 'readonly',
  AbortController: 'readonly', AbortSignal: 'readonly',
  Intl: 'readonly', structuredClone: 'readonly',
  crypto: 'readonly', performance: 'readonly', queueMicrotask: 'readonly',
};

// source.js hands callbacks to page.evaluate, which runs them inside the
// browser, so DOM globals are legitimate there and nowhere else.
const browserGlobals = {
  document: 'readonly', window: 'readonly', navigator: 'readonly',
  location: 'readonly', fetch: 'readonly', getComputedStyle: 'readonly',
  HTMLElement: 'readonly', Node: 'readonly',
};

module.exports = [
  {
    files: ['extension/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals, ...browserGlobals, chrome: 'readonly', MutationObserver: 'readonly',
        CSS: 'readonly', requestAnimationFrame: 'readonly', Event: 'readonly', MouseEvent: 'readonly',
        KeyboardEvent: 'readonly', CustomEvent: 'readonly', HTMLInputElement: 'readonly',
        HTMLTextAreaElement: 'readonly', HTMLSelectElement: 'readonly', FileReader: 'readonly',
        File: 'readonly', Blob: 'readonly', DataTransfer: 'readonly', atob: 'readonly',
        btoa: 'readonly', localStorage: 'readonly', MediaRecorder: 'readonly',
        XMLHttpRequest: 'readonly', alert: 'readonly' },
    },
    rules: { 'no-undef': 'error', 'no-dupe-keys': 'error', 'no-unreachable': 'error', 'no-const-assign': 'error' },
  },
  {
    files: ['server/**/*.js'],
    ignores: ['**/node_modules/**'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals,
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-self-assign': 'error',
    },
  },
  {
    files: ['source.js'],
    ignores: ['**/node_modules/**'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals, ...browserGlobals },
    },
    rules: {
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-self-assign': 'error',
    },
  },
];
