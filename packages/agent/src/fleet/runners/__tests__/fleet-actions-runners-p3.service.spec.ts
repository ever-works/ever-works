import { readFleetMachineError } from '../../machine/fleet-machine.errors';
import { FleetActionsRunnersService } from '../fleet-actions-runners.service';

/**
 * Actions runners on computers (FL-18 P3, T-27, T-28) — Docker-isolated
 * runners only where the computer advertises the container executor (both
 * capabilities required on the job, the daemon opt-in carried as given),
 * Reinstall with GitHub's current build (confirmed, busy-guarded), and the
 * "Update available" note from GitHub's build list.
 */

const OWNER = '7d1c0a52-3a8e-4c55-9b7d-2f8c0b1a9e01';
const NODE = '3f6e2a10-1b2c-4d3e-8f4a-5b6c7d8e9f00';
const RUNNER = '00000000-0000-4000-8000-000000000900';

const build = (version: string) => ({
    os: 'linux',
    architecture: 'x64',
    downloadUrl: `https://github.com/actions/runner/releases/download/v${version}/actions-runner-linux-x64-${version}.tar.gz`,
    filename: `actions-runner-linux-x64-${version}.tar.gz`,
    sha256: 'a'.repeat(64),
});

function harness(opts: { capabilities?: string[]; runnerState?: string; os?: string } = {}) {
    const node = {
        id: NODE,
        userId: OWNER,
        organizationId: null,
        name: 'build-01',
        kind: 'node',
        status: 'online',
        lastHeartbeatAt: new Date(),
        consents: { work: true },
        capabilities: opts.capabilities ?? [
            'actions-runner',
            'actions-runner-docker',
            `os:${opts.os ?? 'linux'}`,
            'arch:x64',
        ],
    };
    const rows = new Map<string, Record<string, unknown>>([
        [
            RUNNER,
            {
                id: RUNNER,
                nodeId: NODE,
                ownerUserId: OWNER,
                name: 'build-01-1',
                scope: 'repo',
                target: 'acme/api',
                labels: ['gpu'],
                mode: 'service',
                state: opts.runnerState ?? 'idle',
                runnerVersion: '2.321.0',
                removedAt: null,
            },
        ],
    ]);
    let seq = 0;
    const runners = {
        findById: jest.fn(async (id: string) => rows.get(id) ?? null),
        listForNode: jest.fn(async () => [...rows.values()]),
        create: jest.fn(async (data: Record<string, unknown>) => {
            seq += 1;
            const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
            rows.set(id, { ...data, id });
            return { ...data, id };
        }),
        update: jest.fn(async (id: string, patch: Record<string, unknown>) => {
            rows.set(id, { ...rows.get(id), ...patch });
        }),
        delete: jest.fn(async () => undefined),
        listOwnersWithRunners: jest.fn(async () => [OWNER]),
        listForOwner: jest.fn(async () => [...rows.values()]),
        purgeRemovedBefore: jest.fn(async () => 0),
    };
    const nodes = { findById: jest.fn(async () => node) };
    const enqueued: Array<Record<string, unknown>> = [];
    const jobs = {
        enqueue: jest.fn(async (input: Record<string, unknown>) => {
            enqueued.push(input);
            return { id: `job-${enqueued.length}` };
        }),
    };
    const facade = {
        listTargets: jest.fn(async () => []),
        resolveTarget: jest.fn(async (_u: string, scope: string, target: string) => ({
            scope,
            target,
            installationId: '1',
            installationEntityId: 'inst-1',
            accountLogin: 'acme',
            targetType: 'Organization',
            repositoryId: '7',
        })),
        listDownloads: jest.fn(async () => [build('2.322.0')]),
        listRunners: jest.fn(async () => ({
            runners: [],
            etag: null,
            notModified: false,
            rateLimitedUntil: null,
        })),
    };
    const service = new FleetActionsRunnersService(
        runners as never,
        nodes as never,
        jobs as never,
        {} as never,
        facade as never,
        undefined,
        { isStopped: jest.fn(async () => false) } as never,
        { tryRecord: jest.fn(async () => true) } as never,
        undefined,
    );
    return { service, rows, enqueued, facade };
}

