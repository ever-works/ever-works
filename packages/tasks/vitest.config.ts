import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        include: ['src/**/*.{test,spec}.ts'],
        // Several suites `vi.resetModules()` + dynamically re-import task
        // modules in beforeEach; those modules now pull in the tenant-runtime
        // worker graph, so a cold re-import under CI runner load can exceed
        // vitest's 10 s hook default (flake seen on the shared ARC pool).
        // Raise both ceilings — the hooks are correct, just occasionally slow.
        hookTimeout: 30000,
        testTimeout: 30000,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
        },
    },
});
