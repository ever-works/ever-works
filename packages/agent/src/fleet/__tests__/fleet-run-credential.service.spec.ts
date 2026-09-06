import { createHash } from 'crypto';
import { FLEET_RUN_API_KEY_KIND, FLEET_RUN_TOKEN_GRACE_SEC } from '@ever-works/contracts';
import { FleetRunCredentialService } from '../fleet-run-credential.service';
import type { ApiKeyRepository } from '../../database/repositories/api-key.repository';
import type { FleetJobRepository } from '../fleet-job.repository';
import type { FleetNodeRepository } from '../fleet-node.repository';
import type { ApiKey } from '../../entities/api-key.entity';
import type { FleetJob } from '../../entities/fleet-job.entity';
import type { FleetNode } from '../../entities/fleet-node.entity';
import {
    FleetJobMcpCredentialMintedEvent,
    FleetJobMcpCredentialRevokedEvent,
} from '../../events/fleet-job.events';

/**
 * Run-scoped MCP credentials — self-build slice Z (EW-796).
 *
 * These specs are about ONE question: can a credential minted for a fleet
 * run do anything the run was not entitled to do, at any point in its
 * life? Every case below is a way of trying to make it, and every one is
 * expected to fail closed and INDISTINGUISHABLY — a node with a valid
 * secret must not be able to learn which jobs exist or what state they
 * are in from the shape of the refusal.
 *
 * The five gates, restated:
 *   mint     — only the node currently HOLDING the lease on an active,
 *              bridge-enabled job, and only while the operator switch is
 *              on;
 *   expiry   — never later than that lease deadline plus the grace;
 *   rotation — a re-mint kills its predecessors, so at most one token
 *              per job is ever live;
 *   validate — active row, right kind, unexpired, allowed route, and the
 *              bound job still held by the bound node;
 *   revoke   — at the node's request and, unconditionally, when the job
 *              settles.
 */

const NODE_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_NODE_ID = '99999999-2222-4333-8444-555555555555';
const SECRET = 'ZmFrZS1zZWNyZXQtdmFsdWUtZm9yLXVuaXQtdGVzdHM';
const OTHER_SECRET = 'b3RoZXItc2VjcmV0LXZhbHVlLWZvci11bml0LXRlc3Rz';
// A lease five minutes out, relative to NOW: the default TTL is 300 s and
// the expiry assertions are about the RELATIONSHIP to that deadline, not
// about a wall-clock date. A frozen date would make every live-token case
// silently expired.
const LEASE_EXPIRES = new Date(Date.now() + 5 * 60_000);

const sha256Hex = (value: string): string =>
    createHash('sha256').update(value, 'utf8').digest('hex');

function node(over: Partial<FleetNode> = {}): FleetNode {
    return {
        id: NODE_ID,
        userId: 'owner-1',
        status: 'online',
        enrollmentTokenHash: sha256Hex(SECRET),
        capabilities: [],
        organizationId: null,
        ...over,
    } as unknown as FleetNode;
}

function job(over: Partial<FleetJob> = {}): FleetJob {
    return {
        id: 'job-1',
        kind: 'agent-task',
        status: 'running',
        userId: 'owner-1',
        organizationId: 'org-1',
        nodeId: NODE_ID,
        leaseExpiresAt: LEASE_EXPIRES,
        cancelRequestedAt: null,
        payload: {
            taskId: 't1',
            runId: 'run-1',
            mcp: {
                enabled: true,
                serverUrl: 'https://mcp.ever.works/mcp',
                serverName: 'ever-works',
            },
        },
        ...over,
    } as unknown as FleetJob;
}

