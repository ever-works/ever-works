import { AgentRunRepository } from '../../database/repositories/agent-run.repository';
import {
    APP_REPROVISION_MAX_PER_WINDOW,
    APP_REPROVISION_WINDOW_MS,
    AppProvisioningService,
    AppProvisionEventsService,
    provisionBrief,
} from '../app-provisioning.service';

/**
 * APW-04 — `POST /api/works/:id/provision/cancel` (plan §4) and the automatic
 * re-provision limits of T40 (FR-54: at most one per upstream sync commit and two
 * per rolling seven days; manual and creation starts are never limited).
 */

const SHA_A = 'abcdef1234567';
const SHA_B = '1234567abcdef';
const DAY = 24 * 60 * 60 * 1000;

function appWork(over: Record<string, unknown> = {}) {
    return {
        id: 'w1',
        userId: 'owner',
        name: 'Helpdesk',
        slug: 'helpdesk',
        kind: 'app',
        tenantId: null,
        organizationId: null,
        gitProvider: 'github',
        sourceRepository: {
            type: 'app_fork',
            owner: 'me',
            repo: 'helpdesk',
            upstream: { owner: 'example-org', repo: 'helpdesk', defaultBranch: 'main' },
            relatedRepositories: { website: { owner: 'me', repo: 'helpdesk' } },
        },
        getRepoOwner: () => 'me',
        getDataRepo: () => 'helpdesk-data',
        getWebsiteRepo: () => 'helpdesk',
        ...over,
    } as never;
}

function tasksDouble() {
    return {
        create: jest.fn(async (_userId: string, input: Record<string, unknown>) => ({
            id: 't-new',
            slug: 'T-9',
            ...input,
        })),
        runTask: jest.fn(async () => ({ taskId: 't-new', agentId: 'a1', runId: 'r1' })),
        transition: jest.fn(async () => ({})),
    };
}

/** A repository read of the inspection: one Dockerfile, enough to make the draft runnable. */
function git() {
    return {
        getRepository: jest.fn(async () => ({ defaultBranch: 'main' })),
        getWorkContents: jest.fn(async () => [
            { name: 'Dockerfile', type: 'file', path: 'Dockerfile' },
        ]),
        getFileContent: jest.fn(async (_o: string, _r: string, path: string) =>
            path === 'Dockerfile'
                ? { content: 'FROM node:22\nEXPOSE 3000\n', encoding: 'utf-8' }
                : null,
        ),
    };
}

/** A provisioning Task row as the repository would answer it. */
function provisionTask(over: {
    trigger?: string;
    commit?: string | null;
    origin?: string | null;
    ageMs?: number;
    status?: string;
    id?: string;
}) {
    const trigger = over.trigger ?? 'smoke-failed';
    return {
        id: over.id ?? `t-${Math.random().toString(16).slice(2, 8)}`,
        slug: 'T-1',
        workId: 'w1',
        status: over.status ?? 'done',
        origin: over.origin === undefined ? 'app-provisioning' : over.origin,
        createdAt: new Date(Date.now() - (over.ageMs ?? DAY)),
        description: [
            'Provision the App Work "Helpdesk" — …',
            '',
            `Trigger: \`${trigger}\`.`,
            '',
            ...(over.commit ? [`Upstream sync commit: \`${over.commit}\`.`, ''] : []),
        ].join('\n'),
    };
}

/** `findByUserIdFiltered`: nothing open (the dedupe read), `history` for every other read. */
function taskRepo(history: unknown[] | Error, open: unknown[] = []) {
    return {
        findByUserIdFiltered: jest.fn(async (_userId: string, filter: { status?: unknown }) => {
            if (filter.status) return { rows: open, total: open.length };
            if (history instanceof Error) throw history;
            return { rows: history, total: history.length };
        }),
    };
}

function service(
    repo: ReturnType<typeof taskRepo> | undefined,
    opts: {
        autoReprovision?: boolean;
        moduleRef?: unknown;
        tasks?: ReturnType<typeof tasksDouble>;
    } = {},
) {
    const tasks = opts.tasks ?? tasksDouble();
    const notifications = { create: jest.fn(async () => undefined) };
    const instance = new AppProvisioningService(
        { findById: jest.fn(async () => appWork()) } as never,
        git() as never,
        tasks as never,
        repo as never,
        { resolve: jest.fn(async () => ({ agentId: 'a1', source: 'pinned' as const })) },
        notifications as never,
        undefined,
        {
            getEffectiveSpec: jest.fn(async () => ({
                status: 'valid',
                spec: { provisioning: { autoReprovision: opts.autoReprovision ?? true } },
            })),
        } as never,
        opts.moduleRef as never,
    );
    return { instance, tasks, notifications };
}

