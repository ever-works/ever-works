import { defineConfig } from 'tsup';

/**
 * The controller ships as ONE executable bundle, not a library.
 *
 * That is the difference between this package and `@ever-works/apps-tier-crds`, which builds dual
 * CJS/ESM with `.d.ts` because both ends of the tier import it. Nothing imports the controller —
 * Kubernetes starts it — so there is no `dts`, no CJS half and a shebang on the entrypoint.
 */
export default defineConfig({
	entry: ['src/main.ts'],
	format: ['esm'],
	dts: false,
	clean: true,
	sourcemap: true,
	splitting: false,
	treeshake: true,
	banner: { js: '#!/usr/bin/env node' }
});
