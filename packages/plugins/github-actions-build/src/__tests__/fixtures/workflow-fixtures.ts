import type { AppBuildBlock, BuildValue } from '@ever-works/plugin';

import type { WorkflowGeneratorInput } from '../../workflow/generator.js';

/**
 * APW-05 T8 — the ten fixtures the generator's goldens are recorded from.
 *
 * One module, shared by `generator.spec.ts` and by the golden recorder inside it
 * (`EW_UPDATE_GOLDEN=1`), so a fixture can never drift between the bytes a golden
 * holds and the inputs the assertions describe.
 *
 * Every fixture names its secret **values** deliberately: they are the strings the
 * spec searches the generated file for, and finding one would be the leak ACC-05-05
 * exists to catch. They are shaped like real credentials and are not real ones.
 */

/** A value that must never appear in a generated file. */
export const SECRET_VALUE = 'https://ever-works:hunter2-do-not-print@sentry.invalid/42';

/** A build-service-derived value: throwaway by construction, and still never in the file (plan §4.11). */
export const SERVICE_VALUE = 'postgresql://ever-works-build:ever-works-build@127.0.0.1:5432/app';

/** The App spec hash the label carries — 64 hex, as FR-23 produces. */
export const APP_SPEC_HASH = '7f3c1d9e5b2a4806c1d7e9f0a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8';

/** The public repository most fixtures build. */
export const PUBLIC_REPOSITORY = { owner: 'ever-works', repo: 'fixture-app', visibility: 'public' } as const;

/** The standard public runner (plan §3.2 `APP_BUILD_RUNNERS.githubPublic`). */
export const PUBLIC_RUNNER = { label: 'ubuntu-latest', class: 'github-public' } as const;

/** `build.resources` with the plan's exact timeout, which the `build` job must carry unchanged (FR-24). */
export const BUILD_RESOURCES = { cpu: 2, memoryGiB: 6, timeoutMinutes: 30 } as const;

/** A minimal dockerfile build block. */
export function minimalBuild(overrides: Partial<AppBuildBlock> = {}): AppBuildBlock {
	return {
		strategy: 'dockerfile',
		args: [],
		services: [],
		resources: { ...BUILD_RESOURCES },
		...overrides
	};
}

/** A secret build value (a `fromEnv` argument's source), never a build-service one. */
export function secretValue(name: string, value: string, fingerprint = 'v3'): BuildValue {
	return { name, value, secret: true, fromBuildService: false, fingerprint };
}

/** A build-service-derived value — throwaway, excluded from `EW_SECRET_NAMES` (plan §4.11). */
export function serviceValue(name: string, value: string): BuildValue {
	return { name, value, secret: true, fromBuildService: true, fingerprint: 'sha256:throwaway' };
}

/** The six full files T8 records a golden for, keyed by golden name. */
export function goldenFixtures(): Record<string, WorkflowGeneratorInput> {
	return {
		/** Nothing but a tracked branch and a Dockerfile. */
		minimal: {
			trackedBranch: 'main',
			repository: PUBLIC_REPOSITORY,
			appSpecHash: APP_SPEC_HASH,
			build: minimalBuild(),
			values: [],
			runner: PUBLIC_RUNNER,
			settings: {},
			verifyEnabled: true
		},

		/** Both kinds of build argument: an App-spec literal, and a stored value behind `fromEnv`. */
		args: {
			trackedBranch: 'main',
			repository: PUBLIC_REPOSITORY,
			appSpecHash: APP_SPEC_HASH,
			build: minimalBuild({
				args: [
					{ name: 'NODE_ENV', value: 'production' },
					{ name: 'SENTRY_DSN', fromEnv: 'SENTRY_DSN' },
					{ name: 'DATABASE_URL', fromEnv: 'DATABASE_URL' }
				]
			}),
			values: [secretValue('SENTRY_DSN', SECRET_VALUE), serviceValue('DATABASE_URL', SERVICE_VALUE)],
			runner: PUBLIC_RUNNER,
			settings: {},
			verifyEnabled: true
		},

		/** Two build services, one of them with a declared env entry that overrides a single default. */
		services: {
			trackedBranch: 'main',
			repository: PUBLIC_REPOSITORY,
			appSpecHash: APP_SPEC_HASH,
			build: minimalBuild({
				args: [
					{ name: 'DATABASE_URL', fromEnv: 'DATABASE_URL' },
					{ name: 'PGHOST', value: '127.0.0.1' }
				],
				services: [
					{ name: 'postgres', image: 'postgres:16', env: [{ name: 'POSTGRES_DB', value: 'fixture' }] },
					{ name: 'redis', image: 'redis:7' }
				]
			}),
			values: [serviceValue('DATABASE_URL', SERVICE_VALUE)],
			runner: PUBLIC_RUNNER,
			settings: {},
			verifyEnabled: true
		},

		/** A private repository on the larger runner its owner configured. */
		'private-larger-runner': {
			trackedBranch: 'main',
			repository: { owner: 'ever-works', repo: 'private-app', visibility: 'private' },
			appSpecHash: APP_SPEC_HASH,
			build: minimalBuild(),
			values: [],
			runner: { label: 'ubuntu-latest-8-cores', class: 'github-larger' },
			settings: {},
			verifyEnabled: true
		},

		/** Attestations on, on a public repository — the only case that gets the two extra permissions. */
		attestations: {
			trackedBranch: 'main',
			repository: PUBLIC_REPOSITORY,
			appSpecHash: APP_SPEC_HASH,
			build: minimalBuild(),
			values: [],
			runner: PUBLIC_RUNNER,
			settings: { attestations: true },
			verifyEnabled: true
		},

		/** A tracked branch whose name needs a slug: `feature/x` → `feature-x` (plan §4.5). */
		'branch-slug': {
			trackedBranch: 'feature/x',
			repository: PUBLIC_REPOSITORY,
			appSpecHash: APP_SPEC_HASH,
			build: minimalBuild(),
			values: [],
			runner: PUBLIC_RUNNER,
			settings: {},
			verifyEnabled: true
		}
	};
}

/** The bootstrap file of plan §4.6 step 0 — dispatch-only, no build block, no build job. */
export function bootstrapFixture(): WorkflowGeneratorInput {
	return {
		trackedBranch: 'main',
		repository: PUBLIC_REPOSITORY,
		appSpecHash: APP_SPEC_HASH,
		build: null,
		values: [],
		runner: PUBLIC_RUNNER,
		settings: {},
		verifyEnabled: true,
		bootstrap: true
	};
}

/** A postgres service that declares no env at all — the `BUILD_SERVICE_DEFAULTS` case (`APW05-G08`). */
export function postgresDefaultsFixture(): WorkflowGeneratorInput {
	return {
		trackedBranch: 'main',
		repository: PUBLIC_REPOSITORY,
		appSpecHash: APP_SPEC_HASH,
		build: minimalBuild({ services: [{ name: 'postgres', image: 'postgres:16', env: [] }] }),
		values: [],
		runner: PUBLIC_RUNNER,
		settings: {},
		verifyEnabled: true
	};
}

/** The `args` fixture with the XC-01 opt-out flipped on — the owner's own choice, recorded in its own file. */
export function unrestrictedValuesFixture(): WorkflowGeneratorInput {
	const args = goldenFixtures().args;
	return {
		...args,
		settings: { allowBuildValuesOnPullRequests: true }
	};
}

/** Every secret string the fixtures hand the generator — what no generated file may contain (§4.7, ACC-05-05). */
export const FORBIDDEN_VALUE_STRINGS = [SECRET_VALUE, SERVICE_VALUE] as const;
