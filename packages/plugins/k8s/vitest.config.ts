import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		testTimeout: 10000,
		include: ['src/**/*.{test,spec}.ts'],
		// E2E suite under `__tests__/e2e/` is gated by the
		// `KUBECONFIG_E2E_PATH` env var (see cluster.e2e.spec.ts) and run
		// via `pnpm test:e2e`. The default `pnpm test` skips that
		// directory so unit tests stay hermetic.
		exclude: ['src/__tests__/e2e/**', 'node_modules/**', 'dist/**'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html'],
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.{test,spec}.ts', 'src/**/index.ts']
		}
	}
});
