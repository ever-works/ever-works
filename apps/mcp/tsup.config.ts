import { defineConfig } from 'tsup';

export default defineConfig({
	entry: { stdio: 'src/main.stdio.ts', http: 'src/main.http.ts' },
	format: ['esm'],
	target: 'node20',
	outDir: 'dist',
	clean: true,
	sourcemap: true,
	splitting: true,
	external: [/^[^./]/]
});
