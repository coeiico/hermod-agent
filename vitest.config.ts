import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  // Gives tests WXT's auto-imports, path aliases and an in-memory fake `browser`.
  plugins: [WxtVitest()],
  test: {
    include: ['ai/**/*.test.ts', 'lib/**/*.test.ts'],
  },
});
