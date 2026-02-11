import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
	resolve: {
		alias: {
			'@langchain/openai': path.resolve(__dirname, 'node_modules/@langchain/openai'),
			'@langchain/core': path.resolve(__dirname, 'node_modules/@langchain/core')
		}
	},
	test: {
		environment: 'node',
		globals: true,
		include: ['src/**/*.{test,spec}.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html']
		}
	}
});
