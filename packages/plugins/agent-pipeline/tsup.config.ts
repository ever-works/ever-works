import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	noExternal: ['@ever-works/plugin', 'tokenx'],
	format: ['cjs', 'esm'],
	dts: true,
	splitting: false,
	sourcemap: false,
	clean: true
});
