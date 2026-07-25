import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
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
