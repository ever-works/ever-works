import type { GitCheckConclusion, GitCheckStatus, GitWorkflowRun } from '@ever-works/plugin';
import {
    promotionGateVerdictFromRun,
    type PromotionGateRunReading,
    type PromotionGateVerdict,
} from '@ever-works/contracts';
import { GitFacadeService, GitOperationNotSupportedError } from '../git.facade';

/**
 * Release promotion lane (self-build slice AI, EW-808) — facade-side
 * contract for `getWorkflowRunForCommit`.
 *
 * Same absence rules as the PR-insights capabilities beside it: the method
 * is OPTIONAL on `IGitProviderPlugin`, and the lazy-plugin proxy in this
 * codebase over-reports optional methods, so the facade materialises it
 * off the resolved plugin and raises a typed error rather than letting a
 * TypeError become an unmapped 500.
 *
 * The consequence for the lane is deliberate and worth stating: a provider
 * that cannot read workflow runs makes the gate `unreadable`, and
 * `unreadable` is not a pass. The lane fails closed on a provider it
 * cannot interrogate.
 */

const OPTIONS = { providerId: 'github', userId: 'user-1', workId: 'work-1' } as const;

const RUN = {
    id: 1001,
    workflowPath: '.github/workflows/promotion-gate.yml',
    headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    status: 'completed' as const,
    conclusion: 'success' as const,
    url: 'https://github.com/ever-works/ever-works/actions/runs/1001',
};

function makeFacade(plugin: Record<string, unknown>) {
    const facade = new GitFacadeService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
    );
    (
        facade as unknown as {
            resolvePluginAndToken: () => Promise<{ plugin: unknown; token: string }>;
        }
    ).resolvePluginAndToken = jest
        .fn()
        .mockResolvedValue({ plugin: { id: 'github', ...plugin }, token: 'tok' });
    return facade;
}

describe('GitFacadeService.getWorkflowRunForCommit', () => {
    it('delegates to the provider with the resolved token', async () => {
        const getWorkflowRunForCommit = jest.fn().mockResolvedValue(RUN);
        const facade = makeFacade({ getWorkflowRunForCommit });

        await expect(
            facade.getWorkflowRunForCommit(
                'ever-works',
                'ever-works',
                'promotion-gate.yml',
                RUN.headSha,
                OPTIONS,
            ),
        ).resolves.toEqual(RUN);
        expect(getWorkflowRunForCommit).toHaveBeenCalledWith(
            'ever-works',
            'ever-works',
            'promotion-gate.yml',
            RUN.headSha,
            'tok',
        );
    });

    it('passes a provider `null` (no run for this commit) straight through', async () => {
        // `null` is a real answer — "the gate never ran on this commit" —
        // and the lane renders it differently from a broken lookup.
        const facade = makeFacade({
            getWorkflowRunForCommit: jest.fn().mockResolvedValue(null),
        });
        await expect(
            facade.getWorkflowRunForCommit(
                'acme',
                'widgets',
                'promotion-gate.yml',
                'abc1234',
                OPTIONS,
            ),
        ).resolves.toBeNull();
    });

    it('lets a provider error propagate rather than reporting the gate absent', async () => {
        const facade = makeFacade({
            getWorkflowRunForCommit: jest.fn().mockRejectedValue(new Error('403 actions:read')),
        });
        await expect(
            facade.getWorkflowRunForCommit(
                'acme',
                'widgets',
                'promotion-gate.yml',
                'abc1234',
                OPTIONS,
            ),
        ).rejects.toThrow('403 actions:read');
    });

    it('raises GitOperationNotSupportedError when the provider omits it', async () => {
        const facade = makeFacade({});
        await expect(
            facade.getWorkflowRunForCommit(
                'acme',
                'widgets',
                'promotion-gate.yml',
                'abc1234',
                OPTIONS,
            ),
        ).rejects.toBeInstanceOf(GitOperationNotSupportedError);
    });

    it('raises it for a proxy that reports a non-function member', async () => {
        const facade = makeFacade({ getWorkflowRunForCommit: undefined });
        await expect(
            facade.getWorkflowRunForCommit(
                'acme',
                'widgets',
                'promotion-gate.yml',
                'abc1234',
                OPTIONS,
            ),
        ).rejects.toBeInstanceOf(GitOperationNotSupportedError);
    });
});

