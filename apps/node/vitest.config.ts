import { defineConfig } from 'vitest/config';

// The headless node is pure Node logic — every test injects its own fetch, fs,
// clock and command-runner fakes, so no network, no real filesystem and no
// real timers are ever touched.
export default defineConfig({
	test: {
		environment: 'node',
		include: ['src/**/*.spec.ts']
	}
});
