import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	noExternal: ['@ever-works/plugin', 'simstudio-ts-sdk'],
	format: ['cjs', 'esm'],
	dts: true,
	splitting: false,
	sourcemap: false,
	clean: true
});
