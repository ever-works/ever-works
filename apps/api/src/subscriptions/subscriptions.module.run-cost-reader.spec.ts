/**
 * api-side SubscriptionsModule — the run receipt's cost port binding (AW-09).
 *
 * `RunReceiptService` (agent package) reads a run's cost through the
 * `RUN_COST_BREAKDOWN_READER` string token. An unbound or non-global token
 * is invisible to `tsc` and to every unit test, so the binding is pinned
 * here: the token must resolve to the SAME service the Costs dashboard is
 * served by, and it must be exported from this @Global() module.
 *
 * Barrels are stubbed (the posture of `agents/agents.module.spec.ts`) so the
 * decorator metadata can be read without loading the entity graph.
 */
jest.mock('@ever-works/agent/subscriptions', () => ({
    SubscriptionsModule: class SubscriptionsModule {},
    CostsSummaryService: class CostsSummaryService {},
    SeatsService: class SeatsService {},
    RunCostSettlementService: class RunCostSettlementService {},
    PlanRunLimitsService: class PlanRunLimitsService {},
}));
jest.mock('@ever-works/agent/database', () => ({ RUN_COST_SETTLER: 'RUN_COST_SETTLER' }));
jest.mock('@ever-works/agent/agents', () => ({
    RUN_COST_BREAKDOWN_READER: 'RUN_COST_BREAKDOWN_READER',
    RUN_CREDITS_PRECHECK: 'RUN_CREDITS_PRECHECK',
    RUN_PLAN_LIMITS: 'RUN_PLAN_LIMITS',
    SEAT_GUARD: 'SEAT_GUARD',
}));
jest.mock('@src/auth', () => ({ AuthModule: class AuthModule {} }));
jest.mock('./subscriptions.controller', () => ({
    SubscriptionsController: class SubscriptionsController {},
}));
jest.mock('./credits.controller', () => ({ CreditsController: class CreditsController {} }));
jest.mock('./costs.controller', () => ({ CostsController: class CostsController {} }));

import { CostsSummaryService } from '@ever-works/agent/subscriptions';
import { SubscriptionsModule } from './subscriptions.module';

describe('SubscriptionsModule — RUN_COST_BREAKDOWN_READER', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, SubscriptionsModule) ?? [];

    it('binds the receipt cost port to the Costs dashboard service', () => {
        expect(meta('providers')).toContainEqual({
            provide: 'RUN_COST_BREAKDOWN_READER',
            useExisting: CostsSummaryService,
        });
    });

    it('exports the token from the global module and keeps every existing export', () => {
        expect(meta('exports')).toEqual(
            expect.arrayContaining([
                'RUN_COST_SETTLER',
                'RUN_CREDITS_PRECHECK',
                'RUN_PLAN_LIMITS',
                'SEAT_GUARD',
                'RUN_COST_BREAKDOWN_READER',
            ]),
        );
        expect(Reflect.getMetadata('__module:global__', SubscriptionsModule)).toBe(true);
    });
});
