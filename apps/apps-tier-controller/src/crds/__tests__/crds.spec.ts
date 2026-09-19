/**
 * T3 — the CRD suite (tasks T3's Test line; ACC-10-26, ACC-10-27; APW10-G21).
 *
 * Four things are proven here, in the order the task states them:
 *
 * 1. **The committed `deploy/crds/*.yaml` is byte-identical to a fresh generation**, for all five
 *    kinds, plus the directory holds nothing this generator does not produce. That is the drift
 *    gate: `pnpm test` is what fails when a schema changes and the manifests do not, so no CI job
 *    needs a special step beyond running the suite (`pnpm --filter ever-works-apps-tier-controller
 *    test`, which T10's workflow already runs).
 * 2. **`Work` refuses an unknown field under `spec`**, `namespace` among them (ACC-10-26), refuses
 *    an image that is not digest-pinned, and refuses every FR-26 bound at N+1 while accepting N
 *    (ACC-10-27) — each with a positive control, because a validator that refuses everything
 *    validates nothing.
 * 3. **The whole-object 512 KiB rule** (plan §3.1:272) is enforced where the plan puts it: a CRD
 *    cannot measure its own object (APW10-G21), so the rule is `exceedsWorkObjectLimit` — proven at
 *    the boundary, exactly 512 KiB accepted and 512 KiB + 1 byte refused.
 * 4. **The generated schemas are structural schemas the apiserver would accept**, as far as that can
 *    be shown without a cluster: no construct a structural schema forbids, no `additionalProperties`
 *    at a root, no `x-kubernetes-preserve-unknown-fields`, and every manifest loads with the client
 *    library the controller applies it with (`@kubernetes/client-node`). What is **not** proven is
 *    stated in the report: nothing here has been applied to a real API server, so `--dry-run=server`
 *    remains unexercised (T11's kind job is where it lands).
 */
import { readdirSync, readFileSync } from 'node:fs';

import { loadYaml, type KubernetesObject } from '@kubernetes/client-node';
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import { describe, expect, it } from 'vitest';

import {
	APPS_TIER_API_GROUP,
	APPS_TIER_API_VERSION,
	APPS_TIER_MAX_COMPONENT_REPLICAS,
	APPS_TIER_MAX_COMPONENT_VOLUMES,
	APPS_TIER_MAX_COMPONENTS,
	APPS_TIER_MAX_CRON,
	APPS_TIER_MAX_ENV_NAMES,
	APPS_TIER_MAX_HOSTS,
	APPS_TIER_MAX_IMAGES,
	APPS_TIER_MAX_JOBS,
	APPS_TIER_MAX_JOB_TIMEOUT_SECONDS,
	APPS_TIER_MAX_SEALED_ENV_BYTES,
	APPS_TIER_MAX_SMOKE,
	LAUNCH_GATE_ITEM_IDS
} from '@ever-works/contracts';

import type { CrdManifestFile, JsonSchema } from '../index.js';
import {
	crdManifestFiles,
	exceedsWorkObjectLimit,
	parseCrdManifest,
	WORK_OBJECT_LIMIT_BYTES,
	workObjectBytes
} from '../index.js';

/** Where the committed manifests are, resolved from this file — never from the working directory. */
const COMMITTED_DIRECTORY = new URL('../../../deploy/crds/', import.meta.url);

const MANIFESTS: readonly CrdManifestFile[] = crdManifestFiles();
const WORK = MANIFESTS.find((file) => file.kind === 'Work');
const SELF_CHECK = MANIFESTS.find((file) => file.kind === 'SelfCheck');

/** The `openAPIV3Schema` of a generated manifest, as the apiserver would read it. */
function openApiSchema(file: CrdManifestFile): JsonSchema {
	return file.manifest.spec.versions[0].schema.openAPIV3Schema;
}

/** Compile a kind's schema. `strict: false` — a CRD schema is structural-schema flavoured, not
 * draft-2020-strict, and Ajv's strict mode would reject constructs the apiserver accepts. */
function compile(file: CrdManifestFile): ValidateFunction {
	return new Ajv({ allErrors: true, strict: false }).compile(openApiSchema(file));
}

const workValidator = compile(WORK as CrdManifestFile);

