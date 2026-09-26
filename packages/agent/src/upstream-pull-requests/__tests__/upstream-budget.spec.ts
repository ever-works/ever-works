import { BudgetExceededException } from '../../budgets/budget-exceeded.exception';
import { BudgetGuardService } from '../../budgets/budget-guard.service';
import { BudgetService } from '../../budgets/budget.service';
import { BudgetThresholdCrossedEvent } from '../../budgets/budget-threshold-crossed.event';
import { PluginUsageCapability } from '../../entities/plugin-usage-event.entity';
import { WorkBudgetAlertThreshold } from '../../entities/work-budget-alert-state.entity';
import { WorkBudget, WorkBudgetScope } from '../../entities/work-budget.entity';
import {
    UPSTREAM_BUDGET_WAIT,
    UPSTREAM_BUDGET_WAIT_CODE,
    UPSTREAM_BUDGET_WAIT_HTTP_STATUS,
    UPSTREAM_CONTRIBUTION_CAPABILITY,
    UPSTREAM_CONTRIBUTION_PLUGIN_ID,
    UPSTREAM_CONTRIBUTION_RUN_KINDS,
    UpstreamContributionBudgetService,
    isBudgetExceededLike,
    nextPeriodStartUtc,
    toUpstreamBudgetWaitResponse,
    type UpstreamBudgetWait,
    type UpstreamBudgetWaitResponse,
    type UpstreamContributionDispatch,
    type UpstreamContributionRunRequest,
} from '../upstream-contribution-budget.service';

/**
 * APW-09 T44 (FR-44, ACC-09-33; XC-19) — **contribution runs booked against the
 * App Work's own budget.**
 *
 * The task's own list, case for case:
 *
 *   - "a preparation **over the cap** dispatches no run, opens nothing and reports
 *     the reset time" — `a contribution run over the Work budget waits…`;
 *   - "the same Work's **other counters are untouched**" — `leaves every other
 *     counter alone…`;
 *   - "the **alert fires at the Work's threshold**" — `the alert fires at the
 *     Work's threshold`;
 *   - "a run **under the cap dispatches exactly once**" — `a run under the cap
 *     dispatches exactly once`.
 *
 * ## The harness is the real one, not a mock of it
 *
 * `BudgetGuardService` is constructed for real over a real `BudgetService`, whose
 * only stubs are the two repositories and the event emitter — the same harness
 * `budgets/budget-guard.service.spec.ts` uses. That matters for the two claims
 * that are *about the guard's behaviour* rather than about this service's: the
 * threshold alert (`WorkBudgetAlertStateRepository` + `BudgetThresholdCrossedEvent`)
 * and the `402` `BudgetExceededException` this gate has to recognise. A mocked
 * guard would let both pass while the real one did something else.
 *
 * ## Nothing here is dispatched "somewhere"
 *
 * `dispatch()`'s thunk is the only way work starts, so "dispatched no run" is
 * asserted as a call count on the thunk itself: zero, with the wait handed back —
 * and the service has no provider-facing dependency to inject in the first place
 * (see its docstring), which is the mechanism behind "a refusal opens nothing".
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

/** The instant every case measures from, so `resetAt` is a fixed assertion. */
const NOW = new Date('2026-05-15T12:00:00Z');
/** The end of that budget period: 2026-06-01T00:00:00.000Z. */
const NEXT_PERIOD_START = '2026-06-01T00:00:00.000Z';

function makeBudget(overrides: Partial<WorkBudget> = {}): WorkBudget {
    return {
        id: 'budget-1',
        workId: WORK_ID,
        scope: WorkBudgetScope.GLOBAL,
        pluginId: null,
        monthlyCapCents: 10_000,
        currency: 'usd',
        allowOverage: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        work: undefined as never,
        ...overrides,
    } as WorkBudget;
}

