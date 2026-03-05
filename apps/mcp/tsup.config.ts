import { defineConfig } from 'tsup';

export default defineConfig({
	entry: { stdio: 'src/stdio.ts', http: 'src/http.ts' },
	format: ['esm'],
	target: 'node20',
	outDir: 'dist',
	clean: true,
	sourcemap: true,
	splitting: true,
});
