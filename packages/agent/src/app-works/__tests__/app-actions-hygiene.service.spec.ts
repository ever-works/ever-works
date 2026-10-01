import { APP_ACTIONS_HYGIENE_MAX_WORKFLOWS, APP_BUILD_WORKFLOW_PATH } from '@ever-works/contracts';
import { GitProviderRequestError } from '@ever-works/plugin';
import { GitOperationNotSupportedError } from '../../facades/git.facade';
import {
    APP_ACTIONS_HYGIENE_MAX_RECORDED,
    APP_ACTIONS_HYGIENE_MAX_SEEN_IDS,
    AppActionsHygieneService,
} from '../app-actions-hygiene.service';

/**
 * APW-02 T25 — Actions hygiene (plan §6.7, spec FR-25…FR-31, ACC-02-08,
 * ACC-02-20).
 *
 * The four claims this spec exists to pin, in the order the spec makes them:
 *
 *   1. **A linked repository is never touched** (FR-31) — `not_applicable`, with
 *      zero provider calls, and the reason is a property of the relation rather
 *      than of a job having visited the row.
 *   2. **`enabled` is never set, in either direction** (FR-26) — the repository's
 *      Actions switch is not hygiene's to flip, and the assertion is over every
 *      recorded call rather than over the one call each test happens to make.
 *   3. **A refusal never blocks the caller** (FR-30) — `needs_admin` and
 *      `permission_missing` are *return values* with the permission named, and
 *      the readiness job and the sync run carry on.
 *   4. **A workflow already judged is never judged again** (FR-27) — the ids the
 *      last pass saw come back as `skipWorkflowIds`, which is what makes a
 *      member's re-enabled workflow stay on.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const OWNER = 'me';
const REPO = 'widgets';

const BUILD_PATH = APP_BUILD_WORKFLOW_PATH;
const DEPLOY_PATH = '.github/workflows/deploy.yml';

/** A state row as `WorkUpstreamStateRepository.findByWorkId` returns it. */
function makeRow(overrides: Record<string, unknown> = {}) {
    return {
        workId: WORK_ID,
        relation: 'fork',
        dataOwner: OWNER,
        dataRepo: REPO,
        actionsState: 'pending',
        actionsSeenWorkflowIds: null,
        actionsDisabledWorkflows: null,
        actionsKeptWorkflows: null,
        ...overrides,
    };
}

function actionsResult(overrides: Record<string, unknown> = {}) {
    return {
        actionsEnabled: true,
        disabled: [],
        kept: [],
        enabled: [],
        seenIds: [],
        truncated: false,
        ...overrides,
    };
}

function makeService(
    options: {
        row?: Record<string, unknown> | null;
        work?: { userId: string } | null;
        result?: Record<string, unknown>;
        throws?: unknown;
    } = {},
) {
    const row = options.row === undefined ? makeRow() : options.row;
    const states = {
        findByWorkId: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(true),
    };
    const works = {
        findById: jest
            .fn()
            .mockResolvedValue(options.work === undefined ? { userId: USER_ID } : options.work),
    };
    const setActionsPermissions = jest.fn();
    if (options.throws !== undefined) {
        setActionsPermissions.mockRejectedValue(options.throws);
    } else {
        setActionsPermissions.mockResolvedValue(options.result ?? actionsResult());
    }
    const activity = { log: jest.fn().mockResolvedValue(undefined) };

    const service = new AppActionsHygieneService(
        states as never,
        works as never,
        { setActionsPermissions } as never,
        activity as never,
    );

    return { service, states, works, setActionsPermissions, activity };
}

/** The `input` argument of every `setActionsPermissions` call. */
function inputsOf(mock: jest.Mock): Array<Record<string, unknown>> {
    return mock.mock.calls.map((call) => call[2] as Record<string, unknown>);
}

