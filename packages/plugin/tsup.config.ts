import { defineConfig } from 'tsup';

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/contracts/index.ts',
		'src/pipeline/index.ts',
		'src/events/index.ts',
		'src/settings/index.ts',
		'src/common/index.ts',
		'src/helpers/index.ts',
		'src/abstract/index.ts',
		'src/testing/index.ts',
		'src/api/index.ts'
	],
	format: ['esm'],
	dts: true,
	clean: true,
	sourcemap: true,
	splitting: false,
	treeshake: true,
	target: 'es2021',
	outDir: 'dist'
});
