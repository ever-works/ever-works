import { describe, expect, it } from 'vitest';
import type { FleetJobView } from '@ever-works/contracts';
import {
	AcceptanceChecksPayloadError,
	buildNodeCheckEnv,
	normalizeChecks,
	runAcceptanceChecksJob
} from './acceptance-checks';

/**
 * The v1 node executor.
 *
 * Two properties matter most, and neither is about happy-path plumbing:
 *
 *   1. The node's verdict rules MATCH the platform's gate runner. A node
 *      that scored checks differently would be worse than a node that
 *      ran nothing at all.
 *   2. A check subprocess sees a SCRUBBED environment. A fleet node is
 *      somebody's actual laptop, and the command it is asked to run is
 *      user-authored input.
 */

function job(payload: unknown): FleetJobView {
	return {
		id: 'job-1',
		kind: 'acceptance-checks',
		status: 'leased',
		nodeId: 'node-1',
		requiredCapabilities: [],
		payload: payload as Record<string, unknown>,
		leaseExpiresAt: null,
		attempts: 1,
		maxAttempts: 3,
		createdAt: null,
		startedAt: null,
		completedAt: null
	};
}

const ABSOLUTE = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';

describe('runAcceptanceChecksJob — payload refusal', () => {
	const alwaysExists = { directoryExists: () => true };

	it('refuses a job with no payload', async () => {
		await expect(runAcceptanceChecksJob(job(null), alwaysExists)).rejects.toBeInstanceOf(
			AcceptanceChecksPayloadError
		);
	});

	it('refuses a job with no workspacePath', async () => {
		await expect(runAcceptanceChecksJob(job({ checks: [] }), alwaysExists)).rejects.toThrowError(/workspacePath/);
	});

	it('refuses a RELATIVE workspace — running in the wrong directory is worse than failing', async () => {
		await expect(
			runAcceptanceChecksJob(job({ workspacePath: 'relative/dir', checks: [] }), alwaysExists)
		).rejects.toThrowError(/absolute path/);
	});

	it('refuses a workspace that does not exist on this node', async () => {
		await expect(
			runAcceptanceChecksJob(job({ workspacePath: ABSOLUTE, checks: [] }), {
				directoryExists: () => false
			})
		).rejects.toThrowError(/does not exist on this node/);
	});

	it('reports gate `none` for a job with zero checks — not a pass, not a failure', async () => {
		await expect(
			runAcceptanceChecksJob(job({ workspacePath: ABSOLUTE, checks: [] }), alwaysExists)
		).resolves.toEqual({ gateStatus: 'none', results: [] });
	});
});

describe('normalizeChecks — a malformed check is refused, never skipped', () => {
	it('refuses a non-array', () => {
		expect(() => normalizeChecks('nope')).toThrowError(/must be an array/);
	});

	it('refuses a check with no id', () => {
		expect(() => normalizeChecks([{ command: 'pnpm build' }])).toThrowError(/has no id/);
	});

	it('refuses a check with no command — silently dropping it would turn red green', () => {
		expect(() => normalizeChecks([{ id: 'build' }])).toThrowError(/has no command/);
	});

	it('refuses a job carrying more checks than the ceiling', () => {
		const many = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, command: 'true' }));
		expect(() => normalizeChecks(many)).toThrowError(/ceiling/);
	});

	it('keeps the declared order and the optional fields', () => {
		const parsed = normalizeChecks([
			{ id: 'lint', command: 'pnpm lint', required: false, cwd: 'apps/web', timeoutSec: 30 },
			{ id: 'build', command: 'pnpm build' }
		]);
		expect(parsed.map((c) => c.id)).toEqual(['lint', 'build']);
		expect(parsed[0]).toMatchObject({ required: false, cwd: 'apps/web', timeoutSec: 30 });
	});
});

