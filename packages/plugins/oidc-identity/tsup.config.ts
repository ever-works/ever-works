import { defineConfig } from 'tsup';

export default defineConfig({
	// APW-12 T8 — two entries, and the split is a requirement rather than a
	// convenience: plan §10.4 publishes the fake provider "only through a `./testing`
	// subpath export, never from the main entry". `splitting: false` keeps the two
	// bundles independent, so `dist/index.js` cannot reach
	// `dist/testing/fake-oidc-provider.js` through a shared chunk either.
	entry: {
		index: 'src/index.ts',
		'testing/fake-oidc-provider': 'src/testing/fake-oidc-provider.ts'
	},
	noExternal: ['@ever-works/plugin'],
	format: ['cjs', 'esm'],
	dts: true,
	splitting: false,
	sourcemap: false,
	clean: true
});
