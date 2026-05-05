import { defineConfig } from 'vitest/config';

/**
 * Separate Vitest config for the kind-cluster e2e suite. Runs only when
 * `KUBECONFIG_E2E_PATH` points at a real cluster (the suite skips when
 * unset) and is invoked from CI via `pnpm test:e2e` after a kind cluster
 * has been provisioned. Default `pnpm test` excludes this directory so
 * unit runs stay hermetic.
 */
export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		// Generous default — individual tests inside still set their own
		// timeouts where needed (e.g. the rollout-poll test uses 120s).
		testTimeout: 60_000,
		hookTimeout: 60_000,
		include: ['src/__tests__/e2e/**/*.{test,spec}.ts'],
		// Run e2e suites serially — each one mutates a shared cluster.
		fileParallelism: false,
		pool: 'forks'
	}
});
