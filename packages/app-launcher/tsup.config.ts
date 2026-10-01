import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts'],
	// Load-bearing (T10 / plan §6.1, APW11-G15): tsup externalises `dependencies`
	// by default, so a bare `import ... from 'lit'` would survive into
	// `dist/index.js` — the 30 KB size check would then measure an artifact that
	// does not contain Lit, and T27's static fixture pages (a plain
	// `<script type="module" src="./dist/index.js">` with no import map) could
	// not resolve it. The precedent is `packages/plugins/k8s/tsup.config.ts`.
	noExternal: ['lit'],
	format: ['esm'],
	dts: true,
	clean: true,
	sourcemap: false,
	splitting: false,
	treeshake: true,
	target: 'es2021',
	platform: 'browser'
});
