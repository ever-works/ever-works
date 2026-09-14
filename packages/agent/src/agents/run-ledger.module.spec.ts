import { Test } from '@nestjs/testing';
import { AgentRunLogRepository } from '../database/repositories/agent-run-log.repository';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { WorkKnowledgeCitationRepository } from '../database/repositories/work-knowledge-citation.repository';
import { AgentsModule } from './agents.module';
import { AgentsService } from './agents.service';
import { RUN_COST_BREAKDOWN_READER } from './run-cost-breakdown-reader';
import { RunLedgerModule } from './run-ledger.module';
import { RunLedgerService } from './run-ledger.service';
import { RunReceiptService } from './run-receipt.service';

/**
 * Runs ledger (AW-09) — module shape and dependency resolution.
 *
 * The receipt reads cost through a string token, which `tsc` cannot check
 * and a plain unit test never resolves. This spec compiles both services in
 * a Nest testing module against their declared dependencies, and pins the
 * module metadata the api-side RunsModule relies on.
 */
describe('RunLedgerModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, RunLedgerModule) ?? [];

    it('imports the agent module and exports only the two read services', () => {
        expect(meta('imports')).toContain(AgentsModule);
        expect(meta('exports')).toEqual([RunLedgerService, RunReceiptService]);
        expect(meta('providers')).toEqual(
            expect.arrayContaining([
                WorkKnowledgeCitationRepository,
                RunLedgerService,
                RunReceiptService,
            ]),
        );
    });

    it('resolves both services, including the cost port token, in a Nest testing module', async () => {
        const costs = { getRunCostBreakdown: jest.fn() };
        const moduleRef = await Test.createTestingModule({
            providers: [
                RunLedgerService,
                RunReceiptService,
                { provide: AgentRunRepository, useValue: {} },
                { provide: AgentRunLogRepository, useValue: {} },
                { provide: AgentsService, useValue: {} },
                { provide: WorkKnowledgeCitationRepository, useValue: {} },
                { provide: RUN_COST_BREAKDOWN_READER, useValue: costs },
            ],
        }).compile();

        expect(moduleRef.get(RunLedgerService)).toBeInstanceOf(RunLedgerService);
        const receipts = moduleRef.get(RunReceiptService);
        expect(receipts).toBeInstanceOf(RunReceiptService);
        expect((receipts as unknown as { costs: unknown }).costs).toBe(costs);
    });

    it('fails fast when the cost port is not bound, instead of serving receipts without cost', async () => {
        await expect(
            Test.createTestingModule({
                providers: [
                    RunLedgerService,
                    RunReceiptService,
                    { provide: AgentRunRepository, useValue: {} },
                    { provide: AgentRunLogRepository, useValue: {} },
                    { provide: AgentsService, useValue: {} },
                    { provide: WorkKnowledgeCitationRepository, useValue: {} },
                ],
            }).compile(),
        ).rejects.toThrow(/RUN_COST_BREAKDOWN_READER/);
    });
});