/** In-memory `api_keys` table with just the behaviour the service relies on. */
function makeApiKeys(rows: ApiKey[] = []) {
    const repo = {
        rows,
        create: jest.fn(async (data: Partial<ApiKey>) => {
            const row = { id: `key-${rows.length + 1}`, isActive: true, ...data } as ApiKey;
            rows.push(row);
            return row;
        }),
        findByHashedKey: jest.fn(
            async (hashedKey: string) =>
                rows.find((row) => row.hashedKey === hashedKey && row.isActive) ?? null,
        ),
        findActiveByBoundJob: jest.fn(async (jobId: string) =>
            rows.filter(
                (row) =>
                    row.boundJobId === jobId && row.kind === FLEET_RUN_API_KEY_KIND && row.isActive,
            ),
        ),
        deactivateByBoundJob: jest.fn(async (jobId: string) => {
            let affected = 0;
            for (const row of rows) {
                if (
                    row.boundJobId === jobId &&
                    row.kind === FLEET_RUN_API_KEY_KIND &&
                    row.isActive
                ) {
                    row.isActive = false;
                    affected += 1;
                }
            }
            return affected;
        }),
        updateLastUsed: jest.fn(async () => undefined),
    };
    return repo as unknown as ApiKeyRepository & typeof repo;
}

function makeJobs(rows: FleetJob[]) {
    return {
        findById: jest.fn(async (id: string) => rows.find((row) => row.id === id) ?? null),
    } as unknown as FleetJobRepository;
}

function makeNodes(rows: FleetNode[]) {
    return {
        findById: jest.fn(async (id: string) => rows.find((row) => row.id === id) ?? null),
    } as unknown as FleetNodeRepository;
}

function makeEvents() {
    const emitted: Array<{ name: string; event: unknown }> = [];
    return {
        emitted,
        bus: { emit: jest.fn((name: string, event: unknown) => emitted.push({ name, event })) },
    };
}

function build(over: { jobs?: FleetJob[]; nodes?: FleetNode[]; keys?: ApiKey[] } = {}) {
    const keys = makeApiKeys(over.keys ?? []);
    const jobs = makeJobs(over.jobs ?? [job()]);
    const nodes = makeNodes(over.nodes ?? [node()]);
    const events = makeEvents();
    const service = new FleetRunCredentialService(keys, jobs, nodes, events.bus as never);
    return { service, keys, jobs, nodes, events };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
    process.env.FLEET_NODE_MCP_BRIDGE_ENABLED = 'true';
    process.env.FLEET_NODE_MCP_URL = 'https://mcp.ever.works/mcp';
});

afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.restoreAllMocks();
});

