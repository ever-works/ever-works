import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FleetClient, FleetClientError, type FetchLike, type FetchRequestInit } from './fleet-client';
import { FleetJobClient } from './job-client';

/**
 * NODE↔PLATFORM CONFORMANCE — the CLIENT half (EW-779, finding OPS-21).
 *
 * The server half lives in
 * `apps/api/src/fleet/__tests__/node-contract.conformance.spec.ts` and asserts
 * that the platform's DTOs still accept what a deployed node sends. This half
 * asserts the other side of the same equality: that the node really does send
 * what the pinned contract says it sends, and really does read what the pinned
 * contract says it reads. Neither half is sufficient alone — a suite that only
 * checked the server would go green the day the client stopped sending a
 * field, and vice versa. (Same two-sided pattern as
 * `apps/api/src/schedules/dto/schedules-query.dto.spec.ts` and its web-side
 * counterpart.)
 *
 * The contract is read from `packages/contracts/fixtures/` with `readFileSync`
 * — never imported, never type-checked against anything under test. See that
 * file's own docblock for why a self-referential conformance suite is worth
 * nothing.
 *
 * This COMPLEMENTS `job-client.spec.ts` and `fleet-client.spec.ts` rather than
 * duplicating them: those prove behaviour (redaction, retries, malformed
 * handling); this one pins the exact wire shapes and the exact status→kind
 * table, so a change to either is a deliberate, reviewed contract edit.
 */

const repositoryRoot = join(__dirname, '../../../..');
const baseline = JSON.parse(
	readFileSync(join(repositoryRoot, 'packages/contracts/fixtures/fleet-node-contract.v1.json'), 'utf8')
) as NodeContractBaseline;

interface NodeContractBaseline {
	routes: Record<
		string,
		{
			method: string;
			path: string;
			successStatus: number;
			requests: Record<string, { expect: string; body: Record<string, unknown> }>;
			response: Record<string, unknown>;
			emptyResponse?: Record<string, unknown>;
		}
	>;
	selfDescription: { nodeEmits: string[]; nodeEmitsOptional: string[] };
	nodeStatusBranches: { fleet: Record<string, string>; job: Record<string, string> };
	killSwitch: { leaseWhenStopped: { status: number; body: Record<string, unknown> } };
}

const API_URL = 'https://api.ever.works';
const NODE_ID = '3f7f5b3a-6c1d-4a0e-9d7c-1b2e5a8f4c31';
const SECRET = 'n0d3-s3cr3t-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const TOKEN = '3nr0ll-t0k3n-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const JOB_ID = 'b1a2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

interface Sent {
	url: string;
	init: FetchRequestInit;
}

/** Record what the client puts on the wire, and reply with a scripted body. */
function recorder(status: number, body: unknown): { fetchFn: FetchLike; sent: Sent[] } {
	const sent: Sent[] = [];
	const fetchFn: FetchLike = async (url, init) => {
		sent.push({ url, init });
		return { ok: status < 400, status, text: async () => JSON.stringify(body) };
	};
	return { fetchFn, sent };
}

const bodyOf = (sent: Sent[]): Record<string, unknown> => JSON.parse(sent[0].init.body) as Record<string, unknown>;

function fleetClient(fetchFn: FetchLike): FleetClient {
	return new FleetClient({ apiUrl: API_URL, fetchFn, userAgent: 'ever-works-node/1.0.0', timeoutMs: 0 });
}

function jobClient(fetchFn: FetchLike): FleetJobClient {
	return new FleetJobClient({
		apiUrl: API_URL,
		nodeId: NODE_ID,
		secret: SECRET,
		fetchFn,
		userAgent: 'ever-works-node/1.0.0',
		timeoutMs: 0
	});
}

const request = (route: string, variant: string): Record<string, unknown> =>
	baseline.routes[route].requests[variant].body;