/** A refusal, flattened into something a failure message can quote. */
function refusalsOf(validate: ValidateFunction, value: unknown): string[] {
	expect(validate(value)).toBe(false);
	return (validate.errors ?? []).map((error: ErrorObject) => {
		const at =
			error.keyword === 'additionalProperties'
				? `${error.instancePath || '/'} (unknown field)`
				: error.instancePath || '/';
		return `${at}: ${error.message ?? error.keyword}`;
	});
}

/** The positive control: an object the schema must accept. */
function expectAccepted(validate: ValidateFunction, value: unknown): void {
	const ok = validate(value);
	if (!ok)
		throw new Error(
			`expected the schema to accept this object, but it refused it: ${JSON.stringify(validate.errors, null, 2)}`
		);
	expect(ok).toBe(true);
}

/** Whether any refusal came from `keyword` at `pointer` — the assertion that a *specific* rule bit. */
function refusedAt(validate: ValidateFunction, value: unknown, keyword: string, pointer: string): boolean {
	expect(validate(value)).toBe(false);
	return (validate.errors ?? []).some((error) => error.keyword === keyword && error.instancePath === pointer);
}

/* ------------------------------------------------------------------------- *
 * Fixtures — a valid `Work` and one mutation per FR-26 bound
 * ------------------------------------------------------------------------- */

const WORK_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const DIGEST_IMAGE = `ghcr.io/example-owner/example/app@sha256:${'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00'}`;

/** One schema-valid component. */
function component(name: string, role: 'web' | 'worker'): Record<string, unknown> {
	return {
		name,
		role,
		command: ['node', 'src/server.mjs'],
		args: [],
		port: 8080,
		replicas: 1,
		resources: { cpu: '50m', memory: '64Mi', memoryLimit: '128Mi' },
		probes: { startup: { kind: 'http', path: '/healthz', periodSeconds: 2, failureThreshold: 30 } },
		volumes: [],
		writableRootFilesystem: false
	};
}

/** A whole, valid `Work.spec` — the positive control's subject (plan §3.1:230–253). */
function validSpec(): Record<string, unknown> {
	return {
		workId: WORK_ID,
		ownerUserId: OWNER_ID,
		organizationId: null,
		generation: 1,
		quotaProfile: 'starter',
		desiredState: 'running',
		pausedReplicas: null,
		dataDeletion: null,
		quarantine: null,
		egressThrottle: false,
		images: [{ component: 'web', source: DIGEST_IMAGE }],
		components: [component('web', 'web'), component('worker', 'worker')],
		jobs: [
			{
				name: 'migrate',
				when: 'pre-deploy',
				component: 'web',
				command: ['node', 'src/migrate.mjs'],
				timeoutSeconds: 120
			}
		],
		cron: [
			{
				name: 'tick',
				schedule: '*/5 * * * *',
				http: { method: 'POST', path: '/cron/tick', authEnv: 'CRON_TOKEN', authScheme: 'bearer' }
			}
		],
		smoke: [
			{
				name: 'healthz',
				component: 'web',
				path: '/healthz',
				method: 'GET',
				expect: { status: [200], bodyContains: ['ok'], bodyNotContains: ['localhost'] },
				latencyMs: 2000,
				firstDeployOnly: false
			}
		],
		hosts: [{ host: 'app-fixture-hello.ever.works', kind: 'managed', customHostnameRef: null }],
		env: { sealed: 'c2VhbGVkLWVudg==', names: ['DATABASE_URL'] },
		dependencies: [{ kind: 'postgres', ref: 'dep-postgres' }]
	};
}

/** A valid `Work` object: `metadata` is the platform's, `spec` is above, no `status` yet. */
function validWork(): Record<string, unknown> {
	return {
		apiVersion: `${APPS_TIER_API_GROUP}/${APPS_TIER_API_VERSION}`,
		kind: 'Work',
		metadata: { name: `w-${WORK_ID}`, namespace: 'ever-works-apps-control' },
		spec: validSpec()
	};
}

/** The valid `Work` with one field replaced in its `spec`. */
function workWithSpecField(field: string, value: unknown): Record<string, unknown> {
	const work = validWork();
	(work.spec as Record<string, unknown>)[field] = value;
	return work;
}

