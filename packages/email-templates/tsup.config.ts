import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm', 'cjs'],
	dts: true,
	clean: true,
	sourcemap: false,
	splitting: false,
	treeshake: true,
	target: 'es2021',
	outDir: 'dist',
	// React + react-dom + @react-email stay external (provided by the
	// consuming app's node_modules) so we don't bundle a second React.
	external: ['react', 'react-dom', '@react-email/components', '@react-email/render']
});