async function smokeFailed(
    instance: AppProvisioningService,
    toSha: string | null = SHA_A,
): Promise<{ started: boolean; reason: string | null }> {
    await instance.start({
        workId: 'w1',
        trigger: 'smoke-failed',
        systemTrigger: true,
        upstreamFromSha: '0000000',
        upstreamToSha: toSha,
    });
    return (await instance.whenSettled('w1')) ?? { started: true, reason: 'queued' };
}

describe('T40 — automatic re-provision limits', () => {
    it(`refuses a third automatic re-provision inside ${APP_REPROVISION_WINDOW_MS / DAY} days`, async () => {
        const history = [
            provisionTask({ commit: '1111111', ageMs: 1 * DAY }),
            provisionTask({ commit: '2222222', ageMs: 3 * DAY }),
        ];
        expect(history).toHaveLength(APP_REPROVISION_MAX_PER_WINDOW);
        const { instance, tasks } = service(taskRepo(history));

        const result = await smokeFailed(instance);

        expect(result).toMatchObject({ started: false, reason: 'reprovisionLimitPerWeek' });
        // A limited start writes nothing.
        expect(tasks.create).not.toHaveBeenCalled();
        expect(tasks.runTask).not.toHaveBeenCalled();
    });

    it('refuses a second automatic re-provision for the SAME upstream sync commit', async () => {
        const { instance, tasks } = service(taskRepo([provisionTask({ commit: SHA_A })]));

        expect(await smokeFailed(instance, SHA_A)).toMatchObject({
            started: false,
            reason: 'reprovisionLimitPerCommit',
        });
        expect(tasks.create).not.toHaveBeenCalled();
    });

    it('allows one for a NEW commit, and records the commit in the brief', async () => {
        const { instance, tasks } = service(taskRepo([provisionTask({ commit: SHA_B })]));

        expect(await smokeFailed(instance, SHA_A)).toMatchObject({ started: true });
        const description = String(tasks.create.mock.calls[0][1].description);
        expect(description).toContain(`Upstream sync commit: \`${SHA_A}\`.`);
    });

    it('does not count Tasks older than the window', async () => {
        const old = [
            provisionTask({ commit: '1111111', ageMs: 8 * DAY }),
            provisionTask({ commit: '2222222', ageMs: 9 * DAY }),
        ];
        const { instance } = service(taskRepo(old));
        expect(await smokeFailed(instance)).toMatchObject({ started: true });
    });

    it('counts only server-written provisioning Tasks with an automatic trigger', async () => {
        const noise = [
            // A person's starts are never counted …
            provisionTask({ trigger: 'manual' }),
            provisionTask({ trigger: 'manual' }),
            provisionTask({ trigger: 'auto-create' }),
            // … nor is a Task whose text merely LOOKS like one (no server-written origin).
            provisionTask({ origin: null, commit: SHA_A }),
            provisionTask({ origin: null }),
        ];
        const { instance } = service(taskRepo(noise));
        expect(await smokeFailed(instance, SHA_A)).toMatchObject({ started: true });
    });

    it('fails CLOSED when the history cannot be read', async () => {
        const { instance, tasks } = service(taskRepo(new Error('db down')));
        expect(await smokeFailed(instance)).toMatchObject({
            started: false,
            reason: 'reprovisionLimitUnknown',
        });
        expect(tasks.create).not.toHaveBeenCalled();
    });

    it('never limits a manual start or the creation hand-off', async () => {
        const full = [
            provisionTask({ commit: '1111111' }),
            provisionTask({ commit: '2222222' }),
            provisionTask({ commit: SHA_A }),
        ];
        const manual = service(taskRepo(full));
        expect(
            await manual.instance.start({ workId: 'w1', trigger: 'manual', userId: 'owner' }),
        ).toMatchObject({ started: true });

        const create = service(taskRepo(full));
        await create.instance.start({ workId: 'w1', trigger: 'auto-create', systemTrigger: true });
        expect(await create.instance.whenSettled('w1')).toMatchObject({ started: true });
    });

    it('the events port hands the sync range to the limits', async () => {
        const provisioning = { start: jest.fn(async () => ({ started: true, reason: null })) };
        await new AppProvisionEventsService(provisioning as never).smokeFailedAfterUpstreamSync(
            'w1',
            '0000000',
            SHA_A,
        );
        expect(provisioning.start).toHaveBeenCalledWith(
            expect.objectContaining({ upstreamFromSha: '0000000', upstreamToSha: SHA_A }),
        );
    });

    it('provisionBrief writes the commit line only when it is given', () => {
        const base = {
            work: { id: 'w1', name: 'Helpdesk' },
            trigger: 'smoke-failed' as const,
            note: null,
            inspection: {
                repository: null,
                detection: { runnable: false, evidence: [], dependencies: [] } as never,
                draft: '',
                draftValid: false,
                draftIssues: [],
                files: {},
            },
            draft: '',
            draftValid: false,
            draftOrigin: 'detection' as const,
            pullRequestUrl: null,
        };
        expect(provisionBrief(base)).not.toContain('Upstream sync commit:');
        expect(provisionBrief({ ...base, upstreamToSha: SHA_A })).toContain(
            `Upstream sync commit: \`${SHA_A}\`.`,
        );
    });
});

