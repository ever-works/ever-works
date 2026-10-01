import { defineConfig } from 'vitest/config';

/**
 * Separate Vitest config for the kind-cluster suite (tasks T11).
 *
 * `test/integration/*.int.spec.ts` starts a kind cluster, installs the CRDs and RBAC this package
 * generates, applies a fixture `Work` and asserts what the zone did. It is invoked from CI via
 * `pnpm test:integration` after the job has provisioned kind, so the default `pnpm test` excludes
 * this directory and unit runs stay hermetic.
 */
export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		testTimeout: 60_000,
		hookTimeout: 60_000,
		include: ['test/integration/**/*.{test,spec}.ts'],
		exclude: ['node_modules/**', 'dist/**'],
		// One cluster, one CRD install: the suites must not race each other.
		fileParallelism: false,
		pool: 'forks'
	}
});