describe('what the node actually puts on the wire', () => {
	it('reads a contract that still pins every route and variant this file drives', () => {
		// ANTI-VACUITY. `request(route, variant)` returns `undefined` for a
		// variant that has been deleted from the fixture, and
		// `expect(body).toEqual(undefined)` is a FAILURE — so the deep-equals
		// cases below are not silently skippable. This makes that explicit and
		// pins the count, so a thinned fixture is caught here first with a
		// readable message instead of seven confusing diffs.
		expect(Object.keys(baseline.routes).sort()).toEqual([
			'enroll',
			'heartbeat',
			'jobs-complete',
			'jobs-heartbeat',
			'jobs-lease',
			'pause',
			'unenroll'
		]);
		for (const [route, variants] of Object.entries({
			enroll: ['current', 'legacy', 'minimal'],
			heartbeat: ['current', 'legacy', 'credentialOnly'],
			pause: ['current', 'resume'],
			unenroll: ['current'],
			'jobs-lease': ['current', 'legacy'],
			'jobs-heartbeat': ['current', 'legacy'],
			'jobs-complete': ['current', 'currentFailure', 'legacy']
		})) {
			expect(Object.keys(baseline.routes[route].requests).sort()).toEqual([...variants].sort());
		}
		expect(baseline.selfDescription.nodeEmits).toHaveLength(6);
		expect(baseline.selfDescription.nodeEmitsOptional).toHaveLength(2);
	});

	it('enroll sends exactly the pinned body, to the pinned path', async () => {
		const { fetchFn, sent } = recorder(201, baseline.routes.enroll.response);
		await fleetClient(fetchFn).enroll({
			token: TOKEN,
			platform: 'linux/x64',
			version: '1.0.0',
			capabilities: ['terminal', 'workspace', 'os:linux', 'arch:x64'],
			cliVersion: '1.4.2',
			diskFreeBytes: 128849018880,
			modelIdentity: 'claude-code: ops@example.com (Acme, max)'
		});

		expect(bodyOf(sent)).toEqual(request('enroll', 'current'));
		expect(sent[0].url).toBe(`${API_URL}${baseline.routes.enroll.path}`);
		expect(sent[0].init.method).toBe(baseline.routes.enroll.method);
	});

	it('enroll omits every self-description field the machine could not measure', async () => {
		// `undefined` is ABSENT on the wire, never `null`: the platform reads an
		// absent telemetry field as "leave the stored reading alone", so a
		// transient probe failure must not wipe a good value.
		const { fetchFn, sent } = recorder(201, baseline.routes.enroll.response);
		await fleetClient(fetchFn).enroll({ token: TOKEN });
		expect(bodyOf(sent)).toEqual(request('enroll', 'minimal'));
	});

	it('heartbeat sends exactly the pinned body', async () => {
		const { fetchFn, sent } = recorder(200, baseline.routes.heartbeat.response);
		await fleetClient(fetchFn).heartbeat({
			nodeId: NODE_ID,
			secret: SECRET,
			platform: 'linux/x64',
			version: '1.0.0',
			capabilities: ['terminal', 'workspace'],
			cliVersion: '1.4.2',
			diskFreeBytes: 128849018880,
			modelIdentity: 'claude-code: ops@example.com (Acme, max)'
		});
		expect(bodyOf(sent)).toEqual(request('heartbeat', 'current'));
		expect(sent[0].url).toBe(`${API_URL}${baseline.routes.heartbeat.path}`);
	});

	it('the self-description projection emits exactly the pinned key set', async () => {
		// The node-side half of the three-way equality the server spec asserts.
		// A field added to the DTO but not to `selfDescription()` is a field
		// the machine computes, logs, and then silently never sends.
		const { fetchFn, sent } = recorder(200, baseline.routes.heartbeat.response);
		await fleetClient(fetchFn).heartbeat({
			nodeId: NODE_ID,
			secret: SECRET,
			platform: 'linux/x64',
			version: '1.0.0',
			capabilities: [],
			cliVersion: '1.4.2',
			diskFreeBytes: 1,
			modelIdentity: 'x'
		});
		const emitted = Object.keys(bodyOf(sent)).filter((key) => key !== 'nodeId' && key !== 'secret');
		expect(emitted.sort()).toEqual([...baseline.selfDescription.nodeEmits].sort());
	});

	it('adds the optional health fields only when the node has a worker state', async () => {
		// Slice T's two fields are CONDITIONAL, and that is the compatibility
		// property worth pinning in both directions: a node with nothing to say
		// about its worker must not start sending nulls at a platform that
		// predates the fields (the test above), and a node that HAS a state must
		// actually put it on the wire rather than computing it and dropping it in
		// the projection (this one). Folding them into `nodeEmits` would have
		// asserted they are always sent, which is false — and this gate caught
		// exactly that when its own baseline was rebased over slice T.
		const { fetchFn, sent } = recorder(200, baseline.routes.heartbeat.response);
		await fleetClient(fetchFn).heartbeat({
			nodeId: NODE_ID,
			secret: SECRET,
			platform: 'linux/x64',
			version: '1.0.0',
			capabilities: [],
			cliVersion: '1.4.2',
			diskFreeBytes: 1,
			modelIdentity: 'x',
			workerState: 'quarantined',
			workerStateReason: 'helper trust check failed'
		});
		const emitted = Object.keys(bodyOf(sent)).filter((key) => key !== 'nodeId' && key !== 'secret');
		expect(emitted.sort()).toEqual(
			[...baseline.selfDescription.nodeEmits, ...baseline.selfDescription.nodeEmitsOptional].sort()
		);
		expect(bodyOf(sent).workerState).toBe('quarantined');
		expect(bodyOf(sent).workerStateReason).toBe('helper trust check failed');
	});

	it('pause and unenroll send exactly the pinned bodies', async () => {
		const pause = recorder(200, baseline.routes.pause.response);
		await fleetClient(pause.fetchFn).pause({ nodeId: NODE_ID, secret: SECRET, paused: true });
		expect(bodyOf(pause.sent)).toEqual(request('pause', 'current'));
		expect(pause.sent[0].url).toBe(`${API_URL}${baseline.routes.pause.path}`);

		const unenroll = recorder(200, baseline.routes.unenroll.response);
		await fleetClient(unenroll.fetchFn).unenroll({ nodeId: NODE_ID, secret: SECRET });
		expect(bodyOf(unenroll.sent)).toEqual(request('unenroll', 'current'));
		expect(unenroll.sent[0].url).toBe(`${API_URL}${baseline.routes.unenroll.path}`);
	});

	it('the lease poll sends exactly the pinned body, and an idle poll the credential alone', async () => {
		const full = recorder(200, baseline.routes['jobs-lease'].response);
		await jobClient(full.fetchFn).lease({ max: 2, leaseTtlSec: 120, capabilities: ['terminal', 'workspace'] });
		expect(bodyOf(full.sent)).toEqual(request('jobs-lease', 'current'));
		expect(full.sent[0].url).toBe(`${API_URL}${baseline.routes['jobs-lease'].path}`);

		const idle = recorder(200, baseline.routes['jobs-lease'].emptyResponse);
		await jobClient(idle.fetchFn).lease();
		expect(bodyOf(idle.sent)).toEqual(request('jobs-lease', 'legacy'));
	});

	it('the job heartbeat and complete send exactly the pinned bodies', async () => {
		const beat = recorder(200, baseline.routes['jobs-heartbeat'].response);
		await jobClient(beat.fetchFn).heartbeat(JOB_ID, 120, 1);
		expect(bodyOf(beat.sent)).toEqual(request('jobs-heartbeat', 'current'));
		expect(beat.sent[0].url).toBe(`${API_URL}${baseline.routes['jobs-heartbeat'].path.replace(':id', JOB_ID)}`);

		const done = recorder(200, baseline.routes['jobs-complete'].response);
		await jobClient(done.fetchFn).complete(
			JOB_ID,
			{ success: true, result: { exitCode: 0, summary: '3 checks passed' } },
			1
		);
		expect(bodyOf(done.sent)).toEqual(request('jobs-complete', 'current'));

		const failed = recorder(200, baseline.routes['jobs-complete'].response);
		await jobClient(failed.fetchFn).complete(
			JOB_ID,
			{ success: false, error: 'acceptance-checks: pnpm lint exited 1' },
			1
		);
		expect(bodyOf(failed.sent)).toEqual(request('jobs-complete', 'currentFailure'));
	});

	it('still emits the pre-EW-792 shape when the lease carried no generation', async () => {
		// This is the live proof that the `platform-too-new` rejection pinned on
		// the server side is REAL and not hypothetical: today's client, handed a
		// lease from an older API, omits `leaseGeneration` entirely — and the
		// current DTO requires it, so that node is 400'd on every beat.
		const beat = recorder(200, baseline.routes['jobs-heartbeat'].response);
		await jobClient(beat.fetchFn).heartbeat(JOB_ID, 120, undefined);
		expect(bodyOf(beat.sent)).toEqual(request('jobs-heartbeat', 'legacy'));
		expect(baseline.routes['jobs-heartbeat'].requests.legacy.expect).toBe('reject:platform-too-new');
	});
});

