import { ActionsRunnersFacadeError } from '../../../facades/actions-runners.facade';
import { readFleetMachineError } from '../../machine/fleet-machine.errors';
import { FleetActionsRunnersService } from '../fleet-actions-runners.service';

/**
 * Actions runners on computers (FL-18, T-09, plan §14) — the service against
 * in-memory doubles: the gate order (kill switch, audience, the machine, the
 * limit), the confirmation, rows written BEFORE the one durable job, a job
 * payload without a token, audit rows without a token, the remove busy guard,
 * the node-facing token (only for the job's runner, only the kind its job
 * needs, refused while the kill switch holds) and the remove fallback that
 * deletes the runner at GitHub by its id.
 */

const OWNER = '7d1c0a52-3a8e-4c55-9b7d-2f8c0b1a9e01';
const NODE = '3f6e2a10-1b2c-4d3e-8f4a-5b6c7d8e9f00';
const SECRET_TOKEN = 'AAAAREGISTRATIONTOKENZZZZ';

const DOWNLOAD = {
    os: 'linux',
    architecture: 'x64',
    downloadUrl:
        'https://github.com/actions/runner/releases/download/v2.321.0/actions-runner-linux-x64-2.321.0.tar.gz',
    filename: 'actions-runner-linux-x64-2.321.0.tar.gz',
    sha256: 'a'.repeat(64),
};

interface Row {
    id: string;
    nodeId: string;
    name: string;
    state: string;
    [key: string]: unknown;
}

function harness(
    opts: {
        stopped?: boolean;
        existing?: number;
        consents?: Record<string, boolean>;
        capabilities?: string[];
    } = {},
) {
    const node = {
        id: NODE,
        userId: OWNER,
        organizationId: null,
        name: 'build-01',
        kind: 'node',
        status: 'online',
        lastHeartbeatAt: new Date(),
        consents: opts.consents ?? { work: true, manage: false },
        capabilities: opts.capabilities ?? ['actions-runner', 'os:linux', 'arch:x64'],
    };
    const rows = new Map<string, Row>();
    for (let i = 0; i < (opts.existing ?? 0); i += 1) {
        const id = `00000000-0000-4000-8000-${String(900 + i).padStart(12, '0')}`;
        rows.set(id, {
            id,
            nodeId: NODE,
            name: `old-${i}`,
            state: 'idle',
            ownerUserId: OWNER,
            scope: 'repo',
            target: 'acme/api',
            labels: [],
        });
    }
    let seq = 0;
    const order: string[] = [];
    const runners = {
        findById: jest.fn(async (id: string) => rows.get(id) ?? null),
        listForNode: jest.fn(async (nodeId: string) =>
            [...rows.values()].filter((row) => row.nodeId === nodeId && row.state !== 'removed'),
        ),
        create: jest.fn(async (data: Partial<Row>) => {
            seq += 1;
            const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
            const row = { ...data, id } as Row;
            rows.set(id, row);
            order.push('row');
            return row;
        }),
        update: jest.fn(async (id: string, patch: Partial<Row>) => {
            const row = rows.get(id);
            if (row) rows.set(id, { ...row, ...patch });
        }),
        delete: jest.fn(async (id: string) => {
            rows.delete(id);
        }),
    };
    const nodes = { findById: jest.fn(async () => node), findByUser: jest.fn(async () => [node]) };
    const enqueued: Array<Record<string, unknown>> = [];
    const jobRecords = new Map<string, Record<string, unknown>>();
    const jobs = {
        enqueue: jest.fn(async (input: Record<string, unknown>) => {
            order.push('job');
            enqueued.push(input);
            const id = `job-${enqueued.length}`;
            jobRecords.set(id, {
                id,
                kind: input.kind,
                payload: input.payload,
                nodeId: NODE,
                status: 'leased',
            });
            return { id };
        }),
        authorizeRunSecretRequest: jest.fn(
            async (input: { nodeId: unknown; secret: unknown; jobId: string }) =>
                input.secret === 'node-secret' && jobRecords.has(input.jobId)
                    ? { jobId: input.jobId, userId: OWNER, nodeId: NODE }
                    : null,
        ),
    };
    const jobRows = { findById: jest.fn(async (id: string) => jobRecords.get(id) ?? null) };
    const facade = {
        listTargets: jest.fn(async () => [
            {
                scope: 'repo',
                target: 'acme/api',
                accountLogin: 'acme',
                installationEntityId: 'inst-1',
            },
        ]),
        resolveTarget: jest.fn(async (_u: string, scope: string, target: string) => {
            if (target !== 'acme/api') {
                throw new ActionsRunnersFacadeError(
                    'install the Ever Works GitHub App on it first',
                    'resolveTarget',
                    'not-covered',
                );
            }
            return {
                scope,
                target,
                installationId: 1,
                installationEntityId: 'inst-1',
                accountLogin: 'acme',
                repositoryIds: [7],
            };
        }),
        listDownloads: jest.fn(async () => [DOWNLOAD]),
        listRunners: jest.fn(async () => ({
            runners: [],
            etag: null,
            notModified: false,
            rateLimitedUntil: null,
        })),
        mintRegistrationToken: jest.fn(async () => ({
            token: SECRET_TOKEN,
            expiresAt: '2026-10-26T11:00:00Z',
        })),
        mintRemoveToken: jest.fn(async () => ({
            token: SECRET_TOKEN,
            expiresAt: '2026-10-26T11:00:00Z',
        })),
        deleteRunner: jest.fn(async () => undefined),
    };
    const audit = { tryRecord: jest.fn(async () => true) };
    const killSwitch = { isStopped: jest.fn(async () => Boolean(opts.stopped)) };
    const service = new FleetActionsRunnersService(
        runners as never,
        nodes as never,
        jobs as never,
        jobRows as never,
        facade as never,
        undefined,
        killSwitch as never,
        audit as never,
        undefined,
    );
    return { service, rows, runners, jobs, enqueued, facade, audit, killSwitch, order, node };
}