/** The valid `Work` with `patch` applied to its `spec`. */
function workWithSpec(patch: (spec: Record<string, unknown>) => void): Record<string, unknown> {
	const work = validWork();
	patch(work.spec as Record<string, unknown>);
	return work;
}

/** One FR-26 bound: how to build a `spec` holding `n` of the thing, and where the refusal lands. */
interface BoundCase {
	readonly name: string;
	readonly limit: number;
	readonly pointer: string;
	readonly keyword: string;
	readonly withCount: (count: number) => Record<string, unknown>;
}

const FR26_BOUNDS: readonly BoundCase[] = [
	{
		name: 'components',
		limit: APPS_TIER_MAX_COMPONENTS,
		pointer: '/spec/components',
		keyword: 'maxItems',
		withCount: (count) =>
			workWithSpec((spec) => {
				spec.components = Array.from({ length: count }, (_, index) => component(`c${index}`, 'web'));
			})
	},
	{
		name: 'jobs',
		limit: APPS_TIER_MAX_JOBS,
		pointer: '/spec/jobs',
		keyword: 'maxItems',
		withCount: (count) =>
			workWithSpec((spec) => {
				spec.jobs = Array.from({ length: count }, (_, index) => ({
					name: `j${index}`,
					when: 'pre-deploy',
					component: 'web',
					command: ['node', 'src/migrate.mjs'],
					timeoutSeconds: 60
				}));
			})
	},
	{
		name: 'schedules',
		limit: APPS_TIER_MAX_CRON,
		pointer: '/spec/cron',
		keyword: 'maxItems',
		withCount: (count) =>
			workWithSpec((spec) => {
				spec.cron = Array.from({ length: count }, (_, index) => ({
					name: `c${index}`,
					schedule: '*/5 * * * *',
					http: { method: 'POST', path: '/cron/tick', authEnv: 'CRON_TOKEN', authScheme: 'bearer' }
				}));
			})
	},
	{
		name: 'smoke checks',
		limit: APPS_TIER_MAX_SMOKE,
		pointer: '/spec/smoke',
		keyword: 'maxItems',
		withCount: (count) =>
			workWithSpec((spec) => {
				spec.smoke = Array.from({ length: count }, (_, index) => ({
					name: `s${index}`,
					component: 'web',
					path: '/healthz',
					method: 'GET',
					expect: { status: [200], bodyContains: [], bodyNotContains: [] },
					latencyMs: 1000,
					firstDeployOnly: false
				}));
			})
	},
	{
		name: 'hosts',
		limit: APPS_TIER_MAX_HOSTS,
		pointer: '/spec/hosts',
		keyword: 'maxItems',
		withCount: (count) =>
			workWithSpec((spec) => {
				spec.hosts = Array.from({ length: count }, (_, index) => ({
					host: `host-${index}.ever.works`,
					kind: 'managed'
				}));
			})
	},
	{
		name: 'images',
		limit: APPS_TIER_MAX_IMAGES,
		pointer: '/spec/images',
		keyword: 'maxItems',
		withCount: (count) =>
			workWithSpec((spec) => {
				spec.images = Array.from({ length: count }, (_, index) => ({
					component: `c${index}`,
					source: DIGEST_IMAGE
				}));
			})
	},
	{
		name: 'environment variable names',
		limit: APPS_TIER_MAX_ENV_NAMES,
		pointer: '/spec/env/names',
		keyword: 'maxItems',
		withCount: (count) =>
			workWithSpec((spec) => {
				spec.env = {
					sealed: 'c2VhbGVkLWVudg==',
					names: Array.from({ length: count }, (_, index) => `VAR_${index}`)
				};
			})
	},
	{
		name: 'volumes on one component',
		limit: APPS_TIER_MAX_COMPONENT_VOLUMES,
		pointer: '/spec/components/0/volumes',
		keyword: 'maxItems',
		withCount: (count) =>
			workWithSpec((spec) => {
				(spec.components as Record<string, unknown>[])[0].volumes = Array.from(
					{ length: count },
					(_, index) => ({
						name: `v${index}`,
						path: `/data/${index}`,
						size: '1Gi'
					})
				);
			})
	},
	{
		name: 'replicas on one component',
		limit: APPS_TIER_MAX_COMPONENT_REPLICAS,
		pointer: '/spec/components/0/replicas',
		keyword: 'maximum',
		withCount: (count) =>
			workWithSpec((spec) => {
				(spec.components as Record<string, unknown>[])[0].replicas = count;
			})
	},
	{
		name: 'seconds of a job timeout',
		limit: APPS_TIER_MAX_JOB_TIMEOUT_SECONDS,
		pointer: '/spec/jobs/0/timeoutSeconds',
		keyword: 'maximum',
		withCount: (count) =>
			workWithSpec((spec) => {
				(spec.jobs as Record<string, unknown>[])[0].timeoutSeconds = count;
			})
	}
];

