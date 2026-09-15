import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkKnowledgeCitation } from '../entities/work-knowledge-citation.entity';
import { WorkKnowledgeCitationRepository } from '../database/repositories/work-knowledge-citation.repository';
import { AgentsModule } from './agents.module';
import { RunLedgerService } from './run-ledger.service';
import { RunReceiptService } from './run-receipt.service';

/**
 * Runs ledger + run receipt (AW-09) — a read-only module over rows other
 * modules already own. It adds no entity and no write path.
 *
 * - `AgentsModule` supplies the run + run-log repositories and the Agent
 *   visibility check the session-detail endpoint also uses.
 * - `RUN_COST_BREAKDOWN_READER` is bound by the api-side `@Global()`
 *   SubscriptionsModule to `CostsSummaryService`, the single producer of
 *   cost figures for both the Costs dashboard and a receipt. It is a token
 *   rather than an import so this module (re-exported through the agents
 *   barrel) never drags the billing module graph into that barrel.
 * - The KB citation repository is provided locally (the same posture
 *   `TerminalTranscriptModule` takes for its repositories) so a read of
 *   one table does not pull the whole Knowledge Base service graph in.
 */
@Module({
    imports: [AgentsModule, TypeOrmModule.forFeature([WorkKnowledgeCitation])],
    providers: [WorkKnowledgeCitationRepository, RunLedgerService, RunReceiptService],
    exports: [RunLedgerService, RunReceiptService],
})
export class RunLedgerModule {}
