import { defineConfig } from 'vitest/config';

/**
 * Unit configuration — hermetic by rule: no kubeconfig, no cluster, no clock, no network.
 *
 * Every spec under `src/**` must run with no cluster reachable. The suite that needs a real API
 * server is the kind lane (`test/integration/**`, T11) under `vitest.integration.config.ts`.
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
