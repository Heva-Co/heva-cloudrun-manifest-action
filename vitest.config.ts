import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Both are process entrypoints: they read argv/env and write to the
      // runner. main.ts is covered by self-test.yml and diff.cjs by its
      // `render` job, not by unit tests — excluding them keeps the threshold
      // honest rather than padded with glue we cannot meaningfully unit-test.
      exclude: ['src/main.ts', 'src/diff.ts'],
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
    },
  },
})