/* ------------------------------------------------------------------------- *
 * 1. The drift gate
 * ------------------------------------------------------------------------- */

describe('deploy/crds — the committed manifests are the generated ones (tasks T3, Done when "CI fails if generated CRDs drift")', () => {
	for (const file of MANIFESTS) {
		it(`${file.fileName} is byte-identical to a fresh generation`, () => {
			const committed = readFileSync(new URL(file.fileName, COMMITTED_DIRECTORY), 'utf8');
			if (committed !== file.yaml) {
				const generatedLines = file.yaml.split('\n');
				const committedLines = committed.split('\n');
				const differingLine = generatedLines.findIndex((line, index) => line !== committedLines[index]);
				throw new Error(
					`${file.fileName} has drifted from src/crds/${file.kind.toLowerCase()}.ts at line ${differingLine + 1}: ` +
						`committed ${JSON.stringify(committedLines[differingLine])} vs generated ${JSON.stringify(generatedLines[differingLine])}. ` +
						`Run \`pnpm --filter ever-works-apps-tier-controller generate:crds\` and commit the result.`
				);
			}
			expect(committed).toBe(file.yaml);
		});

		it(`${file.fileName} loads back into the manifest it was generated from`, () => {
			const committed = readFileSync(new URL(file.fileName, COMMITTED_DIRECTORY), 'utf8');
			expect(parseCrdManifest(committed)).toEqual(file.manifest);
		});

		it(`${file.fileName} parses with the client library the controller applies it with`, () => {
			const committed = readFileSync(new URL(file.fileName, COMMITTED_DIRECTORY), 'utf8');
			const loaded: KubernetesObject = loadYaml<KubernetesObject>(committed);
			expect(loaded.kind).toBe('CustomResourceDefinition');
			expect(loaded.metadata?.name).toBe(file.manifest.metadata.name);
			expect((loaded as { spec?: { scope?: string } }).spec?.scope).toBe('Namespaced');
		});
	}

	it('the directory holds exactly the five generated manifests and nothing else', () => {
		const onDisk = readdirSync(COMMITTED_DIRECTORY)
			.filter((name) => name.endsWith('.yaml'))
			.sort();
		expect(onDisk).toEqual(MANIFESTS.map((file) => file.fileName).sort());
	});
});

/* ------------------------------------------------------------------------- *
 * 2. The CRD envelope and the structural-schema rules
 * ------------------------------------------------------------------------- */