describe('POST provision/cancel — AppProvisioningService.cancel', () => {
    const open = provisionTask({ id: 't-open', status: 'in_progress', trigger: 'manual' });

    function runsDouble(statuses: string[]) {
        const rows = statuses.map((status, i) => ({ id: `run-${i}`, status }));
        return {
            findRecentForTask: jest.fn(async () => rows),
            cancel: jest.fn(async (runId: string) => {
                const run = rows.find((r) => r.id === runId);
                return {
                    found: true,
                    previousStatus: run?.status,
                    triggerRunId: `trig-${runId}`,
                    workId: 'w1',
                };
            }),
        };
    }

    function moduleRefWith(runs: unknown, canceller: unknown) {
        return {
            get: jest.fn((token: unknown) => {
                if (token === AgentRunRepository) return runs;
                if (token === 'AGENT_RUN_CANCELLER') return canceller;
                throw new Error('unknown');
            }),
        };
    }

    it('cancels the live runs, then moves the open Task to cancelled as its owner', async () => {
        const runs = runsDouble(['running', 'completed', 'queued']);
        const canceller = { cancel: jest.fn(async () => 'cancelled') };
        const { instance, tasks } = service(taskRepo([open], [open]), {
            moduleRef: moduleRefWith(runs, canceller),
        });

        const result = await instance.cancel({ workId: 'w1', userId: 'editor' });

        expect(result).toMatchObject({
            status: 'cancelled',
            httpStatus: 202,
            taskId: 't-open',
            alreadyCancelled: false,
            cancelledRunIds: ['run-0', 'run-2'],
        });
        expect(runs.cancel).toHaveBeenCalledTimes(2);
        expect(canceller.cancel).toHaveBeenCalledWith('trig-run-0');
        expect(tasks.transition).toHaveBeenCalledWith(
            'owner',
            't-open',
            'cancelled',
            {},
            expect.anything(),
        );
        // Runs first, then the Task.
        expect(runs.cancel.mock.invocationCallOrder[0]).toBeLessThan(
            tasks.transition.mock.invocationCallOrder[0],
        );
    });

    it('is idempotent: a repeat after the Task is cancelled answers it again', async () => {
        const cancelled = { ...open, status: 'cancelled' };
        const { instance, tasks } = service(taskRepo([cancelled], []));

        expect(await instance.cancel({ workId: 'w1', userId: 'owner' })).toMatchObject({
            status: 'cancelled',
            httpStatus: 202,
            taskId: 't-open',
            alreadyCancelled: true,
            cancelledRunIds: [],
        });
        expect(tasks.transition).not.toHaveBeenCalled();
    });

    it('answers 409 nothingToCancel when no provisioning is open', async () => {
        const { instance, tasks } = service(taskRepo([{ ...open, status: 'done' }], []));
        expect(await instance.cancel({ workId: 'w1', userId: 'owner' })).toMatchObject({
            status: 'refused',
            httpStatus: 409,
            code: 'nothingToCancel',
        });
        expect(tasks.transition).not.toHaveBeenCalled();
    });

    it('answers 409 cancelRefused when the Task state machine refuses the move', async () => {
        const tasks = tasksDouble();
        tasks.transition.mockRejectedValueOnce(new Error('approver gate'));
        const { instance } = service(taskRepo([open], [open]), { tasks });
        expect(await instance.cancel({ workId: 'w1', userId: 'owner' })).toMatchObject({
            status: 'refused',
            httpStatus: 409,
            code: 'cancelRefused',
            taskId: 't-open',
        });
    });

    it('still cancels the Task when no run machinery is reachable', async () => {
        const { instance, tasks } = service(taskRepo([open], [open]));
        expect(await instance.cancel({ workId: 'w1', userId: 'owner' })).toMatchObject({
            status: 'cancelled',
            cancelledRunIds: [],
        });
        expect(tasks.transition).toHaveBeenCalledTimes(1);
    });

    it('refuses a Work that is not an App Work, and a missing Work', async () => {
        const tasks = tasksDouble();
        const notApp = new AppProvisioningService(
            { findById: jest.fn(async () => appWork({ kind: 'directory' })) } as never,
            undefined,
            tasks as never,
            taskRepo([]) as never,
        );
        expect(await notApp.cancel({ workId: 'w1', userId: 'owner' })).toMatchObject({
            httpStatus: 422,
            code: 'notAppWork',
        });
        const missing = new AppProvisioningService(
            { findById: jest.fn(async () => null) } as never,
            undefined,
            tasks as never,
            taskRepo([]) as never,
        );
        expect(await missing.cancel({ workId: 'w1', userId: 'owner' })).toMatchObject({
            httpStatus: 404,
            code: 'workNotFound',
        });
        expect(tasks.transition).not.toHaveBeenCalled();
    });
});
