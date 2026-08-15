import { Global, Module } from '@nestjs/common';
import { AuthModule } from '@src/auth';
import {
    SubscriptionsModule as AgentSubscriptionsModule,
    RunCostSettlementService,
} from '@ever-works/agent/subscriptions';
import { RUN_COST_SETTLER } from '@ever-works/agent/database';
import { RUN_CREDITS_PRECHECK } from '@ever-works/agent/agents';
import { SubscriptionsController } from './subscriptions.controller';
import { CreditsController } from './credits.controller';
import { CostsController } from './costs.controller';

/**
 * Pricing Wave 9 M2 — @Global() for the same reason as the api-side
 * AgentsModule / TasksModule: the token bindings below are consumed by
 * @Optional() @Inject() sites that live in OTHER agent-package modules
 * (`AgentRunRepository` — provided in both DatabaseModule and the
 * agent-side AgentsModule — fires RUN_COST_SETTLER after every terminal
 * transition; `RunDispatchGateService` in AgentsModule consults
 * RUN_CREDITS_PRECHECK). Without @Global() those optional injections
 * silently resolve to undefined in production while every unit test
 * passes.
 */
@Global()
@Module({
    imports: [AuthModule, AgentSubscriptionsModule],
    // CreditsController (pricing Wave 9 M1) — read-only credits surface
    // beside the existing plan endpoints; consumed by the Wave 13 UI.
    // CostsController — the Costs dashboard aggregations
    // (`GET /api/usage/costs/*`); reads the same metering rows as
    // CreditsController's usage summary, on a rolling 7/30/90-day window.
    controllers: [SubscriptionsController, CreditsController, CostsController],
    providers: [
        // Wave 9 M2 — metering → credits debit hook (run terminal writes)
        // + the dispatch gate's soft enforcement precheck. One service
        // instance behind both tokens (useExisting keeps it a singleton).
        { provide: RUN_COST_SETTLER, useExisting: RunCostSettlementService },
        { provide: RUN_CREDITS_PRECHECK, useExisting: RunCostSettlementService },
    ],
    exports: [RUN_COST_SETTLER, RUN_CREDITS_PRECHECK],
})
export class SubscriptionsModule {}