describe('what the node reads back', () => {
	it('accepts the pinned enroll response and keeps the credential', async () => {
		const { fetchFn } = recorder(201, baseline.routes.enroll.response);
		const result = await fleetClient(fetchFn).enroll({ token: TOKEN });
		expect(result.nodeId).toBe(NODE_ID);
		expect(typeof result.secret).toBe('string');
		expect(result.node.id).toBe(NODE_ID);
	});

	it('accepts the pinned heartbeat, pause and lease responses', async () => {
		const beat = await fleetClient(recorder(200, baseline.routes.heartbeat.response).fetchFn).heartbeat({
			nodeId: NODE_ID,
			secret: SECRET
		});
		expect(beat.node.id).toBe(NODE_ID);

		const paused = await fleetClient(recorder(200, baseline.routes.pause.response).fetchFn).pause({
			nodeId: NODE_ID,
			secret: SECRET,
			paused: true
		});
		expect(paused.node.id).toBe(NODE_ID);

		const jobs = await jobClient(recorder(200, baseline.routes['jobs-lease'].response).fetchFn).lease();
		expect(jobs).toHaveLength(1);
		expect(jobs[0].id).toBe(JOB_ID);
		expect(jobs[0].leaseGeneration).toBeGreaterThanOrEqual(1);
	});

	it('treats a stopped fleet as "nothing to do", never as an error (slice V / EW-778)', async () => {
		// The whole point of answering `200 {jobs: []}` rather than a 4xx: the
		// node must go on beating and polling, so clearing the flag brings the
		// fleet back with no operator action on any machine.
		const stopped = baseline.killSwitch.leaseWhenStopped;
		const jobs = await jobClient(recorder(stopped.status, stopped.body).fetchFn).lease();
		expect(jobs).toEqual([]);
	});

	it('rejects a lease answer that is not a list, rather than treating it as empty', async () => {
		// The failure a "return null when there is nothing" refactor produces.
		await expect(jobClient(recorder(200, { jobs: null }).fetchFn).lease()).rejects.toBeInstanceOf(FleetClientError);
	});
});