describe('the generated CRDs are the objects plan §3:216–221 describes', () => {
	for (const file of MANIFESTS) {
		it(`${file.kind} is a namespaced ${APPS_TIER_API_VERSION} CRD with a status subresource`, () => {
			expect(file.manifest.apiVersion).toBe('apiextensions.k8s.io/v1');
			expect(file.manifest.kind).toBe('CustomResourceDefinition');
			expect(file.manifest.metadata.name).toBe(`${file.manifest.spec.names.plural}.${APPS_TIER_API_GROUP}`);
			expect(file.manifest.spec.group).toBe(APPS_TIER_API_GROUP);
			expect(file.manifest.spec.scope).toBe('Namespaced');
			expect(file.manifest.spec.versions).toHaveLength(1);
			const version = file.manifest.spec.versions[0];
			expect(version.name).toBe(APPS_TIER_API_VERSION);
			expect(version.served).toBe(true);
			expect(version.storage).toBe(true);
			expect(version.subresources.status).toEqual({});
			expect(version.schema.openAPIV3Schema.required).toEqual(['spec']);
		});
	}

	it('no schema uses a construct a structural schema forbids', () => {
		// The apiserver rejects these in a CRD's main schema (the generic value-validation
		// constructs are only legal nested inside x-kubernetes-validations), and no cluster is
		// needed to keep them out of a generated document.
		const forbidden = [
			'allOf',
			'anyOf',
			'oneOf',
			'not',
			'if',
			'then',
			'else',
			'patternProperties',
			'dependencies',
			'additionalItems',
			'contains',
			'$ref'
		];
		const offenders: string[] = [];
		const walk = (schema: unknown, path: string): void => {
			if (schema === null || typeof schema !== 'object') return;
			for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
				// `properties` is a map of *names* to schemas: a field called `dependencies` is a
				// field, not the forbidden keyword of the same name.
				if (key === 'properties') {
					for (const [name, subschema] of Object.entries(value as Record<string, unknown>)) {
						walk(subschema, `${path}/${name}`);
					}
					continue;
				}
				if (forbidden.includes(key)) offenders.push(`${path}/${key}`);
				if (key === 'additionalProperties' && value === true)
					offenders.push(`${path}/additionalProperties: true`);
				if (key === 'x-kubernetes-preserve-unknown-fields') offenders.push(`${path}/${key}`);
				walk(value, `${path}/${key}`);
			}
		};
		for (const file of MANIFESTS) walk(openApiSchema(file), file.kind);
		expect(offenders).toEqual([]);
	});

	it('no root schema carries additionalProperties (the apiserver forbids it at the root)', () => {
		for (const file of MANIFESTS) {
			expect(openApiSchema(file).additionalProperties).toBeUndefined();
			expect(openApiSchema(file).properties?.spec.additionalProperties).toBe(false);
			expect(openApiSchema(file).properties?.status.additionalProperties).toBe(false);
		}
	});

	it('the Work status carries the removal and dependency records the task names', () => {
		const status = openApiSchema(WORK as CrdManifestFile).properties?.status;
		expect(Object.keys(status?.properties ?? {})).toContain('removal');
		expect(Object.keys(status?.properties ?? {})).toContain('dependencies');
		expect(Object.keys(status?.properties?.removal.properties ?? {})).toEqual([
			'removedAt',
			'retainedUntil',
			'dataDeletedAt'
		]);
		expect(status?.properties?.dependencies.items?.properties?.phase.enum).toEqual([
			'pending',
			'ready',
			'failed',
			'released'
		]);
	});

	it('the Work spec carries dataDeletion and the removed desired state the task names', () => {
		const spec = openApiSchema(WORK as CrdManifestFile).properties?.spec;
		expect(Object.keys(spec?.properties ?? {})).toContain('dataDeletion');
		expect(spec?.properties?.desiredState.enum).toEqual(['running', 'paused', 'quarantined', 'removed']);
	});

	it('SelfCheck asks for closed launch-gate item ids', () => {
		const items = openApiSchema(SELF_CHECK as CrdManifestFile).properties?.spec.properties?.items;
		expect(items?.items?.enum).toEqual([...LAUNCH_GATE_ITEM_IDS]);
		expect(items?.maxItems).toBe(LAUNCH_GATE_ITEM_IDS.length);
	});
});

/* ------------------------------------------------------------------------- *
 * 3. FR-26 bounds: the CRD holds the contract's numbers, at N and N+1
 * ------------------------------------------------------------------------- */

