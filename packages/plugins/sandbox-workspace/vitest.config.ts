import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// This suite is a real-git loopback harness: every test shells out to
		// `git` many times (clone, branch, commit, push, merge-tree) against a
		// bare file:// origin. Solo that is ~1.7s per test, but under the
		// concurrent turbo test load — 112 packages testing at once — each
		// subprocess is starved and the suite blows past vitest's 5s default,
		// failing 6 of 8 with "Test timed out in 5000ms". Matches the 30000ms
		// every other plugin package already configures.
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
