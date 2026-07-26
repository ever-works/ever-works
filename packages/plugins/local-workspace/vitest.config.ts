import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// Same reason as the sandbox-workspace plugin: this is a real-git
		// harness (pool clone, worktree add/remove, commit, push, merge-tree)
		// and every test spawns several `git` processes. Solo it is well
		// inside the limit, but under the concurrent turbo test load the
		// subprocesses are starved and 10 of 11 tests fail with "Test timed
		// out in 5000ms". Matches the 30000ms every other plugin package
		// already configures.
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
