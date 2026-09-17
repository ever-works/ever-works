#!/usr/bin/env node
/**
 * Generates the five App-spec profiles `APW-13-golden-paths/blueprints/app-fixture-hello/README.md` names:
 * `all-dependencies`, `missing-value`, `secret-in-image`, `build-services`, `build-timeout`.
 *
 * WHY A GENERATOR: each profile is the fixture's `.works/works.yml` with ONE documented delta, and the
 * README requires them to differ "only in the build values, build services or build time limit their
 * variant needs". Hand-copying 140 lines five times guarantees drift from the base spec the moment the
 * Blueprint changes. This script reads the base Blueprint and applies the delta, so a base change
 * propagates on the next run.
 *
 * RUN:  node profiles/_generate.mjs            (writes the five files, then validates them)
 *       node profiles/_generate.mjs --check    (writes nothing; exits 1 if any output would change)
 *
 * The deltas reference only outputs `APW-03/schema.md` §11 lists for `from:` — `redis.url`,
 * `objectStorage.{endpoint,region,accessKeyId,secretAccessKey,bucket.<name>}` — so every profile is a
 * spec the schema accepts, not an illustration.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.resolve(here, '..');
const appWorks = path.resolve(fixtureRoot, '..', '..');
const BASE = path.join(
	appWorks,
	'APW-13-golden-paths',
	'blueprints',
	'app-fixture-hello',
	'.works',
	'works.yml'
);
const SCHEMA = path.join(appWorks, '_build-artifacts', 'apw-03-schema', 'app-spec.schema.json');

// `yaml` and `ajv` come from the platform's own node_modules — nothing is installed for this.
const require = createRequire(path.join('E:/Coding/Ever_Gauzy_placeholder/', 'index.js'));
function loadModule(name) {
	// Resolve out of the platform worktree first, then the Gauzy checkout the harness already uses.
	const candidates = [
		path.join(appWorks, 'node_modules', name),
		'E:/Coding/Ever Gauzy/ever-gauzy/node_modules/' + name
	];
	for (const candidate of candidates) {
		try {
			return require(candidate);
		} catch {
			/* try the next one */
		}
	}
	throw new Error(`cannot resolve ${name} from ${candidates.join(' or ')}`);
}
const YAML = loadModule('yaml');

const checkOnly = process.argv.includes('--check');

/** Deep clone without touching the prototype. */
const clone = (value) => JSON.parse(JSON.stringify(value));

// ── the deltas ────────────────────────────────────────────────────────────────────────────────────────
// Each entry: { file, why, apply(spec) }  — `spec` is the parsed document; mutate it in place.
const PROFILES = [
	{
		file: 'all-dependencies.works.yml',
		why:
			'Adds Redis and object storage, so `GET /state` also reports `redisPing` and `bucketRoundTrip` ' +
			'(APW-13 plan §4.4; ACC-07 lanes that need every dependency kind present).',
		apply(spec) {
			spec.spec.dependencies.redis = { version: '7', maxmemoryPolicy: 'noeviction' };
			spec.spec.dependencies.objectStorage = {
				buckets: ['uploads', 'public-assets'],
				publicBuckets: ['public-assets']
			};
			// Env names are the ones `src/config.mjs` reads; outputs are schema.md §11's list.
			spec.spec.env.push(
				{ name: 'REDIS_URL', secret: true, from: 'deps.redis.url' },
				{ name: 'OBJECT_STORAGE_ENDPOINT', from: 'deps.objectStorage.endpoint' },
				{ name: 'OBJECT_STORAGE_REGION', from: 'deps.objectStorage.region' },
				{ name: 'OBJECT_STORAGE_ACCESS_KEY_ID', secret: true, from: 'deps.objectStorage.accessKeyId' },
				{ name: 'OBJECT_STORAGE_SECRET_ACCESS_KEY', secret: true, from: 'deps.objectStorage.secretAccessKey' },
				{ name: 'OBJECT_STORAGE_BUCKET', template: '{{deps.objectStorage.bucket.uploads}}' }
			);
			spec.spec.smoke.push({
				name: 'state-reports-dependencies',
				http: { method: 'GET', path: '/state' },
				expect: { status: [200], bodyContains: ['"redisPing"', '"bucketRoundTrip"'] }
			});
		}
	},
	{
		file: 'missing-value.works.yml',
		why:
			'The build value `FIXTURE_BUILD_LABEL` is declared but nobody supplies it, so the build plugin ' +
			'refuses before building (`EW_MISSING`, exit 78) — ACC-05-14 / ACC-05-17.',
		apply(spec) {
			const entry = spec.spec.env.find((e) => e.name === 'FIXTURE_BUILD_LABEL');
			// A prompt with `required: false` that the harness does not answer IS the "left unset" case,
			// and it is a valid spec (exactly one value source), unlike an entry with no source at all.
			entry.phase = 'build';
			delete entry.value;
			entry.prompt = {
				description: 'Deliberately not supplied by the missing-value lane',
				required: false
			};
				'fromEnv names an entry the lane leaves unset — the build must refuse, not guess.';
		}
	},
	{
		file: 'secret-in-image.works.yml',
		why:
			'A SECRET is passed as a build argument, so the build plugin must refuse (or strip) it rather ' +
			'than bake it into the image — ACC-05-15. The fixture has no other way to prove the rule bites.',
		apply(spec) {
			const entry = spec.spec.env.find((e) => e.name === 'FIXTURE_BUILD_LABEL');
			entry.secret = true;
			delete entry.value;
			entry.generate = { kind: 'chars', length: 16, rotate: 'never' };
				'fromEnv names a secret: true entry — refused as a build argument (a build-arg secret can leak into logs and image metadata).';
		}
	},
	{
		file: 'build-services.works.yml',
		why:
			'The build declares an ephemeral Postgres and points DATABASE_URL at it, so a build stage ' +
			'migrates the throwaway database and never the App Work\'s — ACC-05-12.',
		apply(spec) {
			spec.spec.build.services = [{ name: 'postgres', image: 'postgres:16' }];
			// The override must win over the runtime value, which is why it is a build arg and not `env`.
			spec.spec.build.args.push({
				name: 'DATABASE_URL',
				value: 'postgresql://postgres@127.0.0.1:5432/app_fixture'
			});
				'DATABASE_URL here is the ephemeral build service above, discarded with the build — not the App Work\'s database.';
		}
	},
	{
		file: 'build-timeout.works.yml',
		why:
			'The build limit is 5 minutes, which the `variant/build-timeout` branch\'s slow step outlasts, ' +
			'so the Build ends `timed out` rather than hanging the runner — ACC-05-17.',
		apply(spec) {
			spec.spec.build.resources = { cpu: 2, memory: '4Gi', timeoutMinutes: 5 };
				'Pair with the variant branch that adds the slow build step; this profile only sets the limit.';
		}
	}
];

