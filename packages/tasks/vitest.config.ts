import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        include: ['src/**/*.{test,spec}.ts'],
        // Several suites `vi.resetModules()` + dynamically re-import task
        // modules in beforeEach; those modules pull in the tenant-runtime
        // worker graph. The whole suite runs in ~7 s locally, but a single
        // cold re-import hook has spiked past 10 s and then 30 s on the
        // heavily-loaded shared ARC pool (IO/CPU contention with the parallel
        // build+matrix jobs). 60 s gives 8x headroom over the local cost so a
        // runner load spike can't flake it — the hooks are correct, not slow.
        hookTimeout: 60000,
        testTimeout: 60000,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
        },
    },
});
