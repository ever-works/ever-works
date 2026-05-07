import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		globals: true,
		include: ['src/**/*.{test,spec}.ts'],
		fileParallelism: false,
		maxWorkers: 1,
		minWorkers: 1
	}
});
