import { defineConfig } from 'vitest/config';

// The headless node is pure Node logic. Almost every spec injects its own
// fetch, fs, clock and command-runner fakes, so no network and no real timers
// are touched. The one exception is
// `src/core/model-execution/model-process.spec.ts`: its "real process
// boundary" describe spawns real Node child processes and writes real temp
// directories on purpose, because the process boundary is what it proves.
export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.spec.ts'],
		// CI-load resilience: the real-process specs above spawn child
		// processes on a saturated runner and drifted past vitest's 5 s default
		// (CI job 100617108924: "Test timed out in 5000ms" on a test that had
		// no timing assertion of its own). Matches the 30000 ms that
		// apps/web/vitest.config.ts, packages/tasks/vitest.config.ts and the
		// apps/api jest config already use for the same reason. Tests that assert
		// their own wall-clock bounds keep their explicit, smaller per-test budgets.
		testTimeout: 30_000,
		hookTimeout: 30_000
	}
});