describe('FleetRunCredentialService.mint — who may mint', () => {
    it('mints for the node currently holding the lease', async () => {
        const { service, keys } = build();

        const credential = await service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' });

        expect(credential).not.toBeNull();
        expect(credential?.token.startsWith('ew_run_')).toBe(true);
        expect(credential?.serverUrl).toBe('https://mcp.ever.works/mcp');
        // Stored hashed, never in plaintext — the same posture as ew_live_.
        const stored = (keys as unknown as { rows: ApiKey[] }).rows[0];
        expect(stored?.hashedKey).toBe(sha256Hex(credential!.token));
        expect(JSON.stringify(stored)).not.toContain(credential!.token);
    });

    it('binds the row to the job, run, node, owner and Organization', async () => {
        const { service, keys } = build();
        await service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' });

        const stored = (keys as unknown as { rows: ApiKey[] }).rows[0];
        expect(stored).toMatchObject({
            kind: FLEET_RUN_API_KEY_KIND,
            boundJobId: 'job-1',
            boundNodeId: NODE_ID,
            boundRunId: 'run-1',
            userId: 'owner-1',
            organizationId: 'org-1',
            isActive: true,
        });
    });

    it('refuses a node that is NOT holding this job (same undifferentiated null)', async () => {
        const { service } = build({
            nodes: [
                node(),
                node({ id: OTHER_NODE_ID, enrollmentTokenHash: sha256Hex(OTHER_SECRET) }),
            ],
        });

        await expect(
            service.mint({ nodeId: OTHER_NODE_ID, secret: OTHER_SECRET, jobId: 'job-1' }),
        ).resolves.toBeNull();
    });

    it('refuses a job that does not exist', async () => {
        const { service } = build();
        await expect(
            service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-missing' }),
        ).resolves.toBeNull();
    });

    it('refuses a wrong or malformed node secret', async () => {
        const { service } = build();
        await expect(
            service.mint({
                nodeId: NODE_ID,
                secret: 'wrong-but-long-enough-secret',
                jobId: 'job-1',
            }),
        ).resolves.toBeNull();
        await expect(
            service.mint({ nodeId: NODE_ID, secret: '', jobId: 'job-1' }),
        ).resolves.toBeNull();
        await expect(
            service.mint({ nodeId: 'not-a-uuid', secret: SECRET, jobId: 'job-1' }),
        ).resolves.toBeNull();
    });

    it.each(['done', 'failed', 'queued', 'cancelled'])(
        'refuses a job in %s — a finished run has no business holding a credential',
        async (status) => {
            const { service } = build({ jobs: [job({ status: status as FleetJob['status'] })] });
            await expect(
                service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' }),
            ).resolves.toBeNull();
        },
    );

    it('refuses a job with a cancel already requested', async () => {
        const { service } = build({ jobs: [job({ cancelRequestedAt: new Date() })] });
        await expect(
            service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' }),
        ).resolves.toBeNull();
    });

    it('refuses a job whose plan never enabled the bridge', async () => {
        const { service } = build({ jobs: [job({ payload: { taskId: 't1', runId: 'run-1' } })] });
        await expect(
            service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' }),
        ).resolves.toBeNull();

        const disabled = build({
            jobs: [job({ payload: { taskId: 't1', mcp: { enabled: false } } })],
        });
        await expect(
            disabled.service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' }),
        ).resolves.toBeNull();
    });

    it.each(['disabled', 'enrolling'])('refuses a %s node', async (status) => {
        const { service } = build({ nodes: [node({ status: status as FleetNode['status'] })] });
        await expect(
            service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' }),
        ).resolves.toBeNull();
    });

    it('refuses when the operator switch is off, even for a perfectly valid claim', async () => {
        process.env.FLEET_NODE_MCP_BRIDGE_ENABLED = 'false';
        const { service } = build();
        await expect(
            service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' }),
        ).resolves.toBeNull();
    });

    it('refuses when no MCP server URL is configured', async () => {
        delete process.env.FLEET_NODE_MCP_URL;
        const { service } = build();
        await expect(
            service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' }),
        ).resolves.toBeNull();
    });
});

