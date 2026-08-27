import { defineConfig } from 'vitest/config';

// The headless node is pure Node logic — every test injects its own fetch, fs,
// clock and command-runner fakes, so no network, no real filesystem and no
// real timers are ever touched.
export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.spec.ts'],
		// ...with ONE deliberate exception: `model-execution/model-process.spec.ts`
		// and the windows-job-launcher suites exercise a REAL process boundary, so
		// they spawn real child processes and wait on real containment closure.
		// Against vitest's 5 s default that is a race on a loaded self-hosted
		// runner, and the family trips a different member each run:
		//   develop 2026-08-27 — "…version-probe containment closure never settles"
		//   stage   2026-08-27 — "distinguishes a nonzero CLI process exit"
		// both `Test timed out in 5000ms`. Because the root script runs
		// `turbo run test`, whichever member trips first used to abort the whole
		// step and ~88 of 117 task results were never produced.
		//
		// One suite-wide bound beats patching individual tests: the slowest case
		// here already needed 10 s, so 20 s is ~2x the known worst case and still
		// bounded — a genuinely hung test fails, it does not hang the run.
		// Per-test timeouts (e.g. the explicit 10_000 in model-process.spec.ts)
		// still win where they are set.
		testTimeout: 20_000,
		// Harness setup/teardown creates temp workspaces and reaps child
		// processes, so give hooks the same headroom.
		hookTimeout: 20_000
	}
});