describe('AppActionsHygieneService — a linked repository is never touched (FR-31)', () => {
    it('answers not_applicable without a single provider call', async () => {
        const { service, setActionsPermissions, activity, states } = makeService({
            row: makeRow({ relation: 'link' }),
        });

        const result = await service.apply(WORK_ID);

        expect(result.state).toBe('not_applicable');
        expect(result.called).toBe(false);
        expect(result.calls).toBe(0);
        expect(setActionsPermissions).not.toHaveBeenCalled();
        expect(activity.log).not.toHaveBeenCalled();
        // The answer is recorded so the Upstream card and the warnings read the
        // same value the run decided.
        expect(states.update).toHaveBeenCalledWith(
            WORK_ID,
            expect.objectContaining({ actionsState: 'not_applicable' }),
        );
    });

    it('takes the relation from the caller when there is no row to read', async () => {
        const { service, setActionsPermissions } = makeService({ row: null });

        const result = await service.apply(WORK_ID, { relation: 'link' });

        expect(result.state).toBe('not_applicable');
        expect(setActionsPermissions).not.toHaveBeenCalled();
    });
});

describe('AppActionsHygieneService — the disabling pass (FR-25, ACC-02-08)', () => {
    it('disables every inherited workflow except the build workflow, and never the repository switch', async () => {
        const { service, setActionsPermissions, states, activity } = makeService({
            result: actionsResult({
                disabled: [{ id: 2, path: DEPLOY_PATH }],
                kept: [{ id: 1, path: BUILD_PATH }],
                seenIds: [1, 2],
            }),
        });

        const result = await service.apply(WORK_ID);

        expect(setActionsPermissions).toHaveBeenCalledTimes(1);
        const [owner, repo, input, options] = setActionsPermissions.mock.calls[0];
        expect(owner).toBe(OWNER);
        expect(repo).toBe(REPO);
        expect(input).toEqual({
            disableWorkflowsExcept: [BUILD_PATH],
            skipWorkflowIds: [],
            maxWorkflows: APP_ACTIONS_HYGIENE_MAX_WORKFLOWS,
        });
        expect(options).toEqual({ userId: USER_ID, providerId: 'github', workId: WORK_ID });

        expect(result.state).toBe('clean');
        expect(result.disabled).toEqual([{ id: 2, path: DEPLOY_PATH }]);
        expect(result.kept).toEqual([{ id: 1, path: BUILD_PATH }]);
        expect(result.seenIds).toEqual([1, 2]);

        expect(states.update).toHaveBeenCalledWith(
            WORK_ID,
            expect.objectContaining({
                actionsState: 'clean',
                actionsSeenWorkflowIds: [1, 2],
                actionsDisabledWorkflows: [{ id: 2, path: DEPLOY_PATH }],
                actionsKeptWorkflows: [{ id: 1, path: BUILD_PATH }],
            }),
        );
    });

    it('never sets `enabled` on ANY call — the repository switch is not hygiene’s (FR-26)', async () => {
        const failing = makeService({
            throws: new GitProviderRequestError('permission_missing', 403, {
                permission: 'actions',
            }),
        });
        const passing = makeService({
            result: actionsResult({ disabled: [{ id: 2, path: DEPLOY_PATH }], seenIds: [2] }),
        });

        await failing.service.apply(WORK_ID);
        await passing.service.apply(WORK_ID);

        for (const mock of [failing.setActionsPermissions, passing.setActionsPermissions]) {
            expect(inputsOf(mock)).not.toHaveLength(0);
            for (const input of inputsOf(mock)) {
                expect(input.enabled).toBeUndefined();
                expect('enabled' in input).toBe(false);
            }
        }
    });

    it('passes the ids the last pass judged as skipWorkflowIds (FR-27)', async () => {
        const { service, setActionsPermissions } = makeService({
            row: makeRow({ actionsSeenWorkflowIds: [7, 8] }),
            result: actionsResult({ seenIds: [7, 8, 9] }),
        });

        await service.apply(WORK_ID);

        expect(inputsOf(setActionsPermissions)[0].skipWorkflowIds).toEqual([7, 8]);
    });

    it('merges this pass’s ids into the stored ones, without duplicates and within the cap', async () => {
        const stored = Array.from({ length: APP_ACTIONS_HYGIENE_MAX_SEEN_IDS }, (_, i) => i + 1);
        const { service, states } = makeService({
            row: makeRow({ actionsSeenWorkflowIds: stored }),
            result: actionsResult({ seenIds: [1, 2, 999] }),
        });

        await service.apply(WORK_ID);

        const patch = states.update.mock.calls[0][1] as { actionsSeenWorkflowIds: number[] };
        expect(patch.actionsSeenWorkflowIds).toHaveLength(APP_ACTIONS_HYGIENE_MAX_SEEN_IDS);
        expect(patch.actionsSeenWorkflowIds).toContain(1);
        // The list is full, so the new id is the part that is dropped — never a
        // stored one, because dropping those would re-judge a member's choice.
        expect(patch.actionsSeenWorkflowIds).not.toContain(999);
    });

    it('merges this pass’s lists into the stored ones, bounded, keyed by path', async () => {
        const stored = Array.from({ length: APP_ACTIONS_HYGIENE_MAX_RECORDED }, (_, i) => ({
            id: i + 1,
            path: `.github/workflows/w${i + 1}.yml`,
        }));
        const { service, states } = makeService({
            row: makeRow({ actionsDisabledWorkflows: stored }),
            result: actionsResult({
                disabled: [
                    { id: 1, path: stored[0].path },
                    { id: 5000, path: '.github/workflows/new.yml' },
                ],
            }),
        });

        await service.apply(WORK_ID);

        const patch = states.update.mock.calls[0][1] as {
            actionsDisabledWorkflows: Array<{ path: string }>;
        };
        expect(patch.actionsDisabledWorkflows).toHaveLength(APP_ACTIONS_HYGIENE_MAX_RECORDED);
        expect(patch.actionsDisabledWorkflows).toContainEqual(stored[0]);
    });

    it('records a partial pass as truncated', async () => {
        const { service } = makeService({ result: actionsResult({ truncated: true }) });

        const result = await service.apply(WORK_ID);

        expect(result.truncated).toBe(true);
        expect(result.state).toBe('clean');
    });
});