describe('the Work schema pins the FR-26 bounds to the contract’s own constants (ACC-10-27)', () => {
	it('carries the contract’s numbers, not copies of them', () => {
		const spec = openApiSchema(WORK as CrdManifestFile).properties?.spec;
		expect(spec?.properties?.components.maxItems).toBe(APPS_TIER_MAX_COMPONENTS);
		expect(spec?.properties?.jobs.maxItems).toBe(APPS_TIER_MAX_JOBS);
		expect(spec?.properties?.cron.maxItems).toBe(APPS_TIER_MAX_CRON);
		expect(spec?.properties?.smoke.maxItems).toBe(APPS_TIER_MAX_SMOKE);
		expect(spec?.properties?.hosts.maxItems).toBe(APPS_TIER_MAX_HOSTS);
		expect(spec?.properties?.images.maxItems).toBe(APPS_TIER_MAX_IMAGES);
		expect(spec?.properties?.env.properties?.names.maxItems).toBe(APPS_TIER_MAX_ENV_NAMES);
		expect(spec?.properties?.components.items?.properties?.volumes.maxItems).toBe(APPS_TIER_MAX_COMPONENT_VOLUMES);
		expect(spec?.properties?.components.items?.properties?.replicas.maximum).toBe(APPS_TIER_MAX_COMPONENT_REPLICAS);
		expect(spec?.properties?.jobs.items?.properties?.timeoutSeconds.maximum).toBe(
			APPS_TIER_MAX_JOB_TIMEOUT_SECONDS
		);
	});

	for (const bound of FR26_BOUNDS) {
		it(`accepts ${bound.limit} ${bound.name} and refuses ${bound.limit + 1}`, () => {
			expectAccepted(workValidator, bound.withCount(bound.limit));
			expect(refusedAt(workValidator, bound.withCount(bound.limit + 1), bound.keyword, bound.pointer)).toBe(true);
		});
	}

	it('refuses a sealed environment one base64 character over 256 KiB, and accepts one at the ceiling', () => {
		const atCeiling = 'A'.repeat(Math.ceil(APPS_TIER_MAX_SEALED_ENV_BYTES / 3) * 4);
		expectAccepted(
			workValidator,
			workWithSpec((spec) => {
				spec.env = { sealed: atCeiling, names: [] };
			})
		);
		expect(
			refusedAt(
				workValidator,
				workWithSpec((spec) => {
					spec.env = { sealed: `${atCeiling}A`, names: [] };
				}),
				'maxLength',
				'/spec/env/sealed'
			)
		).toBe(true);
	});
});

/* ------------------------------------------------------------------------- *
 * 4. ACC-10-26 and ACC-10-27: the three refusals, each with a positive control
 * ------------------------------------------------------------------------- */

describe('Work validation (ACC-10-26, ACC-10-27)', () => {
	it('accepts the valid Work — the positive control', () => {
		expectAccepted(workValidator, validWork());
	});

	it('accepts a paused Work with recorded replica counts, a removed Work and a quarantine', () => {
		expectAccepted(
			workValidator,
			workWithSpec((spec) => {
				spec.desiredState = 'paused';
				spec.pausedReplicas = { web: 2, worker: 1 };
			})
		);
		expectAccepted(
			workValidator,
			workWithSpec((spec) => {
				spec.desiredState = 'removed';
				spec.dataDeletion = { requestedAt: '2026-09-17T12:00:00.000Z', requestedByUserId: OWNER_ID };
			})
		);
		expectAccepted(
			workValidator,
			workWithSpec((spec) => {
				spec.desiredState = 'quarantined';
				spec.quarantine = {
					requestId: '99999999-9999-4999-8999-999999999999',
					category: 'abuse',
					requestedAt: '2026-09-17T12:00:00.000Z'
				};
			})
		);
	});

	it('accepts a status carrying removal and dependency records (the controller’s half of ACC-10-26)', () => {
		const work = validWork();
		work.status = {
			phase: 'Ready',
			observedGeneration: 1,
			namespace: `ewa-${WORK_ID.replace(/-/g, '').slice(0, 20)}`,
			// `removal` is an object whose three members are null until removal happens — the
			// contract declares it non-nullable (`AppsTierWorkStatus.removal`).
			removal: { removedAt: null, retainedUntil: null, dataDeletedAt: null },
			dependencies: [
				{ kind: 'postgres', ref: 'dep-postgres', phase: 'ready', lastBackupAt: null, detail: { host: 'db' } }
			]
		};
		expectAccepted(workValidator, work);
	});

	it('refuses a desired state that names a namespace (ACC-10-26)', () => {
		const work = workWithSpecField('namespace', 'ever-works-apps-control');
		const refusals = refusalsOf(workValidator, work);
		expect(refusals.join('\n')).toContain('/spec (unknown field)');
		expect(
			(workValidator.errors ?? []).some(
				(error) =>
					error.keyword === 'additionalProperties' &&
					error.instancePath === '/spec' &&
					error.params.additionalProperty === 'namespace'
			)
		).toBe(true);
		// The control: the same object without the field is accepted.
		expectAccepted(workValidator, validWork());
	});

	it('refuses any other unknown field under spec, and one under status', () => {
		expect(refusedAt(workValidator, workWithSpecField('nodeSelector', {}), 'additionalProperties', '/spec')).toBe(
			true
		);
		const withStatus = validWork();
		withStatus.status = { phase: 'Ready', unknownField: true };
		expect(refusedAt(workValidator, withStatus, 'additionalProperties', '/status')).toBe(true);
	});

	it('refuses an image that is not digest-pinned (ACC-10-27)', () => {
		const refusals = refusalsOf(
			workValidator,
			workWithSpec((spec) => {
				spec.images = [{ component: 'web', source: 'ghcr.io/example-owner/example/app:latest' }];
			})
		);
		expect(refusals.join('\n')).toContain('/spec/images/0/source');
		expect(
			refusedAt(
				workValidator,
				workWithSpec((spec) => {
					spec.images = [{ component: 'web', source: 'ghcr.io/example-owner/example/app:latest' }];
				}),
				'pattern',
				'/spec/images/0/source'
			)
		).toBe(true);
		// The controls: a pinned digest passes, a truncated digest does not.
		expectAccepted(
			workValidator,
			workWithSpec((spec) => {
				spec.images = [{ component: 'web', source: DIGEST_IMAGE }];
			})
		);
		expect(
			refusedAt(
				workValidator,
				workWithSpec((spec) => {
					spec.images = [
						{ component: 'web', source: `ghcr.io/example-owner/example/app@sha256:${'a'.repeat(63)}` }
					];
				}),
				'pattern',
				'/spec/images/0/source'
			)
		).toBe(true);
	});
});

