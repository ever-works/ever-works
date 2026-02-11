import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	noExternal: ['@ever-works/plugin'],
	format: ['esm', 'cjs'],
	dts: true,
	clean: true,
	sourcemap: true,
	splitting: false,
	treeshake: true,
	target: 'es2021',
	outDir: 'dist'
});