describe('FleetRunCredentialService.mint — expiry and rotation', () => {
    it('expires with the lease it was minted under, plus the grace and nothing more', async () => {
        const { service, keys } = build();
        const credential = await service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' });

        const expected = new Date(LEASE_EXPIRES.getTime() + FLEET_RUN_TOKEN_GRACE_SEC * 1000);
        expect(credential?.expiresAt).toBe(expected.toISOString());
        const stored = (keys as unknown as { rows: ApiKey[] }).rows[0];
        expect(stored?.expiresAt?.getTime()).toBe(expected.getTime());
    });

    it('tracks a RENEWED lease: a later mint expires later', async () => {
        const row = job();
        const { service } = build({ jobs: [row] });
        const first = await service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' });

        row.leaseExpiresAt = new Date(LEASE_EXPIRES.getTime() + 300_000);
        const second = await service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' });

        expect(new Date(second!.expiresAt).getTime()).toBeGreaterThan(
            new Date(first!.expiresAt).getTime(),
        );
    });

    it('refuses a job with no lease deadline at all', async () => {
        const { service } = build({ jobs: [job({ leaseExpiresAt: null })] });
        await expect(
            service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' }),
        ).resolves.toBeNull();
    });

    it('rotation deactivates every predecessor, so only one token per job is live', async () => {
        const { service, keys } = build();
        const first = await service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' });
        const second = await service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' });

        expect(first!.token).not.toBe(second!.token);
        const rows = (keys as unknown as { rows: ApiKey[] }).rows;
        expect(rows).toHaveLength(2);
        expect(rows.filter((row) => row.isActive)).toHaveLength(1);
        expect(rows.find((row) => row.isActive)?.hashedKey).toBe(sha256Hex(second!.token));
    });

    it('records mint and rotation on the event bus, never the token', async () => {
        const { service, events } = build();
        await service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' });
        const credential = await service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' });

        const names = events.emitted.map((entry) => entry.name);
        expect(names).toEqual([
            FleetJobMcpCredentialMintedEvent.EVENT_NAME,
            FleetJobMcpCredentialRevokedEvent.EVENT_NAME,
            FleetJobMcpCredentialMintedEvent.EVENT_NAME,
        ]);
        const minted = events.emitted[2]?.event as FleetJobMcpCredentialMintedEvent;
        expect(minted.jobId).toBe('job-1');
        expect(minted.runId).toBe('run-1');
        expect(minted.nodeId).toBe(NODE_ID);
        expect(minted.organizationId).toBe('org-1');
        expect(minted.rotated).toBe(true);
        expect(JSON.stringify(events.emitted)).not.toContain(credential!.token);
    });

    it('a throwing event listener never costs the run its credential', async () => {
        const { service } = build();
        const bus = {
            emit: jest.fn(() => {
                throw new Error('listener exploded');
            }),
        };
        const broken = new FleetRunCredentialService(
            makeApiKeys(),
            makeJobs([job()]),
            makeNodes([node()]),
            bus as never,
        );
        await expect(
            broken.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' }),
        ).resolves.not.toBeNull();
        // And the same service without any bus at all still works.
        expect(
            await service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' }),
        ).not.toBeNull();
    });
});

describe('FleetRunCredentialService.authenticate', () => {
    const request = { method: 'GET', path: '/api/tasks' };

    async function minted() {
        const built = build();
        const credential = await built.service.mint({
            nodeId: NODE_ID,
            secret: SECRET,
            jobId: 'job-1',
        });
        return { ...built, token: credential!.token };
    }

    it('accepts a live token on an allowed route and reports its binding', async () => {
        const { service, token } = await minted();

        const binding = await service.authenticate(token, request);

        expect(binding).toMatchObject({
            userId: 'owner-1',
            jobId: 'job-1',
            nodeId: NODE_ID,
            runId: 'run-1',
            organizationId: 'org-1',
        });
    });

    it('refuses a route outside the MCP surface — the token cannot mint another', async () => {
        const { service, token } = await minted();

        await expect(
            service.authenticate(token, { method: 'POST', path: '/api/auth/api-keys' }),
        ).resolves.toBeNull();
        await expect(
            service.authenticate(token, { method: 'POST', path: '/api/fleet/jobs/job-1/complete' }),
        ).resolves.toBeNull();
        await expect(
            service.authenticate(token, { method: 'POST', path: '/api/fleet/nodes/n1/drain' }),
        ).resolves.toBeNull();
    });

    it('refuses an EXPIRED token', async () => {
        const { service, keys, token } = await minted();
        (keys as unknown as { rows: ApiKey[] }).rows[0]!.expiresAt = new Date(Date.now() - 1000);

        await expect(service.authenticate(token, request)).resolves.toBeNull();
    });

    it('refuses a REVOKED token', async () => {
        const { service, token } = await minted();
        await service.revokeForJob('job-1');

        await expect(service.authenticate(token, request)).resolves.toBeNull();
    });

    it('refuses a token whose job has SETTLED, even inside its expiry window', async () => {
        const row = job();
        const built = build({ jobs: [row] });
        const credential = await built.service.mint({
            nodeId: NODE_ID,
            secret: SECRET,
            jobId: 'job-1',
        });
        row.status = 'done' as FleetJob['status'];

        await expect(built.service.authenticate(credential!.token, request)).resolves.toBeNull();
    });

    it('refuses a token whose job was RELOCATED to another node', async () => {
        const row = job();
        const built = build({ jobs: [row] });
        const credential = await built.service.mint({
            nodeId: NODE_ID,
            secret: SECRET,
            jobId: 'job-1',
        });
        // The reclaim sweep handed the job to a different machine. The old
        // node's token dies at that instant, not at its expiry.
        row.nodeId = OTHER_NODE_ID;

        await expect(built.service.authenticate(credential!.token, request)).resolves.toBeNull();
    });

    it('refuses a token that is not a fleet-run row (a personal key with a run prefix)', async () => {
        const raw = 'ew_run_forged0000000000000000000000000000';
        const keys = makeApiKeys([
            {
                id: 'key-x',
                userId: 'owner-1',
                hashedKey: sha256Hex(raw),
                isActive: true,
                kind: 'personal',
                expiresAt: new Date(Date.now() + 60_000),
            } as unknown as ApiKey,
        ]);
        const service = new FleetRunCredentialService(keys, makeJobs([job()]), makeNodes([node()]));

        await expect(service.authenticate(raw, request)).resolves.toBeNull();
    });

    it('refuses a value without the run prefix without touching the database', async () => {
        const { service, keys } = build();
        await expect(service.authenticate('ew_live_something', request)).resolves.toBeNull();
        await expect(service.authenticate('', request)).resolves.toBeNull();
        expect(
            (keys as unknown as { findByHashedKey: jest.Mock }).findByHashedKey,
        ).not.toHaveBeenCalled();
    });

    it('refuses an unknown token', async () => {
        const { service } = build();
        await expect(
            service.authenticate('ew_run_unknown0000000000000000000000000', request),
        ).resolves.toBeNull();
    });
});

