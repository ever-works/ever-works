import { defineConfig } from 'vitest/config';

/**
 * Unit configuration — T3's CRD suite and every later `src/**` spec (T4…T9, T23, T28, T29).
 *
 * The kind-cluster suite lives outside `src/` (`test/integration/*.int.spec.ts`, T11) and is run by
 * `pnpm test:integration` with `vitest.integration.config.ts`, so `pnpm test` stays hermetic: no
 * kubeconfig, no cluster, no clock, no network.
 */
export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		testTimeout: 10000,
		include: ['src/**/*.{test,spec}.ts'],
		exclude: ['test/**', 'node_modules/**', 'dist/**'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html'],
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.{test,spec}.ts', 'src/**/index.ts']
		}
	}
});
