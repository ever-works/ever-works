import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	// `@ever-works/contracts` is bundled, not merely externalised as the
	// sibling plugins do: this plugin imports RUNTIME VALUES from it (the
	// first-party go-to-market Skill pack), not just types, so the pack has
	// to travel inside the plugin bundle rather than depend on the loader's
	// module resolution.
	noExternal: ['@ever-works/plugin', '@ever-works/contracts'],
	format: ['cjs', 'esm'],
	dts: true,
	clean: true,
	sourcemap: false,
	splitting: false,
	treeshake: true
});