/* ------------------------------------------------------------------------- *
 * 5. The 512 KiB rule (plan §3.1:272; APW10-G21)
 * ------------------------------------------------------------------------- */

describe('the whole-object 512 KiB rule (ACC-10-27, plan §3.1:272)', () => {
	it('is the contract’s 512 KiB', () => {
		expect(WORK_OBJECT_LIMIT_BYTES).toBe(524_288);
	});

	it('accepts an object of exactly 512 KiB and refuses 512 KiB + 1 byte', () => {
		const base = validWork();
		const paddingFor = (targetBytes: number): string => {
			// `spec.env.sealed` is a plain string, so the serialised size grows one byte per
			// character: measure once, then pad to the target exactly.
			const withoutPadding = workWithSpec((spec) => {
				spec.env = { sealed: 'A', names: [] };
			});
			const deficit = targetBytes - workObjectBytes(withoutPadding);
			return 'A'.repeat(1 + deficit);
		};

		const atLimit = workWithSpec((spec) => {
			spec.env = { sealed: paddingFor(WORK_OBJECT_LIMIT_BYTES), names: [] };
		});
		expect(workObjectBytes(atLimit)).toBe(WORK_OBJECT_LIMIT_BYTES);
		expect(exceedsWorkObjectLimit(atLimit)).toBe(false);

		const overLimit = workWithSpec((spec) => {
			spec.env = { sealed: `${paddingFor(WORK_OBJECT_LIMIT_BYTES)}A`, names: [] };
		});
		expect(workObjectBytes(overLimit)).toBe(WORK_OBJECT_LIMIT_BYTES + 1);
		expect(exceedsWorkObjectLimit(overLimit)).toBe(true);

		// The same object is also refused by the schema's own per-field bound, which is where
		// APW10-G21 moved the size claim: the CRD cannot measure the object, but it can and does
		// refuse a field that carries it.
		expect(refusedAt(workValidator, overLimit, 'maxLength', '/spec/env/sealed')).toBe(true);
		expect(base).toBeDefined();
	});

	it('measures the object, not the envelope: a small Work is far below the ceiling', () => {
		expect(workObjectBytes(validWork())).toBeLessThan(WORK_OBJECT_LIMIT_BYTES);
		expect(exceedsWorkObjectLimit(validWork())).toBe(false);
	});
});
