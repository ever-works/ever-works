jest.mock('@ever-works/agent/tasks-domain', () => ({
    TasksService: class {},
    TaskChatService: class {},
    TaskReviewRejectionService: class {},
    TaskWorkspaceService: class {},
    TaskPrStatusService: class {},
    TaskBoardService: class {},
    TaskStatus: { TODO: 'todo', IN_PROGRESS: 'in_progress' },
    TaskPriority: { P3: 'p3' },
    RUN_BATCH_MAX_TASKS: 20,
}));
jest.mock('@ever-works/agent/database', () => ({
    PluginUsageRepository: class {},
    AgentRepository: class {},
    ownershipScopeOf: (row: { tenantId?: string | null; organizationId?: string | null }) => ({
        tenantId: row.tenantId ?? null,
        organizationId: row.organizationId ?? null,
    }),
}));
jest.mock('@ever-works/agent/services', () => ({ DecisionConflictService: class {} }));
jest.mock('@ever-works/agent/activity-log', () => ({ ActivityLogService: class {} }));
jest.mock('@ever-works/agent/agents', () => ({ AgentEscalationService: class {} }));

import { Test } from '@nestjs/testing';
import {
    TaskBoardService,
    TaskChatService,
    TaskPrStatusService,
    TaskReviewRejectionService,
    TasksService,
    TaskWorkspaceService,
} from '@ever-works/agent/tasks-domain';
import { AgentRepository, PluginUsageRepository } from '@ever-works/agent/database';
import { DecisionConflictService } from '@ever-works/agent/services';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { AgentEscalationService } from '@ever-works/agent/agents';
import { ScopeContextService } from '../scope/scope-context.service';
import { TasksController } from './tasks.controller';

/**
 * Task board — scope isolation at the API boundary, modelled on
 * `tasks.controller.scope.spec.ts`.
 *
 * The board must answer for exactly one owner in exactly one scope: the
 * authenticated user and the ACTIVE request scope, never an id the query
 * string could carry. The rows-and-counts half of the guarantee (another
 * user's Task is in no column and no count; another Organization's likewise)
 * is proven against a real database in the agent package's
 * `task-board.integration.spec.ts`; this spec proves the controller hands the
 * service nothing else to scope by, through the real Nest DI wiring.
 */
describe('TasksController — Task board scope', () => {
    const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const auth = { userId } as never;
    const everScope = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        organizationId: '22222222-2222-4222-8222-222222222222',
    };
    const emptyColumn = {
        key: 'todo',
        statuses: ['todo'],
        total: 0,
        cards: [],
        offset: 0,
        limit: 50,
        failed: false,
    };

    async function build(activeScope: { tenantId: string | null; organizationId: string | null }) {
        const board = {
            getBoard: jest.fn().mockResolvedValue({
                layout: 'status',
                columns: [emptyColumn],
                columnLimit: 50,
                terminalWindowDays: 7,
            }),
            getColumn: jest.fn().mockResolvedValue(emptyColumn),
        };
        const moduleRef = await Test.createTestingModule({
            controllers: [TasksController],
            providers: [
                { provide: TasksService, useValue: {} },
                { provide: TaskChatService, useValue: {} },
                { provide: PluginUsageRepository, useValue: {} },
                { provide: AgentRepository, useValue: {} },
                { provide: TaskWorkspaceService, useValue: {} },
                { provide: DecisionConflictService, useValue: {} },
                { provide: TaskReviewRejectionService, useValue: {} },
                { provide: AgentEscalationService, useValue: {} },
                { provide: TaskPrStatusService, useValue: {} },
                { provide: ScopeContextService, useValue: { getScope: () => activeScope } },
                { provide: ActivityLogService, useValue: {} },
                { provide: TaskBoardService, useValue: board },
            ],
        }).compile();
        return { controller: moduleRef.get(TasksController), board };
    }

    it('reads the board for the authenticated user in the exact active Organization scope', async () => {
        const { controller, board } = await build(everScope);
        await controller.board(auth, {});
        expect(board.getBoard).toHaveBeenCalledWith(userId, expect.any(Object), everScope);
    });

    it('pages a column for the authenticated user in the exact active scope', async () => {
        const { controller, board } = await build(everScope);
        await controller.boardColumn(auth, { column: 'todo', offset: '50' });
        expect(board.getColumn).toHaveBeenCalledWith(
            userId,
            expect.any(Object),
            'todo',
            50,
            everScope,
        );
    });

    it('reads the personal board with the personal scope, not an Organization', async () => {
        const personal = { tenantId: everScope.tenantId, organizationId: null };
        const { controller, board } = await build(personal);
        await controller.board(auth, {});
        expect(board.getBoard.mock.calls[0][2]).toEqual(personal);
    });

    it('carries no owner or scope id from the query string into the service', async () => {
        const { controller, board } = await build(everScope);
        await controller.board(auth, {
            // Not board query fields — the DTO whitelist rejects them at the
            // pipe; even if one slipped through it must not reach the read.
            userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            organizationId: '33333333-3333-4333-8333-333333333333',
            tenantId: '44444444-4444-4444-8444-444444444444',
        } as never);
        const input = board.getBoard.mock.calls[0][1];
        expect(input).not.toHaveProperty('userId');
        expect(input).not.toHaveProperty('organizationId');
        expect(input).not.toHaveProperty('tenantId');
        expect(board.getBoard.mock.calls[0][0]).toBe(userId);
    });

    it('returns a foreign column as the same empty shape as an empty one — no total leaks', async () => {
        const { controller } = await build(everScope);
        await expect(controller.boardColumn(auth, { column: 'todo' })).resolves.toEqual(
            emptyColumn,
        );
    });
});
