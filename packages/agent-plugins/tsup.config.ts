import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm', 'cjs'],
	dts: true,
	clean: true,
	sourcemap: false,
	splitting: false,
	treeshake: true,
	target: 'es2022',
	platform: 'node',
	outDir: 'dist',
	// The canonical JSON Schemas are imported via `resolveJsonModule` so tsup
	// inlines them into `dist/`. They MUST ship inside `dist/` rather than at
	// the package root: both packaging scripts (`scripts/prepare-docker-plugins.js`
	// and `packages/tasks/scripts/prepare-plugins.js`) copy `dist/` only, and the
	// specification forbids retrieving a schema over the network while loading a
	// plugin (spec 5.2).
	loader: { '.json': 'json' }
});