describe('AppActionsHygieneService — one Activity entry per run that disabled something (FR-29)', () => {
    it('emits app.actions.disabled with the count and the paths', async () => {
        const { service, activity } = makeService({
            result: actionsResult({
                disabled: [
                    { id: 2, path: DEPLOY_PATH },
                    { id: 3, path: '.github/workflows/release.yml' },
                ],
            }),
        });

        const result = await service.apply(WORK_ID);

        expect(result.emitted).toBe(true);
        expect(activity.log).toHaveBeenCalledTimes(1);
        expect(activity.log).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: USER_ID,
                workId: WORK_ID,
                actionType: 'app_actions',
                action: 'app.actions.disabled',
                details: { count: 2, paths: [DEPLOY_PATH, '.github/workflows/release.yml'] },
            }),
        );
    });

    it('emits nothing when this run disabled nothing', async () => {
        const { service, activity } = makeService({
            result: actionsResult({ kept: [{ id: 1, path: BUILD_PATH }] }),
        });

        const result = await service.apply(WORK_ID);

        expect(result.state).toBe('clean');
        expect(result.emitted).toBe(false);
        expect(activity.log).not.toHaveBeenCalled();
    });
});

describe('AppActionsHygieneService — a refusal is a named state, never a thrown error (FR-30)', () => {
    it('answers permission_missing, naming the permission, for an App refusal', async () => {
        const { service, states, activity } = makeService({
            throws: new GitProviderRequestError('permission_missing', 403, {
                permission: 'administration',
            }),
        });

        const result = await service.apply(WORK_ID);

        expect(result.state).toBe('permission_missing');
        expect(result.reason).toBe('permission_missing');
        expect(result.permission).toBe('administration');
        expect(result.called).toBe(true);
        expect(states.update).toHaveBeenCalledWith(
            WORK_ID,
            expect.objectContaining({ actionsState: 'permission_missing' }),
        );
        // Nothing was disabled, so there is no "Actions disabled" entry to write.
        expect(activity.log).not.toHaveBeenCalled();
    });

    it('answers needs_admin, naming the permission, for a member-credential refusal (ACC-02-20)', async () => {
        const { service, states } = makeService({
            throws: new GitProviderRequestError('permission_missing', 403, {
                permission: 'actions',
            }),
        });

        const result = await service.apply(WORK_ID);

        expect(result.state).toBe('needs_admin');
        expect(result.permission).toBe('actions');
        expect(states.update).toHaveBeenCalledWith(
            WORK_ID,
            expect.objectContaining({ actionsState: 'needs_admin' }),
        );
    });

    it('answers failed with the provider’s own reason for a rate limit, keeping its retry instant', async () => {
        const { service, states } = makeService({
            throws: new GitProviderRequestError('rate_limited', 403, {
                retryAt: '2026-09-17T10:00:00.000Z',
            }),
        });

        const result = await service.apply(WORK_ID);

        expect(result.state).toBe('failed');
        expect(result.reason).toBe('rate_limited');
        expect(result.retryAt).toBe('2026-09-17T10:00:00.000Z');
        expect(states.update).toHaveBeenCalledWith(
            WORK_ID,
            expect.objectContaining({ actionsState: 'failed' }),
        );
    });

    it('answers failed/provider_unsupported when the provider has no such capability (plan §7)', async () => {
        const { service, states } = makeService({
            throws: new GitOperationNotSupportedError('setActionsPermissions', 'github'),
        });

        const result = await service.apply(WORK_ID);

        expect(result.state).toBe('failed');
        expect(result.reason).toBe('provider_unsupported');
        expect(states.update).toHaveBeenCalledWith(
            WORK_ID,
            expect.objectContaining({ actionsState: 'failed' }),
        );
    });

    it('answers failed for a code neither the provider nor this service knows', async () => {
        const { service } = makeService({ throws: new Error('socket hang up') });

        const result = await service.apply(WORK_ID);

        expect(result.state).toBe('failed');
        expect(result.reason).toBe('unexpected');
    });

    it('does not let a broken Activity logger turn a clean pass into a crash', async () => {
        const { service, activity } = makeService({
            result: actionsResult({ disabled: [{ id: 2, path: DEPLOY_PATH }] }),
        });
        activity.log.mockRejectedValue(new Error('activity table is gone'));

        const result = await service.apply(WORK_ID);

        expect(result.state).toBe('clean');
        expect(result.emitted).toBe(false);
        expect(result.disabled).toHaveLength(1);
    });

    it('does not let a broken state write turn a pass into a crash', async () => {
        const { service, states } = makeService({
            result: actionsResult({ disabled: [{ id: 2, path: DEPLOY_PATH }] }),
        });
        states.update.mockRejectedValue(new Error('database is gone'));

        const result = await service.apply(WORK_ID);

        expect(result.state).toBe('clean');
        expect(result.recorded).toBe(false);
    });
});

describe('AppActionsHygieneService — the paths that cannot reach the provider at all', () => {
    it('answers failed/state_not_found when there are no coordinates anywhere', async () => {
        const { service, setActionsPermissions } = makeService({ row: null });

        const result = await service.apply(WORK_ID);

        expect(result.state).toBe('failed');
        expect(result.reason).toBe('state_not_found');
        expect(result.called).toBe(false);
        expect(setActionsPermissions).not.toHaveBeenCalled();
    });

    it('answers failed/work_not_found when the Work owner cannot be read — no call is made without a credential', async () => {
        const { service, setActionsPermissions } = makeService({ work: null });

        const result = await service.apply(WORK_ID);

        expect(result.state).toBe('failed');
        expect(result.reason).toBe('work_not_found');
        expect(setActionsPermissions).not.toHaveBeenCalled();
    });

    it('answers failed/provider_unsupported when no git facade is bound', async () => {
        const states = { findByWorkId: jest.fn().mockResolvedValue(makeRow()), update: jest.fn() };
        const service = new AppActionsHygieneService(states as never);

        const result = await service.apply(WORK_ID);

        expect(result.state).toBe('failed');
        expect(result.reason).toBe('provider_unsupported');
        expect(result.called).toBe(false);
    });
});
