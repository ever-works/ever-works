import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SubscriptionsModule } from './subscriptions.module';
import { ENTITIES } from '../database/_entities-inventory';
import { SeatsService } from './billing/seats.service';
import { PaygService } from './billing/payg.service';
import { BillingService } from './billing/billing.service';
import { PlanCreditGrantService } from './credits/plan-credit-grant.service';
import { CreditsSweepService } from './credits/credits-sweep.service';
import { RunCostSettlementService } from './credits/run-cost-settlement.service';

/**
 * Does this module's dependency graph actually RESOLVE?
 *
 * ## Why this exists (a real defect, shipped to `main`)
 *
 * `SeatsService` was added injecting `AgentRepository`. That repository is
 * owned by `AgentsModule` and is deliberately NOT exported by
 * `DatabaseModule` (`_repository-inventory.ts`), so nothing in this module's
 * graph could supply it. Nest fails that at BOOT with
 * "can't resolve dependencies of the SeatsService (…, ?)" — the API does not
 * start at all.
 *
 * It reached `main` because nothing in the suite compiled the graph:
 *
 *  - `subscriptions.module.spec.ts` (the sibling) reads `@Module()`
 *    metadata and the barrel's exports. It asserts a provider is DECLARED,
 *    which is a different question from whether it can be CONSTRUCTED — a
 *    service whose own dependency is missing still appears in that array.
 *  - `seats.service.spec.ts` (and every sibling service spec) constructs the
 *    service by hand with mocks, which by design never consults the module.
 *
 * Both suites were green while the API could not boot. This spec closes that
 * gap: it asks Nest to build the container for real, which is the only check
 * that fails when a dependency is injected but never provided.
 *
 * ## Scope
 *
 * Compiling is the assertion. The individual `get()` calls below are not
 * redundant with it: `compile()` proves the graph is satisfiable, while
 * resolving each money-path service pins that it is actually reachable from
 * this module (a service dropped from `providers` would still compile).
 *
 * Kept hermetic and cheap — in-memory sqlite, `synchronize` — so it can live
 * in the normal unit run rather than an integration lane. It touches no
 * network and no real database.
 */
describe('SubscriptionsModule — dependency graph resolves (boot guard)', () => {
    async function compileModule() {
        return Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: ENTITIES,
                    synchronize: true,
                }),
                SubscriptionsModule,
            ],
        }).compile();
    }

    it('compiles — every injected dependency is provided somewhere in the graph', async () => {
        const moduleRef = await compileModule();
        expect(moduleRef).toBeDefined();
        await moduleRef.close();
    }, 120000);

    it('can construct every money-path service the module exports', async () => {
        const moduleRef = await compileModule();
        try {
            // One entry per service that moves money or gates work. Each
            // `get()` would throw if the service were unreachable or its own
            // dependencies unsatisfiable.
            expect(moduleRef.get(BillingService)).toBeDefined();
            expect(moduleRef.get(PaygService)).toBeDefined();
            // The regression this spec was written for.
            expect(moduleRef.get(SeatsService)).toBeDefined();
            expect(moduleRef.get(PlanCreditGrantService)).toBeDefined();
            expect(moduleRef.get(CreditsSweepService)).toBeDefined();
            expect(moduleRef.get(RunCostSettlementService)).toBeDefined();
        } finally {
            await moduleRef.close();
        }
    }, 120000);
});
