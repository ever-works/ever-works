import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	noExternal: ['@ever-works/plugin', '@ever-works/contracts'],
	format: ['cjs', 'esm'],
	dts: true,
	clean: true,
	sourcemap: false,
	splitting: false,
	treeshake: true
});
