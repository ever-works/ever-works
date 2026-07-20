import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		// fs-watcher taxonomy tests are timing-based; under CI load a fixed sleep
		// can miss the watcher's debounce. Retry transient flakes and give slow
		// hooks headroom instead of reddening the whole shard.
		retry: 2,
		testTimeout: 15000,
		include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html'],
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.spec.ts', 'src/**/*.test.ts', 'src/index.ts']
		}
	}
});
