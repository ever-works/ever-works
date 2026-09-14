/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Stage the publishable `ever-works-node` package under `dist-bundle/`.
 *
 * The workspace package stays `private` — its manifest depends on
 * `workspace:*` packages (`@ever-works/contracts`, `@ever-works/plugin`,
 * `@ever-works/local-workspace-plugin`), some of which are not on the
 * public registry, so publishing it as-is would produce a package nobody
 * can install. Instead, like `apps/cli`, the CLI is bundled with esbuild
 * into ONE file with those packages inlined, and a small public manifest
 * is generated beside it:
 *
 *   dist-bundle/
 *     cli.js            the whole node, single file, CommonJS, shebang
 *     package.json      public manifest (bin, engines, optional native addons)
 *     packaging/        systemd unit + Windows install/uninstall scripts
 *     README.md, LICENSE
 *
 * The runtime dependencies left external are native addons, each
 * `require()`d lazily by a caller that degrades without it, so each ships
 * as an OPTIONAL dependency (see `bundleExternals`):
 *   - `@napi-rs/keyring` — the secret store; without it the credential
 *     stays in the owner-locked config file instead of the keychain;
 *   - the PTY prebuild — the `pty-local` terminal host; without it a live
 *     view's terminal channel runs on that plugin's pipe floor.
 *
 * Run `pnpm --filter ever-works-node build` first (type-check + the
 * workspace dependencies must be built); `build:bundle` then calls this.
 */
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const here = __dirname;
const repoRoot = path.resolve(here, '..', '..');
const outDir = path.join(here, 'dist-bundle');

const KEYRING_RANGE = '^1.1.0';
/** The PTY prebuild the bundled `pty-local` plugin requires lazily. */
const PTY_ADDON = '@homebridge/node-pty-prebuilt-multiarch';

/**
 * Every runtime dependency the bundle leaves EXTERNAL, with the range the
 * published manifest installs it at. The esbuild `external` list and the
 * manifest's `optionalDependencies` are both built from this one map, so a
 * native addon can never be kept out of the bundle without also being
 * shipped beside it.
 *
 * The PTY range is read from the `pty-local` plugin's own manifest (the
 * package that requires it) rather than restated: that plugin is inlined
 * into `cli.js`, so its manifest is never published, and a range copied
 * here would drift from the one it is built and tested against.
 */
function bundleExternals() {
	const ptyManifest = JSON.parse(
		fs.readFileSync(path.join(repoRoot, 'packages', 'plugins', 'pty-local', 'package.json'), 'utf8')
	);
	const ptyRange = ptyManifest.optionalDependencies?.[PTY_ADDON] ?? ptyManifest.dependencies?.[PTY_ADDON];
	if (typeof ptyRange !== 'string' || !ptyRange) {
		throw new Error(`packages/plugins/pty-local/package.json no longer declares ${PTY_ADDON}`);
	}
	return { '@napi-rs/keyring': KEYRING_RANGE, [PTY_ADDON]: ptyRange };
}

