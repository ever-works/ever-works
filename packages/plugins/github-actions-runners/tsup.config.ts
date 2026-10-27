import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	// Bundled, not resolved at run time: the plugin directory of a deployment
	// holds only `dist`, so the two workspace packages it uses travel inside it.
	noExternal: ['@ever-works/plugin', '@ever-works/contracts'],
	format: ['cjs', 'esm'],
	dts: true,
	clean: true,
	sourcemap: false,
	splitting: false,
	treeshake: true
});
