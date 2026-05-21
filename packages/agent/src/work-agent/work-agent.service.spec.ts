import { BadRequestException } from '@nestjs/common';
import { WorkAgentGoalStatus, WorkAgentRunStatus } from '../entities';
import { DEFAULT_WORK_AGENT_GUARDRAILS, WorkAgentService } from './work-agent.service';

function makeRepo<T extends { id?: string }>() {
    let nextId = 1;
    const rows: T[] = [];

    const repo = {
        rows,
        manager: undefined as any,
        create: jest.fn((input: Partial<T>) => input as T),
        save: jest.fn(async (input: T | T[]) => {
            if (Array.isArray(input)) {
                const saved = [] as T[];
                for (const item of input) {
                    saved.push(await repo.save(item));
                }
                return saved;
            }
            const now = new Date('2026-05-19T00:00:00.000Z');
            const row = {
                ...(input as any),
                id: input.id ?? `id-${nextId++}`,
                createdAt: (input as any).createdAt ?? now,
                updatedAt: now,
            } as T;
            const index = rows.findIndex((existing) => existing.id === row.id);
            if (index >= 0) rows[index] = row;
            else rows.push(row);
            return row;
        }),
        findOne: jest.fn(async ({ where }: any) => {
            return (
                rows.find((row: any) =>
                    Object.entries(where).every(([key, value]) => {
                        if ((value as any)?._type === 'in') {
                            return (value as any)._value.includes(row[key]);
                        }
                        return row[key] === value;
                    }),
                ) ?? null
            );
        }),
        find: jest.fn(async ({ where, order, take }: any = {}) => {
            let result = [...rows];
            if (where) {
                result = result.filter((row: any) =>
                    Object.entries(where).every(([key, value]) => {
                        if ((value as any)?._type === 'in') {
                            return (value as any)._value.includes(row[key]);
                        }
                        return row[key] === value;
                    }),
                );
            }
            if (order?.createdAt === 'DESC') {
                result.sort((a: any, b: any) => Number(b.createdAt) - Number(a.createdAt));
            }
            if (order?.createdAt === 'ASC') {
                result.sort((a: any, b: any) => Number(a.createdAt) - Number(b.createdAt));
            }
            return typeof take === 'number' ? result.slice(0, take) : result;
        }),
    };

    return repo;
}

function makeService() {
    const preferences = makeRepo<any>();
    const goals = makeRepo<any>();
    const runs = makeRepo<any>();
    const logs = makeRepo<any>();
    const manager = {
        getRepository: jest.fn((entity: unknown) => {
            if ((entity as { name?: string }).name === 'WorkAgentGoal') return goals;
            if ((entity as { name?: string }).name === 'WorkAgentRun') return runs;
            if ((entity as { name?: string }).name === 'WorkAgentRunLog') return logs;
            if ((entity as { name?: string }).name === 'WorkAgentPreference') return preferences;
            throw new Error(`Unexpected repository: ${(entity as { name?: string }).name}`);
        }),
    };
    const transaction = jest.fn(async (callback: (manager: any) => unknown) => callback(manager));
    goals.manager = { transaction };
    runs.manager = { transaction };
    logs.manager = { transaction };
    preferences.manager = { transaction };
    const service = new WorkAgentService(
        preferences as any,
        goals as any,
        runs as any,
        logs as any,
    );
    return { service, preferences, goals, runs, logs, transaction };
}

describe('WorkAgentService', () => {
    it('creates disabled default preferences with conservative guardrails', async () => {
        const { service, preferences } = makeService();

        const result = await service.getPreferences('u1');

        expect(result).toEqual({
            enabled: false,
            autoApproveLowImpact: false,
            dailySuggestionsEnabled: true,
            guardrails: DEFAULT_WORK_AGENT_GUARDRAILS,
        });
        expect(preferences.rows).toHaveLength(1);
    });

    it('merges and clamps guardrail updates', async () => {
        const { service } = makeService();

        const result = await service.updatePreferences('u1', {
            enabled: true,
            maxWorksPerRun: 999,
            maxItemsPerWork: 0,
            dryRunByDefault: false,
        });

        expect(result.enabled).toBe(true);
        expect(result.guardrails.maxWorksPerRun).toBe(25);
        expect(result.guardrails.maxItemsPerWork).toBe(1);
        expect(result.guardrails.dryRunByDefault).toBe(false);
        expect(result.guardrails.requireApprovalBeforeCreate).toBe(true);
    });

    it('rejects new goals until the user explicitly enables the Work agent', async () => {
        const { service } = makeService();

        await expect(
            service.createGoal('u1', {
                instruction: 'Create a Work for AI healthcare startups',
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates an approval-ready goal, run, and audit log when enabled', async () => {
        const { service, goals, runs, logs, transaction } = makeService();
        await service.updatePreferences('u1', {
            enabled: true,
            autoApproveLowImpact: true,
            dryRunByDefault: false,
        });

        const result = await service.createGoal('u1', {
            instruction: 'Create a Work for AI healthcare startups',
            maxWorksPerRun: 2,
        });

        expect(result.goal.status).toBe(WorkAgentGoalStatus.WAITING_FOR_APPROVAL);
        expect(result.goal.dryRun).toBe(false);
        expect(result.goal.guardrailsOverride).toEqual({ maxWorksPerRun: 2 });
        expect(result.run.status).toBe(WorkAgentRunStatus.WAITING_FOR_APPROVAL);
        expect(result.run.summary.approvalsRequired).toBe(1);
        expect(result.run.summary.worksPlanned).toBe(1);
        expect(result.run.summary.itemsPlanned).toBe(DEFAULT_WORK_AGENT_GUARDRAILS.maxItemsPerWork);
        expect(goals.rows).toHaveLength(1);
        expect(runs.rows).toHaveLength(1);
        expect(logs.rows).toHaveLength(2);
        expect(logs.rows.map((row) => row.step)).toEqual(['plan-prepared', 'approval-required']);
        expect(transaction).toHaveBeenCalledTimes(1);
    });

    it('cancels active runs for a cancelable goal and records a log entry', async () => {
        const { service, runs, logs, transaction } = makeService();
        await service.updatePreferences('u1', { enabled: true });
        const { goal, run } = await service.createGoal('u1', {
            instruction: 'Create a Work for AI healthcare startups',
        });
        runs.rows[0].status = WorkAgentRunStatus.RESEARCHING;

        const result = await service.cancelGoal('u1', goal.id);

        expect(result.status).toBe(WorkAgentGoalStatus.CANCELED);
        expect(runs.rows.find((row) => row.id === run.id)?.status).toBe(
            WorkAgentRunStatus.CANCELED,
        );
        expect(logs.rows.map((row) => row.step)).toContain('canceled');
        expect(transaction).toHaveBeenCalledTimes(2);
    });

    it('recovers when concurrent preference creation hits a unique constraint', async () => {
        const { service, preferences } = makeService();
        const raced = {
            id: 'existing',
            userId: 'u1',
            enabled: true,
            autoApproveLowImpact: false,
            dailySuggestionsEnabled: true,
            guardrails: DEFAULT_WORK_AGENT_GUARDRAILS,
        };
        preferences.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(raced);
        preferences.save.mockRejectedValueOnce({ code: '23505' });

        const result = await service.getPreferences('u1');

        expect(result.enabled).toBe(true);
        expect(preferences.findOne).toHaveBeenCalledTimes(2);
    });
});
