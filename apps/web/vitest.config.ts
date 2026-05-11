import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * Vitest configuration for the apps/web unit-test suite.
 *
 * Scope: pure-function helpers, custom hooks, and React component logic
 * that doesn't need a real Next.js runtime. Anything that depends on the
 * Next router or server actions belongs in the Playwright e2e suite at
 * `e2e/` instead.
 *
 * The Playwright runner ignores `.unit.spec.ts(x)` files (see
 * `playwright.config.ts > testIgnore`) so the two suites are fully
 * separated by file extension.
 */
export default defineConfig({
    plugins: [react(), tsconfigPaths()],
    test: {
        environment: 'jsdom',
        globals: true,
        include: ['src/**/*.unit.spec.{ts,tsx}'],
        setupFiles: ['./vitest.setup.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'html'],
            include: ['src/**/*.{ts,tsx}'],
            exclude: ['src/**/*.unit.spec.{ts,tsx}'],
        },
    },
});
