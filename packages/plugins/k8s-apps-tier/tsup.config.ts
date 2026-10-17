import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	// BOTH workspace packages are bundled into this plugin's dist. The Trigger.dev worker image copies
	// each plugin's dist/ alone and installs only its NON-workspace dependencies
	// (`packages/tasks/src/build/collect-plugin-deps.ts` skips `workspace:` / `@ever-works/*`), so a
	// runtime `require('@ever-works/k8s-plugin')` would not resolve inside the isolated App runtime
	// worker. The k8s plugin's own third-party dependencies are declared here so they are installed.
	noExternal: ['@ever-works/plugin', '@ever-works/k8s-plugin'],
	external: ['@kubernetes/client-node', 'js-yaml'],
	format: ['cjs', 'esm'],
	dts: true,
	clean: true,
	sourcemap: false,
	splitting: false,
	treeshake: true
});