describe('runAcceptanceChecksJob — verdict rules mirror the platform gate runner', () => {
	const alwaysExists = { directoryExists: () => true };

	/**
	 * Minimal spawn double: emits a close with the scripted exit code.
	 * NOTE the `in` check rather than `??` — a scripted `null` means "died
	 * by signal", which is precisely one of the cases under test and must
	 * not be coalesced to 0.
	 */
	function fakeSpawn(exitCodeByCommand: Record<string, number | null>) {
		return ((command: string) => {
			const handlers = new Map<string, (arg?: unknown) => void>();
			queueMicrotask(() => {
				handlers.get('close')?.(command in exitCodeByCommand ? exitCodeByCommand[command] : 0);
			});
			return {
				stdout: { on: () => undefined, destroy: () => undefined },
				stderr: { on: () => undefined, destroy: () => undefined },
				on: (event: string, handler: (arg?: unknown) => void) => {
					handlers.set(event, handler);
				},
				kill: () => undefined
			};
		}) as never;
	}

	it('exit 0 is green, nonzero is red', async () => {
		const outcome = await runAcceptanceChecksJob(
			job({
				workspacePath: ABSOLUTE,
				checks: [
					{ id: 'ok', command: 'passing', required: true },
					{ id: 'bad', command: 'failing', required: true }
				]
			}),
			{ ...alwaysExists, spawnFn: fakeSpawn({ passing: 0, failing: 1 }) }
		);

		expect(outcome.results.map((r) => r.status)).toEqual(['green', 'red']);
		expect(outcome.results[1].exitCode).toBe(1);
		expect(outcome.gateStatus).toBe('red');
	});

	it('a NON-required check can never turn the gate red', async () => {
		const outcome = await runAcceptanceChecksJob(
			job({
				workspacePath: ABSOLUTE,
				checks: [
					{ id: 'ok', command: 'passing', required: true },
					{ id: 'advisory', command: 'failing', required: false }
				]
			}),
			{ ...alwaysExists, spawnFn: fakeSpawn({ passing: 0, failing: 1 }) }
		);

		expect(outcome.results[1].status).toBe('red');
		expect(outcome.gateStatus).toBe('green');
	});

	it('treats an absent `required` as required, matching the platform default', async () => {
		const outcome = await runAcceptanceChecksJob(
			job({ workspacePath: ABSOLUTE, checks: [{ id: 'bad', command: 'failing' }] }),
			{ ...alwaysExists, spawnFn: fakeSpawn({ failing: 2 }) }
		);
		expect(outcome.gateStatus).toBe('red');
	});

	it('reports an unspawnable check as `error`, distinguishable from a code failure', async () => {
		const throwingSpawn = (() => {
			throw new Error('spawn ENOENT');
		}) as never;
		const outcome = await runAcceptanceChecksJob(
			job({ workspacePath: ABSOLUTE, checks: [{ id: 'broken', command: 'nope' }] }),
			{ ...alwaysExists, spawnFn: throwingSpawn }
		);
		expect(outcome.results[0].status).toBe('error');
		expect(outcome.results[0].exitCode).toBeNull();
		expect(outcome.gateStatus).toBe('red');
	});

	it('treats death by external signal (null exit code) as red, not a pass', async () => {
		const outcome = await runAcceptanceChecksJob(
			job({ workspacePath: ABSOLUTE, checks: [{ id: 'killed', command: 'signalled' }] }),
			{ ...alwaysExists, spawnFn: fakeSpawn({ signalled: null }) }
		);
		expect(outcome.results[0].status).toBe('red');
	});
});

describe('buildNodeCheckEnv — a check never inherits this machine', () => {
	const parent: NodeJS.ProcessEnv = {
		PATH: '/usr/bin',
		HOME: '/home/runner',
		LANG: 'en_US.UTF-8',
		LC_ALL: 'en_US.UTF-8',
		AWS_SECRET_ACCESS_KEY: 'super-secret',
		FLEET_NODE_SECRET: 'the-node-credential',
		DATABASE_URL: 'postgres://user:pw@host/db',
		MY_API_TOKEN: 'tok',
		HTTPS_PROXY: 'http://proxy:8080',
		CUSTOM_BUILD_FLAG: 'yes'
	};

	it('passes the allowlisted plumbing through', () => {
		const env = buildNodeCheckEnv(undefined, parent);
		expect(env.PATH).toBe('/usr/bin');
		expect(env.HOME).toBe('/home/runner');
		expect(env.LANG).toBe('en_US.UTF-8');
		expect(env.LC_ALL).toBe('en_US.UTF-8');
		expect(env.HTTPS_PROXY).toBe('http://proxy:8080');
	});

	it('drops secret-shaped names that were never granted', () => {
		const env = buildNodeCheckEnv(undefined, parent);
		expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect(env.MY_API_TOKEN).toBeUndefined();
		expect(env.DATABASE_URL).toBeUndefined();
	});

	it("never leaks the NODE'S OWN credential namespace to a check", () => {
		// The escape hatch must not be able to re-open the hole it exists
		// beside: a check must never read the secret that lets this machine
		// lease work in the first place.
		const env = buildNodeCheckEnv(['FLEET_NODE_SECRET', 'DATABASE_URL'], parent);
		expect(env.FLEET_NODE_SECRET).toBeUndefined();
		expect(env.DATABASE_URL).toBeUndefined();
	});

	it('honours an explicit, non-platform-owned passthrough grant', () => {
		const env = buildNodeCheckEnv(['CUSTOM_BUILD_FLAG'], parent);
		expect(env.CUSTOM_BUILD_FLAG).toBe('yes');
	});

	it('never returns anything the parent did not explicitly earn', () => {
		const env = buildNodeCheckEnv(undefined, { ...parent, RANDOM_THING: 'leaked' });
		expect(env.RANDOM_THING).toBeUndefined();
	});

	it('injects CI=1 so watch modes do not hang a check to its timeout', () => {
		expect(buildNodeCheckEnv(undefined, parent).CI).toBe('1');
	});
});