function makeHarness({
    global = null as WorkBudget | null,
    plugin = null as WorkBudget | null,
    currentSpendCents = 0,
}: {
    global?: WorkBudget | null;
    plugin?: WorkBudget | null;
    currentSpendCents?: number;
} = {}) {
    const budgetRepo = {
        findGlobal: jest.fn().mockResolvedValue(global),
        findForPlugin: jest.fn().mockResolvedValue(plugin),
        findAllForWork: jest.fn(),
        findById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findGlobalForOwner: jest.fn(),
        findForOwnerPlugin: jest.fn(),
    };
    const usageRepo = {
        record: jest.fn(),
        getTotalSpendCents: jest.fn().mockResolvedValue(currentSpendCents),
        getSpendByPlugin: jest.fn(),
        getDailySpend: jest.fn(),
        getCrossUserSpend: jest.fn(),
        findForExport: jest.fn(),
        pruneOlderThan: jest.fn(),
    };
    const alertState = {
        hasAlerted: jest.fn().mockResolvedValue(false),
        record: jest.fn().mockResolvedValue({ inserted: true }),
        listForBudget: jest.fn().mockResolvedValue([]),
    };
    const eventEmitter = { emit: jest.fn() };

    const budgets = new BudgetService(budgetRepo as never, usageRepo as never);
    const guard = new BudgetGuardService(budgets, alertState as never, eventEmitter as never);
    const service = new UpstreamContributionBudgetService(guard, budgets);
    return { service, guard, budgets, budgetRepo, usageRepo, alertState, eventEmitter };
}

function preparation(
    overrides: Partial<UpstreamContributionRunRequest> = {},
): UpstreamContributionRunRequest {
    return {
        workId: WORK_ID,
        userId: USER_ID,
        kind: 'preparation',
        rowState: 'preparing',
        now: NOW,
        ...overrides,
    };
}

function followUp(
    overrides: Partial<UpstreamContributionRunRequest> = {},
): UpstreamContributionRunRequest {
    return { ...preparation(overrides), kind: 'review_follow_up', ...overrides };
}

/**
 * The refused half of a dispatch, narrowed. TypeScript does not narrow a
 * *generic* discriminated union through a bare `if` here (the arm keeps its type
 * parameter), so the guard proves the arm at runtime and then asserts the type it
 * just proved — which is also what fails a case whose booking was allowed.
 */
type RefusedArm = {
    readonly dispatched: false;
    readonly wait: UpstreamBudgetWait;
    readonly response: UpstreamBudgetWaitResponse;
};

function refused<T>(outcome: UpstreamContributionDispatch<T>): RefusedArm {
    if (outcome.dispatched) {
        throw new Error('expected the budget to refuse this run, but it was dispatched');
    }
    return outcome as RefusedArm;
}

function allowedResult<T>(outcome: UpstreamContributionDispatch<T>): T {
    if (!outcome.dispatched) {
        throw new Error(
            `expected the run to be dispatched, but the budget refused it: ${JSON.stringify(
                (outcome as RefusedArm).wait,
            )}`,
        );
    }
    return outcome.result;
}

