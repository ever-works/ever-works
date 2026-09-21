import { APP_BUILD_RUNNERS, APP_BUILD_RUNNER_HEADROOM_GIB } from '@ever-works/contracts';
import { describe, expect, it } from 'vitest';

import { RUNNER_TOO_SMALL, selectRunner } from '../runner/runner-selector.js';

/**
 * APW-05 T11 — the runner selector.
 *
 * The numbers below are the TASK's numbers (14 GiB public allowed, 15 blocked,
 * 5 GiB private allowed, 6 blocked, ACC-05-22's `{ needed: 12, max: 5 }`),
 * written as literals rather than derived from `APP_BUILD_RUNNERS`. A case that
 * computes its expectation from the same constant the implementation reads
 * follows a mutation instead of catching it — the trap `test-connection.spec.ts`
 * in the oidc package records, and the reason the constants are cross-checked
 * separately at the end of this file.
 */

const publicRepo = { visibility: 'public' } as const;
const privateRepo = { visibility: 'private' } as const;

describe('runner selection by visibility (plan §7.2 step 4)', () => {
	it('places a public repository on the standard hosted runner', () => {
		const selection = selectRunner({ ...publicRepo });

		expect(selection.ok).toBe(true);
		if (!selection.ok) return;
		expect(selection.runner.runnerClass).toBe('github-public');
		expect(selection.runner.label).toBe('ubuntu-latest');
	});

	it('places a private repository on the private runner when no larger one is configured', () => {
		const selection = selectRunner({ ...privateRepo });

		expect(selection.ok).toBe(true);
		if (!selection.ok) return;
		expect(selection.runner.runnerClass).toBe('github-private');
	});

	it('prefers a configured larger runner for a private repository', () => {
		const selection = selectRunner({
			...privateRepo,
			settings: { largerRunnerLabel: 'ubuntu-32gb', largerRunnerMemoryGiB: 32, largerRunnerVcpu: 8 }
		});

		expect(selection.ok).toBe(true);
		if (!selection.ok) return;
		expect(selection.runner).toMatchObject({
			label: 'ubuntu-32gb',
			runnerClass: 'github-larger',
			memoryGiB: 32
		});
	});

	it('ignores a larger runner for a PUBLIC repository — the standard runner is already bigger', () => {
		const selection = selectRunner({
			...publicRepo,
			settings: { largerRunnerLabel: 'ubuntu-32gb', largerRunnerMemoryGiB: 32 }
		});

		expect(selection.ok).toBe(true);
		if (!selection.ok) return;
		expect(selection.runner.runnerClass).toBe('github-public');
	});

	it('refuses a larger-runner label with no memory — a runner of unknown capacity is not a runner', () => {
		// The settings schema already requires `largerRunnerMemoryGiB` when a
		// label is set; this is the runtime half. Accepting the label would mean
		// comparing a declared memory against `NaN`, which fits everything.
		const selection = selectRunner({
			...privateRepo,
			settings: { largerRunnerLabel: 'ubuntu-mystery' } as never
		});

		expect(selection.ok).toBe(true);
		if (!selection.ok) return;
		expect(selection.runner.runnerClass).toBe('github-private');
	});
});

describe('the memory fit — the one thing that blocks a Build', () => {
	it('allows 14 GiB on the public runner', () => {
		expect(selectRunner({ ...publicRepo, resources: { memoryGiB: 14 } }).ok).toBe(true);
	});

	it('blocks 15 GiB on the public runner', () => {
		const selection = selectRunner({ ...publicRepo, resources: { memoryGiB: 15 } });

		expect(selection.ok).toBe(false);
		if (selection.ok) return;
		expect(selection.blocked).toEqual({ reason: RUNNER_TOO_SMALL, needed: 15, max: 14 });
	});

	it('allows 5 GiB on the private runner', () => {
		expect(selectRunner({ ...privateRepo, resources: { memoryGiB: 5 } }).ok).toBe(true);
	});

	it('blocks 6 GiB on the private runner', () => {
		expect(selectRunner({ ...privateRepo, resources: { memoryGiB: 6 } }).ok).toBe(false);
	});

	it('ACC-05-22: 12 GiB private with no larger runner blocks with { needed: 12, max: 5 }', () => {
		const selection = selectRunner({ ...privateRepo, resources: { memoryGiB: 12 } });

		expect(selection.ok).toBe(false);
		if (selection.ok) return;
		// The two numbers the member needs. A bare "it did not fit" is what this
		// refusal exists instead of.
		expect(selection.blocked).toEqual({ reason: RUNNER_TOO_SMALL, needed: 12, max: 5 });
	});

	it('allows 12 GiB private once a 32 GiB larger runner is configured', () => {
		const selection = selectRunner({
			...privateRepo,
			resources: { memoryGiB: 12 },
			settings: { largerRunnerLabel: 'ubuntu-32gb', largerRunnerMemoryGiB: 32 }
		});

		expect(selection.ok).toBe(true);
		if (!selection.ok) return;
		expect(selection.runner.usableMemoryGiB).toBe(30);
	});

	it('fits exactly at the limit — the comparison is inclusive', () => {
		expect(selectRunner({ ...publicRepo, resources: { memoryGiB: 14 } }).ok).toBe(true);
		expect(selectRunner({ ...privateRepo, resources: { memoryGiB: 5 } }).ok).toBe(true);
	});

	it('APW05-G14 / FR-23: an ABSENT memory declaration never blocks', () => {
		// "No `build.resources.memory`" means the runner's own maximum. It is the
		// common case — most App specs declare no resources at all — so treating
		// it as a miss would refuse every Build nobody tuned.
		for (const resources of [undefined, {}, { memoryGiB: null }, { memoryGiB: 0 }]) {
			expect(selectRunner({ ...privateRepo, resources: resources as never }).ok).toBe(true);
		}
	});
});

describe('CPU is a warning, never a block', () => {
	it('reports an over-declared vCPU and still runs', () => {
		// There is no "slower" for memory, only a kill; for CPU there is, so the
		// Build proceeds and the member is told why it takes eleven minutes.
		const selection = selectRunner({ ...privateRepo, resources: { vcpu: 8 } });

		expect(selection.ok).toBe(true);
		if (!selection.ok) return;
		expect(selection.runner.cpuOverDeclared).toEqual({ needed: 8, max: 2 });
	});

	it('reports nothing when the vCPU fits', () => {
		const selection = selectRunner({ ...publicRepo, resources: { vcpu: 4 } });

		expect(selection.ok).toBe(true);
		if (!selection.ok) return;
		expect(selection.runner.cpuOverDeclared).toBeUndefined();
	});
});

describe('the constants this file writes as literals', () => {
	it('matches the runner table the implementation reads', () => {
		// Cross-checked HERE rather than in every case above, so a case that
		// asserts "15 GiB is blocked" keeps catching a mutation of the table
		// instead of following it.
		expect(APP_BUILD_RUNNERS.githubPublic).toMatchObject({ vcpu: 4, memoryGiB: 16 });
		expect(APP_BUILD_RUNNERS.githubPrivate).toMatchObject({ vcpu: 2, memoryGiB: 7 });
		expect(APP_BUILD_RUNNER_HEADROOM_GIB).toBe(2);
		// 16 − 2 = 14 and 7 − 2 = 5, which are the two ceilings above.
		expect(APP_BUILD_RUNNERS.githubPublic.memoryGiB - APP_BUILD_RUNNER_HEADROOM_GIB).toBe(14);
		expect(APP_BUILD_RUNNERS.githubPrivate.memoryGiB - APP_BUILD_RUNNER_HEADROOM_GIB).toBe(5);
	});
});
