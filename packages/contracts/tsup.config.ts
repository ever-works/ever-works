import { defineConfig } from 'tsup';

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/item/index.ts',
		'src/domain/index.ts',
		'src/form/index.ts',
		'src/api/index.ts',
		'src/telemetry/index.ts'
	],
	format: ['esm', 'cjs'],
	dts: true,
	clean: true,
	sourcemap: false,
	splitting: false,
	treeshake: true,
	target: 'es2021',
	outDir: 'dist'
});
