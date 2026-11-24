// Only `eslint` itself is needed: the rules are listed explicitly.
export default [
  { ignores: ['node_modules/', 'samples/obfuscated.js', 'samples/packed.js', 'samples/wsh-ps1.js'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { process: 'readonly', Buffer: 'readonly', console: 'readonly', URL: 'readonly', TextDecoder: 'readonly' },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-redeclare': 'error',
      'no-self-assign': 'error',
      'no-const-assign': 'error',
      'no-dupe-else-if': 'error',
      'no-fallthrough': 'error',
      'no-unsafe-finally': 'error',
      'no-unused-labels': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
];
