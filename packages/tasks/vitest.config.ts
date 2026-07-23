import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        include: ['src/**/*.{test,spec}.ts'],
        // Task specs cold-import the worker graph (@trigger.dev/sdk + the
        // full task tree) in beforeAll/beforeEach; on saturated CI runners a
        // single cold import has been measured past 30s (three consecutive
        // "Hook timed out in 30000ms" reds on agent-task-execute even after
        // the resetModules removal). The budget only matters under load —
        // fast hooks still finish fast — so give hooks real headroom instead
        // of chasing the runner-contention tail one bump at a time.
        hookTimeout: 120000,
        testTimeout: 30000,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
        },
    },
});