describe('the status codes the node branches on', () => {
	const statuses = (table: Record<string, string>) =>
		Object.entries(table).filter(([key]) => !key.startsWith('_')) as Array<[string, string]>;

	it('drives every status in BOTH tables, and keeps the tables different', () => {
		// ANTI-VACUITY. The two `it.each` blocks below are driven entirely by
		// the fixture: thin a table and cases DISAPPEAR rather than fail, and
		// vitest reports a green run over fewer tests. The counts are literals
		// in the source so shrinking the contract takes two edits.
		expect(statuses(baseline.nodeStatusBranches.fleet)).toHaveLength(8);
		expect(statuses(baseline.nodeStatusBranches.job)).toHaveLength(8);

		// The divergence IS the contract. `job-client.ts` has a 409 branch and
		// `fleet-client.ts` does not: the worker keys "abort and do NOT report"
		// on `stale-lease`, so collapsing the two tables into one would let a
		// superseded run overwrite the state of whoever holds the job now.
		expect(baseline.nodeStatusBranches.fleet['409']).toBe('invalid-request');
		expect(baseline.nodeStatusBranches.job['409']).toBe('stale-lease');
		expect(baseline.nodeStatusBranches.fleet).not.toEqual(baseline.nodeStatusBranches.job);
	});

	it.each(statuses(baseline.nodeStatusBranches.fleet))(
		'the enroll/heartbeat channel maps HTTP %s to %s',
		async (status, kind) => {
			const client = fleetClient(recorder(Number(status), { error: 'server detail' }).fetchFn);
			await expect(client.heartbeat({ nodeId: NODE_ID, secret: SECRET })).rejects.toMatchObject({ kind });
		}
	);

	it.each(statuses(baseline.nodeStatusBranches.job))('the job channel maps HTTP %s to %s', async (status, kind) => {
		// Note the deliberate divergence from the table above: only this
		// channel has a 409 → `stale-lease` branch. The worker keys "abort
		// and do NOT report" on it, so a 409 that became a 401 would let a
		// superseded run overwrite the state of whoever holds the job now.
		const client = jobClient(recorder(Number(status), { error: 'server detail' }).fetchFn);
		await expect(client.lease()).rejects.toMatchObject({ kind });
	});

	it('never surfaces the server body in the error a node logs', async () => {
		const client = jobClient(recorder(401, { message: 'node 3f7f5b3a is disabled' }).fetchFn);
		await expect(client.lease()).rejects.toThrow(/^(?!.*3f7f5b3a).*$/s);
	});

	it('a 401 on a job heartbeat is a lost lease (null), not a thrown error', async () => {
		// `null` means "abort and report"; `stale-lease` means "abort and do
		// NOT report". Collapsing the two loses a real distinction.
		const client = jobClient(recorder(401, {}).fetchFn);
		await expect(client.heartbeat(JOB_ID, 120, 1)).resolves.toBeNull();
	});
});
