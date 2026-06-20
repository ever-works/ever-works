import { defineConfig } from 'tsup';

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/contracts/index.ts',
		// Test-only conformance suite published so concrete plugin
		// packages can `import { runJobRuntimeContractSuite } from
		// '@ever-works/plugin/contracts-conformance'` and prove their
		// implementation satisfies the IJobRuntimeProvider contract.
		// `vitest` stays external — consumer's dev-dep provides it.
		'src/contracts-conformance/index.ts',
		'src/pipeline/index.ts',
		'src/events/index.ts',
		'src/settings/index.ts',
		'src/common/index.ts',
		'src/helpers/index.ts',
		// Server-only SSRF guard published as a dedicated subpath so client
		// bundles that pull in `@ever-works/plugin/helpers` don't get
		// `node:net` / `node:dns`. Consumers import from
		// `@ever-works/plugin/helpers/ssrf-guard`.
		'src/helpers/ssrf-guard.ts',
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
	outDir: 'dist',
	// `vitest` is a peer-dep — keep it external so we don't ship the
	// whole test runner inside the consumer-facing
	// `contracts-conformance` bundle.
	external: ['vitest']
});
