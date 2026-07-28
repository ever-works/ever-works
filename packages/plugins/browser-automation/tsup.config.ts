import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	noExternal: ['@ever-works/plugin'],
	// Playwright is loaded through a RUNTIME dynamic import so esbuild
	// never traces it: the deployed image may not carry a browser, and
	// absence is a SUPPORTED degradation (BrowserAutomationNotProvisioned)
	// rather than a module-load crash.
	external: ['playwright-core'],
	format: ['cjs', 'esm'],
	dts: true,
	clean: true,
	sourcemap: false,
	splitting: false,
	treeshake: true
});
