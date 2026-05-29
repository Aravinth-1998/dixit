import { defineConfig } from 'vitest/config';

// game.ts and server.ts use NodeNext-style `.js` suffix imports that point at
// `.ts` source files. Strip the suffix so vitest's bundler can resolve them.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^(\.{1,2}\/.+)\.js$/, replacement: '$1' },
    ],
  },
  test: {
    include: ['server/test/**/*.test.ts'],
    environment: 'node',
  },
});