/**
 * THE vocabulary agreement, asserted here because this is one of the very
 * few places both types are importable: `GitWorkflowRun` lives in
 * `@ever-works/plugin` and `PromotionGateRunReading` in
 * `@ever-works/contracts`, which has no dependencies and therefore cannot
 * import the provider types it is structurally compatible with.
 *
 * `promotion-gate.types.ts` says this file does exactly this. It did not,
 * until now — the comment named a guard that was not there, which is worse
 * than no comment at all.
 */
describe('GitWorkflowRun ↔ PromotionGateRunReading — one vocabulary, not two', () => {
    const CHECK_STATUSES = ['queued', 'in_progress', 'completed', 'unknown'] as const;
    const CHECK_CONCLUSIONS = [
        'success',
        'failure',
        'neutral',
        'cancelled',
        'timed_out',
        'action_required',
        'skipped',
        'stale',
    ] as const;

    it('pins the two string sets, so adding a member without a verdict fails here', () => {
        // Assignment in BOTH directions: the arrays are exhaustive over the
        // union (a member added to the type and not to the array leaves the
        // `satisfies` unsatisfied in spirit — the compile-time half — and a
        // member in the array that is not in the union fails `tsc`).
        const statuses: readonly GitCheckStatus[] = CHECK_STATUSES;
        const conclusions: readonly GitCheckConclusion[] = CHECK_CONCLUSIONS;
        expect(statuses).toHaveLength(4);
        expect(conclusions).toHaveLength(8);
    });

    it('reads a GitWorkflowRun as a PromotionGateRunReading, with no adapter in between', () => {
        // The structural claim `promotion-gate.types.ts` makes. If either
        // side renamed or re-typed `status` / `conclusion`, this stops
        // compiling — and the lane would otherwise have read every gate as
        // `unreadable` with no test failing.
        const run: GitWorkflowRun = {
            id: 1001,
            workflowPath: '.github/workflows/promotion-gate.yml',
            headSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
            status: 'completed',
            conclusion: 'success',
        };
        const reading: PromotionGateRunReading = run;
        expect(promotionGateVerdictFromRun(reading)).toBe('success');
    });

    it.each(CHECK_STATUSES.filter((status) => status !== 'completed'))(
        'maps the non-terminal status %s to pending',
        (status) => {
            const run: GitWorkflowRun = { ...RUN, status, conclusion: null };
            expect(promotionGateVerdictFromRun(run)).toBe('pending');
        },
    );

    it.each([
        ['success', 'success'],
        ['failure', 'failure'],
        ['timed_out', 'failure'],
        ['action_required', 'failure'],
        ['cancelled', 'cancelled'],
        ['neutral', 'skipped'],
        ['skipped', 'skipped'],
        ['stale', 'skipped'],
    ] as ReadonlyArray<readonly [GitCheckConclusion, PromotionGateVerdict]>)(
        'maps the completed conclusion %s to %s',
        (conclusion, expected) => {
            // EVERY member of `GitCheckConclusion`, so a new one added to
            // the provider vocabulary without a verdict here is caught by
            // the exhaustiveness assertion above rather than silently
            // becoming `unreadable` in production.
            const run: GitWorkflowRun = { ...RUN, status: 'completed', conclusion };
            expect(promotionGateVerdictFromRun(run)).toBe(expected);
        },
    );

    it('covers every conclusion the provider vocabulary defines', () => {
        const mapped = [
            'success',
            'failure',
            'timed_out',
            'action_required',
            'cancelled',
            'neutral',
            'skipped',
            'stale',
        ];
        expect([...CHECK_CONCLUSIONS].sort()).toEqual([...mapped].sort());
    });
});