const caller = { kind: 'user' as const, userId: OWNER };
const install = {
    target: { scope: 'repo' as const, target: 'acme/api' },
    count: 2,
    labels: ['gpu'],
};

async function refusal(promise: Promise<unknown>) {
    try {
        await promise;
    } catch (error) {
        const known = readFleetMachineError(error);
        if (known) return known;
        throw error;
    }
    throw new Error('expected a refusal');
}

describe('FleetActionsRunnersService (FL-18 P1)', () => {
    const saved = { ...process.env };
    beforeEach(() => {
        process.env.FLEET_ENABLED = 'true';
        process.env.FLEET_ACTIONS_RUNNERS_ENABLED = 'true';
    });
    afterEach(() => {
        process.env = { ...saved };
    });

    it('is dark (not_found) while FLEET_ACTIONS_RUNNERS_ENABLED is off', async () => {
        process.env.FLEET_ACTIONS_RUNNERS_ENABLED = 'false';
        const { service } = harness();
        expect((await refusal(service.list(caller, NODE))).code).toBe('not_found');
    });

    it('asks for the confirmation with the dialog sentence (target, count, mode, computer, no credits)', async () => {
        const { service, enqueued, rows } = harness();
        const refused = await refusal(service.install(caller, NODE, install));
        expect(refused.code).toBe('confirmation_required');
        expect(refused.details?.summary).toBe(
            'Installs 2 Actions runners for acme/api on build-01 as services. They run CI jobs on that computer; no credits are spent.',
        );
        expect(enqueued).toHaveLength(0);
        expect(rows.size).toBe(0);
    });

    it('writes the rows first, then ONE job pinned by capability, whose payload carries the download and never a token', async () => {
        const { service, enqueued, order, rows, audit } = harness();
        const result = await service.install(caller, NODE, {
            ...install,
            fields: { confirm: true },
        });
        expect(order).toEqual(['row', 'row', 'job']);
        expect(result.runnerIds).toHaveLength(2);
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0]).toMatchObject({
            kind: 'runner-install',
            requiredCapabilities: ['actions-runner'],
        });
        const payload = enqueued[0].payload as Record<string, unknown>;
        expect(payload).toMatchObject({
            nodeId: NODE,
            target: 'acme/api',
            url: 'https://github.com/acme/api',
            mode: 'service',
            download: DOWNLOAD,
        });
        expect((payload.runners as Array<{ name: string }>).map((entry) => entry.name)).toEqual([
            'build-01-1',
            'build-01-2',
        ]);
        expect(JSON.stringify(payload)).not.toMatch(/token/i);
        expect([...rows.values()].every((row) => row.state === 'installing')).toBe(true);
        expect(audit.tryRecord).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(audit.tryRecord.mock.calls)).not.toContain(SECRET_TOKEN);
    });

    it('refuses in gate order: kill switch, consent, service manager, limit', async () => {
        expect(
            (await refusal(harness({ stopped: true }).service.install(caller, NODE, install))).code,
        ).toBe('kill_switch');
        expect(
            (
                await refusal(
                    harness({ consents: { work: false } }).service.install(caller, NODE, install),
                )
            ).code,
        ).toBe('consent_missing');
        expect(
            (
                await refusal(
                    harness({ capabilities: ['os:linux'] }).service.install(caller, NODE, install),
                )
            ).code,
        ).toBe('unsupported_on_node');
        expect(
            (await refusal(harness({ existing: 15 }).service.install(caller, NODE, install))).code,
        ).toBe('limit_exceeded');
    });

    it('refuses a target no installation of the caller covers (U7)', async () => {
        const { service } = harness();
        const refused = await refusal(
            service.install(caller, NODE, {
                ...install,
                target: { scope: 'repo', target: 'other/repo' },
                fields: { confirm: true },
            }),
        );
        expect(refused.code).toBe('permission_denied');
    });

    it('refuses Remove while the runner works (U16) and asks for the typed name otherwise', async () => {
        const { service, rows } = harness({ existing: 1 });
        const [row] = [...rows.values()];
        rows.set(row.id, { ...row, state: 'working', currentJob: { name: 'test · ubuntu' } });
        expect(
            (
                await refusal(
                    service.control(caller, NODE, row.id, 'remove', { confirmName: row.name }),
                )
            ).code,
        ).toBe('busy');
        rows.set(row.id, { ...row, state: 'idle' });
        const refused = await refusal(service.control(caller, NODE, row.id, 'remove', {}));
        expect(refused.code).toBe('confirmation_required');
        expect(refused.details?.class).toBe('confirm-destructive');
    });

    it('a stop marks the row stopped-by-owner; a start clears it', async () => {
        const { service, rows, enqueued } = harness({ existing: 1 });
        const [row] = [...rows.values()];
        await service.control(caller, NODE, row.id, 'stop', { confirm: true });
        expect(rows.get(row.id)?.stoppedByOwner).toBe(true);
        expect(enqueued[0]).toMatchObject({ kind: 'runner-control' });
        rows.set(row.id, { ...rows.get(row.id)!, state: 'stopped' });
        await service.control(caller, NODE, row.id, 'start', {});
        expect(rows.get(row.id)?.stoppedByOwner).toBe(false);
    });

    it('mints the registration token only for the node holding the install job of THIS runner', async () => {
        const { service, rows } = harness();
        const { runnerIds, jobId } = await service.install(caller, NODE, {
            ...install,
            fields: { confirm: true },
        });
        const ok = await service.mintRunnerToken(runnerIds[0], {
            nodeId: NODE,
            secret: 'node-secret',
            jobId,
            kind: 'register',
        });
        expect(ok).toEqual({
            token: SECRET_TOKEN,
            expiresAt: '2026-10-26T11:00:00Z',
            replace: false,
        });
        expect(rows.get(runnerIds[0])?.phase).toBe('registering');
        expect(
            await service.mintRunnerToken(runnerIds[0], {
                nodeId: NODE,
                secret: 'wrong',
                jobId,
                kind: 'register',
            }),
        ).toBeNull();
        // An install job never hands out a remove token.
        expect(
            await service.mintRunnerToken(runnerIds[0], {
                nodeId: NODE,
                secret: 'node-secret',
                jobId,
                kind: 'remove',
            }),
        ).toBeNull();
        // A runner the job does not name.
        expect(
            await service.mintRunnerToken('00000000-0000-4000-8000-000000000999', {
                nodeId: NODE,
                secret: 'node-secret',
                jobId,
                kind: 'register',
            }),
        ).toBeNull();
    });

    it('refuses the token while the kill switch holds (U14)', async () => {
        const h = harness();
        const { runnerIds, jobId } = await h.service.install(caller, NODE, {
            ...install,
            fields: { confirm: true },
        });
        h.killSwitch.isStopped.mockResolvedValue(true);
        const refused = await refusal(
            h.service.mintRunnerToken(runnerIds[0], {
                nodeId: NODE,
                secret: 'node-secret',
                jobId,
                kind: 'register',
            }),
        );
        expect(refused.code).toBe('kill_switch');
        expect(h.facade.mintRegistrationToken).not.toHaveBeenCalled();
    });

    it('refuses a name GitHub lists for another runner (U10) and marks the row failed', async () => {
        const h = harness();
        const { runnerIds, jobId } = await h.service.install(caller, NODE, {
            ...install,
            fields: { confirm: true },
        });
        h.facade.listRunners.mockResolvedValueOnce({
            runners: [{ id: 99, name: 'build-01-1', status: 'online', busy: false, labels: [] }],
            etag: null,
            notModified: false,
            rateLimitedUntil: null,
        } as never);
        const refused = await refusal(
            h.service.mintRunnerToken(runnerIds[0], {
                nodeId: NODE,
                secret: 'node-secret',
                jobId,
                kind: 'register',
            }),
        );
        expect(refused.code).toBe('invalid');
        expect(h.rows.get(runnerIds[0])?.state).toBe('failed');
    });

    it('progress: idle settles the install; removed without self-deregistration deletes it at GitHub by its id', async () => {
        const h = harness({ existing: 1 });
        const [row] = [...h.rows.values()];
        h.rows.set(row.id, { ...row, githubRunnerId: 42 });
        const { jobId } = await h.service.control(caller, NODE, row.id, 'remove', {
            confirmName: row.name,
        });
        expect(
            await h.service.reportProgress(row.id, {
                nodeId: NODE,
                secret: 'node-secret',
                jobId,
                state: 'removed',
                deregistered: false,
            }),
        ).toBe(true);
        expect(h.rows.get(row.id)?.state).toBe('removed');
        expect(h.facade.deleteRunner).toHaveBeenCalledWith(
            OWNER,
            expect.objectContaining({ target: 'acme/api' }),
            42,
        );

        const fresh = harness();
        const installed = await fresh.service.install(caller, NODE, {
            ...install,
            fields: { confirm: true },
        });
        await fresh.service.reportProgress(installed.runnerIds[0], {
            nodeId: NODE,
            secret: 'node-secret',
            jobId: installed.jobId,
            phase: 'done',
            state: 'idle',
            githubRunnerId: 77,
        });
        expect(fresh.rows.get(installed.runnerIds[0])).toMatchObject({
            state: 'idle',
            phase: null,
            githubRunnerId: 77,
        });
        expect(fresh.facade.deleteRunner).not.toHaveBeenCalled();
    });
});
