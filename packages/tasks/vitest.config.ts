import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        include: ['src/**/*.{test,spec}.ts'],
        // Many task specs `vi.resetModules()` + `await import(...)` the worker
        // graph in beforeEach; that cold re-import can exceed the default 10s
        // hook timeout under CI load (flaky "Hook timed out in 10000ms"). Give
        // hooks headroom so a slow re-import doesn't red the whole shard.
        hookTimeout: 30000,
        testTimeout: 30000,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
        },
    },
});
