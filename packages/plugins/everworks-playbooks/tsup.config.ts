import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	// `@ever-works/contracts` is bundled rather than externalised: this plugin
	// imports RUNTIME VALUES from it (the entry validator and sanitiser), so
	// they have to travel inside the plugin bundle instead of depending on the
	// loader's module resolution. Same posture as `everworks-skills`.
	noExternal: ['@ever-works/plugin', '@ever-works/contracts'],
	format: ['cjs', 'esm'],
	dts: true,
	clean: true,
	sourcemap: false,
	splitting: false,
	treeshake: true
});
