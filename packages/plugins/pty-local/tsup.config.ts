import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	noExternal: ['@ever-works/plugin'],
	// Native addon loaded via RUNTIME require — esbuild must never trace
	// or bundle it (.node binaries aren't bundleable; absence at runtime
	// is a SUPPORTED degradation to the child_process pipe floor).
	external: ['@homebridge/node-pty-prebuilt-multiarch'],
	format: ['cjs', 'esm'],
	dts: true,
	clean: true,
	sourcemap: false,
	splitting: false,
	treeshake: true
});