describe('FleetRunCredentialService revoke', () => {
    it('revokeForJob deactivates every live token and is idempotent', async () => {
        const { service, events } = build();
        await service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' });

        await expect(service.revokeForJob('job-1')).resolves.toBe(1);
        await expect(service.revokeForJob('job-1')).resolves.toBe(0);

        const revoked = events.emitted.filter(
            (entry) => entry.name === FleetJobMcpCredentialRevokedEvent.EVENT_NAME,
        );
        // One event for the real revoke; the no-op second call emits nothing.
        expect(revoked).toHaveLength(1);
        expect((revoked[0]?.event as FleetJobMcpCredentialRevokedEvent).reason).toBe('job-settled');
    });

    it('revokeForNode accepts the holding node and refuses everyone else', async () => {
        const { service } = build({
            nodes: [
                node(),
                node({ id: OTHER_NODE_ID, enrollmentTokenHash: sha256Hex(OTHER_SECRET) }),
            ],
        });
        await service.mint({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' });

        await expect(
            service.revokeForNode({ nodeId: OTHER_NODE_ID, secret: OTHER_SECRET, jobId: 'job-1' }),
        ).resolves.toBeNull();
        await expect(
            service.revokeForNode({
                nodeId: NODE_ID,
                secret: 'wrong-but-long-enough-secret',
                jobId: 'job-1',
            }),
        ).resolves.toBeNull();
        await expect(
            service.revokeForNode({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' }),
        ).resolves.toBe(1);
    });

    it('lets a DRAINED node settle the credential of work it still holds', async () => {
        // Mirrors `authenticateNode('report')`: draining stops new work, it
        // does not sever a machine from cleaning up what it already has.
        const { service } = build({ nodes: [node({ status: 'disabled' })] });
        await expect(
            service.revokeForNode({ nodeId: NODE_ID, secret: SECRET, jobId: 'job-1' }),
        ).resolves.toBe(0);
    });
});
