import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// CI-load resilience: unit specs doing cold `await import()` /
		// vi.resetModules() or real file parsing can drift past vitest's 5s
		// default under the concurrent turbo test load. Matches the 30000ms
		// the packages/tasks + api jest configs already use.
		testTimeout: 30000,
		hookTimeout: 30000,
		globals: true,
		environment: 'node',
		include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html'],
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.spec.ts', 'src/**/*.test.ts', 'src/index.ts']
		}
	}
});
