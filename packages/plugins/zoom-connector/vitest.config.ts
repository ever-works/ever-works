import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// CI-load resilience: unit specs doing cold `await import()` /
		// vi.resetModules() or real file parsing can drift past vitest's 5s
		// default under the concurrent turbo test load. Matches the 30000ms
		// the packages/tasks + api jest configs already use.
		testTimeout: 30000,
		hookTimeout: 30000,
		environment: 'node',
		globals: true,
		include: ['src/**/*.{test,spec}.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html']
		}
	}
});