async function main() {
	const externals = bundleExternals();
	const manifest = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
	const version = readVersionSource();
	if (version !== manifest.version) {
		throw new Error(
			`apps/node/src/version.ts (${version}) and apps/node/package.json (${manifest.version}) disagree — bump both`
		);
	}

	fs.rmSync(outDir, { recursive: true, force: true });
	fs.mkdirSync(outDir, { recursive: true });

	await esbuild.build({
		entryPoints: [path.join(here, 'src', 'cli.ts')],
		bundle: true,
		platform: 'node',
		target: 'node22',
		format: 'cjs',
		outfile: path.join(outDir, 'cli.js'),
		// No banner: esbuild keeps the entry point's own `#!/usr/bin/env node`
		// (src/cli.ts) as the first line — a second copy is a syntax error.
		// Native addon, loaded lazily by the secret store; ships as an
		// optional dependency rather than being inlined.
		// The PTY prebuild the `pty-local` terminal host requires at runtime
		// is the same kind of addon: kept external, and without it a live
		// view's terminal channel runs on that plugin's pipe floor.
		external: Object.keys(externals),
		keepNames: true,
		minify: false,
		sourcemap: false,
		legalComments: 'none',
		logLevel: 'info'
	});

	const publishable = buildPublishableManifest(manifest, version, externals);
	fs.writeFileSync(path.join(outDir, 'package.json'), `${JSON.stringify(publishable, null, 2)}\n`);

	fs.cpSync(path.join(here, 'packaging'), path.join(outDir, 'packaging'), { recursive: true });
	fs.copyFileSync(path.join(here, 'README.md'), path.join(outDir, 'README.md'));
	const licence = ['LICENSE', 'LICENSE.md', 'LICENSES.md']
		.map((name) => path.join(repoRoot, name))
		.find(fs.existsSync);
	if (licence) fs.copyFileSync(licence, path.join(outDir, 'LICENSE'));

	assertBundleShape(path.join(outDir, 'cli.js'));
	const size = fs.statSync(path.join(outDir, 'cli.js')).size;
	console.log(
		`ever-works-node ${version} staged in ${path.relative(repoRoot, outDir)} (cli.js ${Math.round(size / 1024)} KB)`
	);
}

/**
 * The public manifest staged beside `cli.js`. Every external the bundle
 * leaves out is an OPTIONAL dependency here: each is a native addon its
 * caller degrades without, so an install whose prebuild is unavailable
 * still works.
 */
function buildPublishableManifest(manifest, version, externals) {
	return {
		name: 'ever-works-node',
		version,
		description: manifest.description,
		author: manifest.author,
		license: manifest.license,
		homepage: 'https://ever.works',
		repository: {
			type: 'git',
			url: 'https://github.com/ever-works/ever-works.git',
			directory: 'apps/node'
		},
		bugs: { url: 'https://github.com/ever-works/ever-works/issues' },
		keywords: ['ever-works', 'fleet', 'agent', 'node', 'runner', 'claude-code', 'codex'],
		bin: { 'ever-works-node': './cli.js' },
		main: './cli.js',
		files: ['cli.js', 'packaging', 'README.md', 'LICENSE'],
		engines: { node: '>=22.0.0' },
		optionalDependencies: { ...externals },
		publishConfig: { access: 'public' }
	};
}

/**
 * Cheap invariants on the staged file, so a broken bundle fails HERE and
 * not on the first machine that runs `npm install -g`: exactly one shebang
 * on line 1 (esbuild keeps the source one; a banner would double it),
 * no `workspace:` specifier left behind (every workspace package must be
 * inlined), and the keyring still required by name (it stays external,
 * shipped as an optional dependency).
 */
function assertBundleShape(file) {
	const bundle = fs.readFileSync(file, 'utf8');
	const lines = bundle.split('\n', 2);
	if (lines[0] !== '#!/usr/bin/env node' || (lines[1] ?? '').startsWith('#!')) {
		throw new Error(`${file}: expected exactly one shebang on line 1`);
	}
	if (/workspace:[*^~]/.test(bundle)) {
		throw new Error(`${file}: a workspace:* specifier survived bundling`);
	}
	if (!/require\(["']@napi-rs\/keyring["']\)/.test(bundle)) {
		throw new Error(`${file}: @napi-rs/keyring is no longer required by name (it must stay external)`);
	}
}

/** The version the binary reports, read from the one source the code uses. */
function readVersionSource() {
	const source = fs.readFileSync(path.join(here, 'src', 'version.ts'), 'utf8');
	const match = /NODE_APP_VERSION\s*=\s*'([^']+)'/.exec(source);
	if (!match) throw new Error('apps/node/src/version.ts: NODE_APP_VERSION not found');
	return match[1];
}

if (require.main === module) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}

// For the packaging spec (`src/core/packaging/publishable-manifest.internal.spec.ts`);
// `node build.js` runs `main()` above and ignores these.
module.exports = { bundleExternals, buildPublishableManifest };
