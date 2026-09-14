import { Module } from '@nestjs/common';
import { RunLedgerModule } from '@ever-works/agent/agents';
import { AuthModule } from '@src/auth';
import { RunsController } from './runs.controller';

/**
 * Runs ledger + run receipt (AW-09) — `GET /api/runs*`.
 *
 * A thin HTTP shell over the agent-side `RunLedgerModule`, the same split the
 * Costs dashboard uses (read model in `packages/agent`, controller here), so
 * other callers can reuse the ledger without a second implementation. The
 * receipt's cost port (`RUN_COST_BREAKDOWN_READER`) is bound by the
 * `@Global()` SubscriptionsModule.
 */
@Module({
    imports: [AuthModule, RunLedgerModule],
    controllers: [RunsController],
})
export class RunsModule {}
