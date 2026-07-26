import { AgentsSkillsTasksImportService } from './agents-skills-tasks-import.service';
import type { ExportedTask } from './agents-skills-tasks-types';

/**
 * Account-transfer whitelist sweep — the v2 payload tail's Task side.
 *
 * Task isolation (`isolationMode`) and the quality-gate settings
 * (`acceptanceChecks`, `maxGateAttempts`) are user-authored settings that
 * previously did NOT round-trip: the tail carried title/status/priority
 * and the recurrence block only, so importing a Task silently reset the
 * isolation override and every curated acceptance check back to
 * "inherit".
 *
 * Import posture, identical to every other imported field:
 *   * `null` is MEANINGFUL (= inherit the Work's value) and is preserved;
 *   * arrays only ever apply when they really are arrays;
 *   * unrecognized enum values and out-of-range budgets are DROPPED —
 *     never defaulted, never clamped — so a hand-edited payload cannot
 *     launder a bogus value into a legitimate-looking setting.
 */
describe('AgentsSkillsTasksImportService — Task settings round-trip', () => {
    function makeSvc() {
        const agentExport = { importOne: jest.fn().mockResolvedValue({}) };
        const skillsService = { create: jest.fn().mockResolvedValue({}) };
        const tasksService = { create: jest.fn().mockResolvedValue({ id: 't-new' }) };
        const svc = new AgentsSkillsTasksImportService(
            agentExport as any,
            skillsService as any,
            tasksService as any,
        );
        return { svc, agentExport, skillsService, tasksService };
    }

    function makeTask(overrides: Partial<ExportedTask> = {}): ExportedTask {
        return {
            __kind: 'task',
            slug: 'T-1',
            title: 'Ship it',
            description: null,
            status: 'todo',
            priority: 'p3',
            labels: null,
            missionSourceId: null,
            ideaSourceId: null,
            workSourceId: null,
            parentTaskSlug: null,
            isRecurring: false,
            recurrenceRule: null,
            recurrenceTimezone: null,
            recurrenceEndsAt: null,
            recurrenceMaxOccurrences: null,
            parentRecurringTaskSlug: null,
            assignees: [],
            reviewers: [],
            approvers: [],
            requireAllApprovers: true,
            createdAt: '2026-07-01T00:00:00.000Z',
            ...overrides,
        };
    }

    const CHECKS = [
        {
            id: 'build',
            name: 'Build',
            kind: 'build' as const,
            command: 'pnpm build',
            required: true,
        },
    ];

    it('applies isolationMode, acceptanceChecks and maxGateAttempts', async () => {
        const { svc, tasksService } = makeSvc();

        const summary = await svc.importTail(
            'u1',
            {
                tasks: [
                    makeTask({
                        isolationMode: 'on',
                        acceptanceChecks: CHECKS,
                        maxGateAttempts: 4,
                    }),
                ],
            },
            { importTasks: true },
        );

        expect(summary.tasks.imported).toBe(1);
        expect(tasksService.create).toHaveBeenCalledWith(
            'u1',
            expect.objectContaining({
                isolationMode: 'on',
                acceptanceChecks: CHECKS,
                maxGateAttempts: 4,
            }),
        );
    });

    it('preserves an explicit null (= inherit the Work setting)', async () => {
        const { svc, tasksService } = makeSvc();

        await svc.importTail(
            'u1',
            {
                tasks: [
                    makeTask({
                        isolationMode: null,
                        acceptanceChecks: null,
                        maxGateAttempts: null,
                    }),
                ],
            },
            { importTasks: true },
        );

        const input = tasksService.create.mock.calls[0][1];
        expect(input.isolationMode).toBeNull();
        expect(input.acceptanceChecks).toBeNull();
        expect(input.maxGateAttempts).toBeNull();
    });

    it('drops an unrecognized isolationMode instead of defaulting it', async () => {
        const { svc, tasksService } = makeSvc();

        await svc.importTail(
            'u1',
            { tasks: [makeTask({ isolationMode: 'always-on' as any })] },
            { importTasks: true },
        );

        expect('isolationMode' in tasksService.create.mock.calls[0][1]).toBe(false);
    });

    it('drops a non-array acceptanceChecks value', async () => {
        const { svc, tasksService } = makeSvc();

        await svc.importTail(
            'u1',
            { tasks: [makeTask({ acceptanceChecks: 'pnpm build' as any })] },
            { importTasks: true },
        );

        expect('acceptanceChecks' in tasksService.create.mock.calls[0][1]).toBe(false);
    });

    it('drops an out-of-range maxGateAttempts rather than clamping it', async () => {
        const { svc, tasksService } = makeSvc();

        await svc.importTail(
            'u1',
            { tasks: [makeTask({ maxGateAttempts: 99 })] },
            { importTasks: true },
        );

        expect('maxGateAttempts' in tasksService.create.mock.calls[0][1]).toBe(false);
    });

    it('omits all three for a pre-sweep payload that never carried them', async () => {
        const { svc, tasksService } = makeSvc();

        await svc.importTail('u1', { tasks: [makeTask()] }, { importTasks: true });

        const input = tasksService.create.mock.calls[0][1];
        expect('isolationMode' in input).toBe(false);
        expect('acceptanceChecks' in input).toBe(false);
        expect('maxGateAttempts' in input).toBe(false);
    });
});
