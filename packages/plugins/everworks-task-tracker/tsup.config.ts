import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	noExternal: ['@ever-works/plugin'],
	format: ['cjs', 'esm'],
	dts: true,
	clean: true,
	sourcemap: false,
	splitting: false,
	treeshake: true,
});