const caller = { kind: 'user' as const, userId: OWNER };
const install = {
    target: { scope: 'repo' as const, target: 'acme/api' },
    count: 1,
    fields: { confirm: true },
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

describe('FleetActionsRunnersService — P3', () => {
    const saved = { ...process.env };
    beforeEach(() => {
        process.env.FLEET_ENABLED = 'true';
        process.env.FLEET_ACTIONS_RUNNERS_ENABLED = 'true';
    });
    afterEach(() => {
        process.env = { ...saved };
    });

    it('offers and installs container-isolated runners only where the computer advertises the container executor', async () => {
        const h = harness();
        expect((await h.service.options(caller, NODE)).modes).toEqual(['service', 'docker']);
        await h.service.install(caller, NODE, {
            ...install,
            mode: 'docker',
            shareDockerDaemon: true,
        });
        expect(h.enqueued[0]).toMatchObject({
            kind: 'runner-install',
            requiredCapabilities: ['actions-runner', 'actions-runner-docker'],
            payload: expect.objectContaining({ mode: 'docker', shareDockerDaemon: true }),
        });

        const without = harness({
            capabilities: ['actions-runner', 'docker', 'os:linux', 'arch:x64'],
        });
        expect((await without.service.options(caller, NODE)).modes).toEqual(['service']);
        expect(
            (await refusal(without.service.install(caller, NODE, { ...install, mode: 'docker' })))
                .code,
        ).toBe('unsupported_on_node');
        const windows = harness({ os: 'win32' });
        expect((await windows.service.options(caller, NODE)).modes).toEqual(['service']);
    });

    it('never shares the Docker daemon in service mode, whatever the request says', async () => {
        const h = harness();
        await h.service.install(caller, NODE, {
            ...install,
            mode: 'service',
            shareDockerDaemon: true,
        });
        expect(h.enqueued[0].payload).not.toHaveProperty('shareDockerDaemon');
        expect(h.enqueued[0].requiredCapabilities).toEqual(['actions-runner']);
    });

    it('reinstalls with GitHub’s current build after the confirmation, back to installing', async () => {
        const h = harness();
        const first = await refusal(h.service.control(caller, NODE, RUNNER, 'reinstall', {}));
        expect(first.code).toBe('confirmation_required');
        expect(first.details?.summary).toContain('Reinstall build-01-1 with runner 2.322.0?');
        await h.service.control(caller, NODE, RUNNER, 'reinstall', { confirm: true });
        expect(h.enqueued[0]).toMatchObject({
            kind: 'runner-control',
            payload: expect.objectContaining({
                action: 'reinstall',
                url: 'https://github.com/acme/api',
                labels: ['gpu'],
                download: expect.objectContaining({
                    filename: 'actions-runner-linux-x64-2.322.0.tar.gz',
                }),
            }),
        });
        expect(h.rows.get(RUNNER)).toMatchObject({
            state: 'installing',
            phase: 'queued',
            runnerVersion: '2.322.0',
        });
    });

    it('refuses a reinstall while the runner works on a job', async () => {
        const h = harness({ runnerState: 'working' });
        expect(
            (await refusal(h.service.control(caller, NODE, RUNNER, 'reinstall', { confirm: true })))
                .code,
        ).toBe('busy');
    });

    it('names the update GitHub publishes once its build list was read', async () => {
        const h = harness();
        expect((await h.service.list(caller, NODE)).runners[0].updateAvailable).toBeNull();
        await h.service.reconcile();
        expect((await h.service.list(caller, NODE)).runners[0].updateAvailable).toBe('2.322.0');
    });
});
