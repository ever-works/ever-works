import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	// `@atproto/api` ships ESM only. The plugin loader resolves the
	// package `main` (the CJS build), so leaving the SDK external would
	// emit a `require()` of an ESM-only package. Bundling it into BOTH
	// outputs keeps the CJS entry loadable on every supported runtime.
	noExternal: ['@ever-works/plugin', '@atproto/api'],
	format: ['esm', 'cjs'],
	dts: true,
	clean: true,
	sourcemap: false,
	splitting: false,
	treeshake: true,
	target: 'es2021',
	outDir: 'dist'
});