describe('APW-09 T44 — a contribution run over the Work budget waits, and dispatches nothing', () => {
    it('dispatches nothing over the cap, and reports the reset time', async () => {
        const { service } = makeHarness({
            global: makeBudget({ monthlyCapCents: 10_000, allowOverage: false }),
            currentSpendCents: 12_500,
        });
        const run = jest.fn().mockResolvedValue('a prepared branch');

        const outcome = await service.dispatch(preparation(), run);
        const { wait } = refused(outcome);

        // A preparation over the cap must not be dispatched — the thunk IS the
        // dispatch, so its call count is the claim.
        expect(run).not.toHaveBeenCalled();
        expect(wait).toMatchObject({
            waiting: 'budget',
            code: 'budgetExceeded',
            resetAt: NEXT_PERIOD_START,
            resetAtMs: Date.parse(NEXT_PERIOD_START),
            rowState: 'preparing',
            kind: 'preparation',
            scope: WorkBudgetScope.GLOBAL,
            currentSpendCents: 12_500,
            capCents: 10_000,
            currency: 'usd',
        });
        // The reset time is in the future, so "wait until then" is a real
        // instruction rather than a past instant.
        expect(Date.parse(wait.resetAt)).toBeGreaterThan(NOW.getTime());
    });

    it('surfaces the wait as 202 { state, waiting, resetAt } rather than a 422', async () => {
        const { service } = makeHarness({
            global: makeBudget(),
            currentSpendCents: 10_000,
        });
        const outcome = await service.dispatch(preparation(), jest.fn());
        const { response, wait } = refused(outcome);

        expect(outcome.dispatched).toBe(false);
        expect(response).toMatchObject({
            state: 'preparing',
            waiting: 'budget',
            resetAt: NEXT_PERIOD_START,
        });
        // The row keeps its state — a budget refusal is a wait, not a refusal of
        // the proposal, and 422 is what every genuine upstream refusal uses.
        expect(response.state).toBe('preparing');
        expect(response.waiting).toBe(UPSTREAM_BUDGET_WAIT);
        expect(UPSTREAM_BUDGET_WAIT_HTTP_STATUS).toBe(202);
        expect(response.limit).toMatchObject({
            scope: WorkBudgetScope.GLOBAL,
            currentSpendCents: 10_000,
            capCents: 10_000,
            currency: 'usd',
        });
        expect(response.code).toBe(UPSTREAM_BUDGET_WAIT_CODE);
        expect(wait.resetAt).toBe(NEXT_PERIOD_START);
    });

    it('waits the review follow-up run the same way', async () => {
        const { service } = makeHarness({
            global: makeBudget(),
            currentSpendCents: 10_000,
        });
        const run = jest.fn();

        const outcome = await service.dispatch(followUp({ rowState: 'open' }), run);
        const { wait } = refused(outcome);

        expect(run).not.toHaveBeenCalled();
        expect(wait.kind).toBe('review_follow_up');
        // An open row stays open while it waits.
        expect(wait.rowState).toBe('open');
    });

    it('leaves every other counter alone: the gate books and writes nothing itself', async () => {
        const { service, usageRepo, alertState, budgetRepo } = makeHarness({
            global: makeBudget(),
            currentSpendCents: 10_000,
        });

        const outcome = await service.dispatch(preparation(), jest.fn());
        const { wait } = refused(outcome);

        // No spend was booked and no budget row was touched: the gate is a
        // read-and-decide, so nothing it does can move another counter.
        expect(usageRepo.record).not.toHaveBeenCalled();
        expect(budgetRepo.create).not.toHaveBeenCalled();
        expect(budgetRepo.update).not.toHaveBeenCalled();
        expect(budgetRepo.delete).not.toHaveBeenCalled();
        // The only rows written are the platform guard's OWN threshold alerts, for
        // this Work's budget — spend at 100% crosses 75/90/100 and nothing else.
        // A gate that wrote its own extra row here would be the second accounting
        // FR-44 forbids.
        expect(alertState.record.mock.calls.map((call) => call[2])).toEqual([
            WorkBudgetAlertThreshold.PERCENT_75,
            WorkBudgetAlertThreshold.PERCENT_90,
            WorkBudgetAlertThreshold.PERCENT_100,
        ]);
        for (const call of alertState.record.mock.calls) {
            expect(call[0]).toBe(WORK_ID);
            expect(call[1]).toBe('budget-1');
        }
        // The wait carries no counter of its own: FR-44 introduces no second
        // spend account, so the key set is the whole of what a refusal reports.
        expect(Object.keys(wait)).toEqual([
            'waiting',
            'code',
            'resetAt',
            'resetAtMs',
            'rowState',
            'kind',
            'scope',
            'pluginId',
            'currentSpendCents',
            'capCents',
            'currency',
        ]);
    });

    it('reports a wait for a run whose own estimate would cross the cap (the pre-flight)', async () => {
        const { service } = makeHarness({
            global: makeBudget({ monthlyCapCents: 10_000, allowOverage: false }),
            currentSpendCents: 9_000,
        });
        const run = jest.fn();

        const outcome = await service.dispatch(preparation({ estimatedCostCents: 5_000 }), run);

        // A single run that would blow the cap is refused before it starts.
        expect(outcome.dispatched).toBe(false);
        expect(run).not.toHaveBeenCalled();
    });
});

