import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

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
		include: ['src/**/*.spec.ts']
	}
});
