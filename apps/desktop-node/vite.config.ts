import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Renderer build for the Desktop Node UI (setup wizard + status window).
// This app is a thin shell — all enrollment/heartbeat logic lives in
// `ever-works-node`'s core and runs in the main process, so the bundle stays
// tiny. Output goes to dist/renderer next to the tsc-compiled main process
// (dist/main) so electron-builder can package a single dist/ tree.
export default defineConfig({
	base: './',
	plugins: [react()],
	build: {
		outDir: 'dist/renderer',
		emptyOutDir: true
	},
	test: {
		environment: 'node',
		include: ['src/**/*.spec.ts'],
		// `ever-works-node` resolves through its package.json `exports`, which
		// point at `dist/` — but the root build script deliberately excludes
		// apps/node (and both desktop apps): they are packaged by
		// electron-builder, not by `pnpm build`. `pnpm test` has no such
		// filter, so in CI these specs ran against a package that is never
		// built and died with "Failed to resolve entry for package
		// ever-works-node" before a single assertion.
		//
		// Point vitest at the source entry instead. The unit specs only need
		// the pure projections (`normalizeApiUrl`, `redactConfig`, the config
		// types), so resolving from source is both correct and hermetic — it
		// removes the build-order dependency rather than papering over it.
		// Scoped to `test` so the electron/renderer build keeps resolving the
		// compiled package exactly as it does today.
		alias: {
			'ever-works-node': fileURLToPath(new URL('../node/src/index.ts', import.meta.url))
		}
	}
});
