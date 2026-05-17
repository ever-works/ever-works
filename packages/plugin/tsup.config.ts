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
		'src/api/index.ts',
		'src/git/index.ts',
		'src/ai/index.ts',
		'src/keywords/index.ts',
		'src/cli-pipeline/index.ts',
		'src/code-edit/index.ts'
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