describe('APW-09 T44 — the alert fires at the Work’s threshold', () => {
    it('raises the Work threshold alert through the platform guard, naming the capability', async () => {
        const { service, alertState, eventEmitter } = makeHarness({
            global: makeBudget({ monthlyCapCents: 10_000, allowOverage: false }),
            // 80% of the cap: over the 75% threshold, under the cap — so the run
            // is allowed AND the alert fires, which is the pair ACC-09-33 asks for.
            currentSpendCents: 8_000,
        });

        const outcome = await service.dispatch(preparation(), jest.fn().mockResolvedValue('ok'));

        expect(outcome.dispatched).toBe(true);
        expect(alertState.record).toHaveBeenCalledWith(
            WORK_ID,
            'budget-1',
            WorkBudgetAlertThreshold.PERCENT_75,
            expect.any(Date),
        );
        expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
        const [eventName, event] = eventEmitter.emit.mock.calls[0] as [
            string,
            BudgetThresholdCrossedEvent,
        ];
        expect(eventName).toBe(BudgetThresholdCrossedEvent.EVENT_NAME);
        expect(event).toBeInstanceOf(BudgetThresholdCrossedEvent);
        expect(event.threshold).toBe(WorkBudgetAlertThreshold.PERCENT_75);
        expect(event.currentSpendCents).toBe(8_000);
        expect(event.capCents).toBe(10_000);
        // The alert names the contribution capability, so the notice says what the
        // spend was for.
        expect(event.capability).toBe(PluginUsageCapability.UPSTREAM_CONTRIBUTION);
        expect(event.workId).toBe(WORK_ID);
        expect(event.userId).toBe(USER_ID);
    });

    it('does not re-alert a threshold this period already alerted on', async () => {
        const { service, alertState, eventEmitter } = makeHarness({
            global: makeBudget(),
            currentSpendCents: 8_000,
        });
        alertState.record.mockResolvedValue({ inserted: false });

        await service.dispatch(preparation(), jest.fn().mockResolvedValue('ok'));

        expect(alertState.record).toHaveBeenCalledTimes(1);
        // The guard's idempotency is what stops one notice per run.
        expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
});

describe('APW-09 T44 — a run under the cap dispatches exactly once', () => {
    it('runs the thunk exactly once and hands back its result', async () => {
        const { service } = makeHarness({
            global: makeBudget(),
            currentSpendCents: 100,
        });
        const run = jest.fn().mockResolvedValue({ preparationTaskId: 'task-9' });

        const outcome = await service.dispatch(preparation(), run);

        expect(outcome.dispatched).toBe(true);
        expect(run).toHaveBeenCalledTimes(1);
        expect(allowedResult(outcome)).toEqual({ preparationTaskId: 'task-9' });
    });

    it('allows the run when the Work has no budget at all', async () => {
        const { service } = makeHarness({ global: null, plugin: null });
        const run = jest.fn().mockResolvedValue('ran');

        const outcome = await service.dispatch(preparation(), run);

        expect(outcome.dispatched).toBe(true);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('allows the run when the cap permits overage, and still alerts', async () => {
        const { service, eventEmitter } = makeHarness({
            global: makeBudget({ monthlyCapCents: 10_000, allowOverage: true }),
            currentSpendCents: 12_000,
        });

        const outcome = await service.dispatch(preparation(), jest.fn().mockResolvedValue('ran'));

        // allowOverage means warn, never block.
        expect(outcome.dispatched).toBe(true);
        const thresholds = (
            eventEmitter.emit.mock.calls as Array<[string, BudgetThresholdCrossedEvent]>
        ).map(([, event]) => event.threshold);
        expect(thresholds).toContain(WorkBudgetAlertThreshold.PERCENT_100);
        // Spend past the cap on an overage budget is the OVERAGE alert.
        expect(thresholds).toContain(WorkBudgetAlertThreshold.OVERAGE);
    });

    it('books a plugin-scoped cap under the contribution plugin id as well', async () => {
        const { service } = makeHarness({
            global: null,
            plugin: makeBudget({
                id: 'budget-plugin-1',
                scope: WorkBudgetScope.PLUGIN,
                pluginId: UPSTREAM_CONTRIBUTION_PLUGIN_ID,
                monthlyCapCents: 500,
                allowOverage: false,
            }),
            currentSpendCents: 600,
        });
        const run = jest.fn();

        const outcome = await service.dispatch(preparation(), run);
        const { wait } = refused(outcome);

        expect(run).not.toHaveBeenCalled();
        expect(wait.scope).toBe(WorkBudgetScope.PLUGIN);
        expect(wait.pluginId).toBe(UPSTREAM_CONTRIBUTION_PLUGIN_ID);
    });
});

describe('APW-09 T44 — the gate’s own edges', () => {
    it('reports an unbound budget layer as ungated rather than as a passed gate', async () => {
        const service = new UpstreamContributionBudgetService();
        const run = jest.fn().mockResolvedValue('ran');

        expect(await service.book(preparation())).toEqual({ allowed: true, gate: 'ungated' });
        expect((await service.dispatch(preparation(), run)).dispatched).toBe(true);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('never turns a broken budget layer into a wait', async () => {
        const { service, budgetRepo } = makeHarness({ global: makeBudget() });
        budgetRepo.findGlobal.mockRejectedValue(new Error('database is down'));

        await expect(service.book(preparation())).rejects.toThrow('database is down');
    });

    it('computes the same period boundary BudgetService does', () => {
        const { budgets } = makeHarness();
        for (const now of [
            new Date('2026-05-15T12:00:00Z'),
            new Date('2026-12-31T23:59:59Z'),
            new Date('2026-01-01T00:00:00Z'),
        ]) {
            expect(nextPeriodStartUtc(now).toISOString()).toBe(
                budgets.getNextPeriodStart(now).toISOString(),
            );
        }
    });

    it('uses the Work budget’s own capability, plugin id and run kinds', () => {
        expect(UPSTREAM_CONTRIBUTION_CAPABILITY).toBe(PluginUsageCapability.UPSTREAM_CONTRIBUTION);
        expect(PluginUsageCapability.UPSTREAM_CONTRIBUTION).toBe('upstream_contribution');
        expect(UPSTREAM_CONTRIBUTION_RUN_KINDS).toEqual(['preparation', 'review_follow_up']);
        expect(UPSTREAM_CONTRIBUTION_PLUGIN_ID).toBe('app-works-upstream');
        expect(UPSTREAM_BUDGET_WAIT_HTTP_STATUS).toBe(202);
    });

    it('recognises a look-alike BudgetExceededException from a bundled copy', () => {
        const real = new BudgetExceededException({
            workId: WORK_ID,
            scope: WorkBudgetScope.GLOBAL,
            pluginId: null,
            currentSpendCents: 10_000,
            capCents: 10_000,
            currency: 'usd',
        });
        expect(isBudgetExceededLike(real)).toBe(true);

        // The shape a second bundled copy of the class produces: same fields, a
        // different constructor identity.
        const lookAlike = {
            name: 'BudgetExceededException',
            getStatus: () => 402,
            details: { scope: 'global', currentSpendCents: 10_000, capCents: 10_000 },
        };
        expect(isBudgetExceededLike(lookAlike)).toBe(true);

        expect(isBudgetExceededLike(new Error('nope'))).toBe(false);
        expect(isBudgetExceededLike(null)).toBe(false);
        expect(isBudgetExceededLike({ getStatus: () => 500 })).toBe(false);
    });

    it('projects a wait onto the wire shape without inventing fields', () => {
        const response = toUpstreamBudgetWaitResponse({
            waiting: UPSTREAM_BUDGET_WAIT,
            code: UPSTREAM_BUDGET_WAIT_CODE,
            resetAt: NEXT_PERIOD_START,
            resetAtMs: Date.parse(NEXT_PERIOD_START),
            rowState: 'awaiting_approval',
            kind: 'review_follow_up',
            scope: WorkBudgetScope.GLOBAL,
            pluginId: UPSTREAM_CONTRIBUTION_PLUGIN_ID,
            currentSpendCents: 10_000,
            capCents: 10_000,
            currency: 'usd',
        });
        expect(Object.keys(response)).toEqual(['state', 'waiting', 'resetAt', 'code', 'limit']);
        expect(response.state).toBe('awaiting_approval');
    });
});
