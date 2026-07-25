import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Renderer build for the Ever Works Desktop pre-boot UI (install wizard +
// service status screen). The application body after boot is the platform
// web UI loaded from http://localhost:3000 — this bundle deliberately stays
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
