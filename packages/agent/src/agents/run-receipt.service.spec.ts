import { NotFoundException } from '@nestjs/common';
import type { RunCostBreakdown, RunLedgerRow } from '@ever-works/contracts';
import type { AgentRun } from '../entities/agent-run.entity';
import { KbCitationConsumerType } from '../entities/kb-types';
import { RunReceiptService } from './run-receipt.service';

/**
 * Run receipt (AW-09) — assembly of one run's itemised account.
 *
 * The properties worth pinning: a run the viewer cannot read and a run
 * that does not exist are indistinguishable (both null, never a partial
 * object), the counts use the same step names the session page counts,
 * the cost comes from the cost port untouched, and absent relations are
 * present-but-null keys.
 */
describe('RunReceiptService', () => {
    const USER = 'user-1';
    const RUN_ID = '00000000-0000-4000-8000-0000000000aa';
    const SCOPE = { tenantId: 't1', organizationId: 'o1' };
    const NOW = new Date('2026-09-13T10:00:00.000Z');

    let runs: { findByIdAndUser: jest.Mock };
    let runLogs: { countByRunSteps: jest.Mock };
    let ledger: { toRows: jest.Mock };
    let agents: { getOne: jest.Mock };
    let citations: { listForConsumer: jest.Mock };
    let costs: { getRunCostBreakdown: jest.Mock };
    let service: RunReceiptService;

    const run = {
        id: RUN_ID,
        userId: USER,
        agentId: 'a1',
        status: 'completed',
        costCents: 31,
        totalTokens: 900,
        createdAt: new Date('2026-09-13T09:00:00.000Z'),
        changedFilesCount: 4,
        workspaceMeta: { filesTouched: ['docs/CHANGELOG.md', '', 'package.json'] },
    } as unknown as AgentRun;

    const row = { id: RUN_ID, missionId: null, missionTitle: null } as unknown as RunLedgerRow;
    const cost = { settledCents: 31, lines: [] } as unknown as RunCostBreakdown;

    beforeEach(() => {
        runs = { findByIdAndUser: jest.fn().mockResolvedValue(run) };
        runLogs = {
            countByRunSteps: jest.fn(async (_runId: string, steps: readonly string[]) => {
                if (steps.includes('assistant-message')) return 12;
                if (steps.includes('tool-invocation')) return 5;
                return 0; // capture-truncated
            }),
        };
        ledger = { toRows: jest.fn().mockResolvedValue([row]) };
        agents = { getOne: jest.fn().mockResolvedValue({ id: 'a1' }) };
        citations = { listForConsumer: jest.fn().mockResolvedValue([]) };
        costs = { getRunCostBreakdown: jest.fn().mockResolvedValue(cost) };
        service = new RunReceiptService(
            runs as never,
            runLogs as never,
            ledger as never,
            agents as never,
            citations as never,
            costs as never,
        );
    });

    it('returns null for a run that does not exist', async () => {
        runs.findByIdAndUser.mockResolvedValue(null);

        await expect(service.getReceipt(USER, RUN_ID, SCOPE)).resolves.toBeNull();
        expect(costs.getRunCostBreakdown).not.toHaveBeenCalled();
    });

    it('reads the run under the caller and scope, so a foreign run is simply not found', async () => {
        runs.findByIdAndUser.mockResolvedValue(null);

        await service.getReceipt('someone-else', RUN_ID, SCOPE);

        expect(runs.findByIdAndUser).toHaveBeenCalledWith(RUN_ID, 'someone-else', SCOPE);
    });

    it('returns null (not an error, not a partial receipt) when the Agent is not visible in scope', async () => {
        agents.getOne.mockRejectedValue(new NotFoundException('Agent a1 not found.'));

        await expect(service.getReceipt(USER, RUN_ID, SCOPE)).resolves.toBeNull();
        expect(ledger.toRows).not.toHaveBeenCalled();
    });

    it('rethrows an unexpected failure of the visibility check', async () => {
        agents.getOne.mockRejectedValue(new Error('database down'));

        await expect(service.getReceipt(USER, RUN_ID, SCOPE)).rejects.toThrow('database down');
    });

    it('composes the row, the cost port, the capture counts and the touched files', async () => {
        const receipt = await service.getReceipt(USER, RUN_ID, SCOPE, NOW);

        expect(receipt).toEqual({
            row,
            cost,
            counts: { messages: 12, toolCalls: 5, filesTouched: 2 },
            filesTouched: ['docs/CHANGELOG.md', 'package.json'],
            captureTruncated: false,
            knowledge: [],
        });
        expect(costs.getRunCostBreakdown).toHaveBeenCalledWith(run, NOW);
        expect(runLogs.countByRunSteps).toHaveBeenCalledWith(RUN_ID, [
            'assistant-message',
            'user-message',
        ]);
        expect(runLogs.countByRunSteps).toHaveBeenCalledWith(RUN_ID, ['tool-invocation']);
        expect(runLogs.countByRunSteps).toHaveBeenCalledWith(RUN_ID, ['capture-truncated']);
    });

    it('keeps the "no Mission" keys present with null values', async () => {
        const receipt = await service.getReceipt(USER, RUN_ID, SCOPE, NOW);

        expect(receipt?.row).toHaveProperty('missionId', null);
        expect(receipt?.row).toHaveProperty('missionTitle', null);
    });

    it('flags a run that hit the capture cap', async () => {
        runLogs.countByRunSteps.mockImplementation(async (_id: string, steps: readonly string[]) =>
            steps.includes('capture-truncated') ? 1 : 200,
        );

        const receipt = await service.getReceipt(USER, RUN_ID, SCOPE, NOW);

        expect(receipt?.captureTruncated).toBe(true);
    });

    it('falls back to the workspace diff count when no paths were captured', async () => {
        runs.findByIdAndUser.mockResolvedValue({ ...run, workspaceMeta: null });

        const receipt = await service.getReceipt(USER, RUN_ID, SCOPE, NOW);

        expect(receipt?.filesTouched).toEqual([]);
        expect(receipt?.counts.filesTouched).toBe(4);
    });

    it('lists the Knowledge Base documents cited by exactly this run', async () => {
        citations.listForConsumer.mockResolvedValue([
            {
                documentId: 'doc-1',
                workId: 'w1',
                relevanceScore: 0.82,
                createdAt: new Date('2026-09-13T09:01:00.000Z'),
            },
            {
                documentId: 'doc-2',
                workId: 'w1',
                relevanceScore: null,
                createdAt: new Date('2026-09-13T09:02:00.000Z'),
            },
        ]);

        const receipt = await service.getReceipt(USER, RUN_ID, SCOPE, NOW);

        expect(citations.listForConsumer).toHaveBeenCalledWith(
            KbCitationConsumerType.AGENT_RUN,
            RUN_ID,
        );
        expect(receipt?.knowledge).toEqual([
            {
                documentId: 'doc-1',
                workId: 'w1',
                relevanceScore: 0.82,
                citedAt: '2026-09-13T09:01:00.000Z',
            },
            {
                documentId: 'doc-2',
                workId: 'w1',
                relevanceScore: null,
                citedAt: '2026-09-13T09:02:00.000Z',
            },
        ]);
    });

    it('reads without a scope when none is active', async () => {
        await service.getReceipt(USER, RUN_ID);

        expect(runs.findByIdAndUser).toHaveBeenCalledWith(RUN_ID, USER);
    });
});
