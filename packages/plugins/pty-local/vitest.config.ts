import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// This suite spawns REAL processes through the PTY plugin and asserts
		// on the frames they stream back, so its wall-clock is the OS process
		// scheduler's, not the assertions'. Alongside 110 other package test
		// tasks under turbo those spawns are starved, and the streaming test
		// blows vitest's 5s default ("Test timed out in 5000ms") — while the
		// same run reports `tests 7.31s` against a 58.9s total, which is the
		// signature of contention rather than a slow test.
		//
		// This package had no config at all, so it never got the 30000ms that
		// `packages/plugin`, `packages/contracts`, `packages/cli-shared` and
		// every configured plugin already use.
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
