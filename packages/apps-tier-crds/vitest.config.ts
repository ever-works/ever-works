import { defineConfig } from 'vitest/config';

/**
 * Unit configuration — the CRD schema suite (T3) and any later `src/**` spec of this package.
 *
 * Everything here is hermetic by construction: this package is pure schema, so a spec has no
 * kubeconfig, no cluster, no clock and no network to reach for. The kind-cluster suite (T11) that
 * installs these CRDs and asserts what the zone did with a fixture `Work` belongs to the process
 * that does the reconciling — it lives in `apps/apps-tier-controller` with its own
 * `vitest.integration.config.ts`.
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
