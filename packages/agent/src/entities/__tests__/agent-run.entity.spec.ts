import { getMetadataArgsStorage } from 'typeorm';
import { AgentRun } from '../agent-run.entity';
import { AgentRunLog } from '../agent-run-log.entity';

describe('AgentRun entity', () => {
    const storage = getMetadataArgsStorage();
    const table = storage.tables.find((t) => t.target === AgentRun);
    const columns = storage.columns.filter((c) => c.target === AgentRun);
    const indices = storage.indices.filter((i) => i.target === AgentRun);
    const columnNames = columns.map((c) => c.propertyName);

    it('maps to `agent_runs`', () => {
        expect(table?.name).toBe('agent_runs');
    });

    it('declares trigger + status + timing columns', () => {
        expect(columnNames).toEqual(
            expect.arrayContaining([
                'agentId',
                'userId',
                'triggerKind',
                'status',
                'triggerRunId',
                'startedAt',
                'finishedAt',
                'durationMs',
                'errorMessage',
                'summary',
                'taskId',
                'chatMessageId',
            ]),
        );
    });

    it('declares timeline + status + task + chat indexes', () => {
        expect(indices.some((i) => i.name === 'idx_agent_runs_agent_started')).toBe(true);
        expect(indices.some((i) => i.name === 'idx_agent_runs_status')).toBe(true);
        expect(indices.some((i) => i.name === 'idx_agent_runs_task')).toBe(true);
        expect(indices.some((i) => i.name === 'idx_agent_runs_chat_message')).toBe(true);
    });
});

describe('AgentRunLog entity', () => {
    const storage = getMetadataArgsStorage();
    const table = storage.tables.find((t) => t.target === AgentRunLog);
    const indices = storage.indices.filter((i) => i.target === AgentRunLog);

    it('maps to `agent_run_logs`', () => {
        expect(table?.name).toBe('agent_run_logs');
    });

    it('indexes by (runId, createdAt) and (runId, level)', () => {
        expect(indices.some((i) => i.name === 'idx_agent_run_logs_run_created')).toBe(true);
        expect(indices.some((i) => i.name === 'idx_agent_run_logs_run_level')).toBe(true);
    });
});