// ── generate ─────────────────────────────────────────────────────────────────────────────────────────
const baseText = fs.readFileSync(BASE, 'utf8');
if (!fs.existsSync(BASE)) throw new Error(`base Blueprint not found: ${BASE}`);
const header =
	'# yaml-language-server: $schema=https://api.ever.works/api/schema/works.yml.schema.json\n' +
	'#\n' +
	'# GENERATED by `_build-artifacts/fixture-app/profiles/_generate.mjs` — edit the generator, not this file.\n' +
	'#\n' +
	'# Profile of `APW-13-golden-paths/blueprints/app-fixture-hello/.works/works.yml`. It differs from the base\n' +
	'# spec ONLY in the delta below; regenerate after any base change with `node profiles/_generate.mjs`.\n' +
	'#\n';

let wrote = 0;
const written = [];
for (const profile of PROFILES) {
	const spec = YAML.parse(baseText);
	profile.apply(spec);
	const note = profile.why
		.split(/(?<=\.)\s+/)
		.map((line) => `#   ${line}`)
		.join('\n');
	const text =
		header +
		`# DELTA: ${profile.file}\n` +
		note +
		'\n' +
		YAML.stringify(spec, { lineWidth: 0, indent: 2 });
	const target = path.join(here, profile.file);
	const previous = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
	if (previous === text) {
		written.push(`${profile.file}: unchanged`);
		continue;
	}
	if (checkOnly) {
		written.push(`${profile.file}: WOULD CHANGE`);
		continue;
	}
	fs.writeFileSync(target, text);
	wrote += 1;
	written.push(`${profile.file}: written (${text.length} bytes)`);
}

// ── verify every profile against the real schema ───────────────────────────────────────────────────────
let failures = 0;
let Ajv = null;
try {
	const ajvModule = loadModule('ajv/dist/2020.js');
	Ajv = ajvModule.default ?? ajvModule;
} catch (error) {
	console.log(`! ajv unavailable (${error.message}) — structural checks skipped, YAML only`);
}
const schema = Ajv ? JSON.parse(fs.readFileSync(SCHEMA, 'utf8')) : null;
const validate = Ajv ? new Ajv({ strict: false, allErrors: true, allowUnionTypes: true }).compile(schema) : null;

for (const profile of PROFILES) {
	const file = path.join(here, profile.file);
	if (!fs.existsSync(file)) {
		console.log(`✖ ${profile.file}: not written`);
		failures += 1;
		continue;
	}
	const text = fs.readFileSync(file, 'utf8');
	let parsed;
	try {
		parsed = YAML.parse(text);
	} catch (error) {
		console.log(`✖ ${profile.file}: YAML does not parse — ${error.message}`);
		failures += 1;
		continue;
	}
	if (!validate) {
		console.log(`• ${profile.file}: YAML ok (schema check unavailable)`);
		continue;
	}
	if (validate(parsed)) {
		console.log(`✔ ${profile.file}: schema PASS`);
	} else {
		failures += 1;
		console.log(`✖ ${profile.file}: schema FAIL`);
		for (const error of validate.errors.slice(0, 5)) {
			console.log(`    ${error.instancePath || '/'} ${error.message}`);
		}
	}
}

console.log('');
for (const line of written) console.log(`  ${line}`);
console.log(`\n${wrote} file(s) written, ${failures} failure(s)${checkOnly ? ' (check mode: nothing written)' : ''}`);
process.exit(failures === 0 ? 0 : 1);
