jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({
    WorkBudgetScope: { GLOBAL: 'global', PLUGIN: 'plugin' },
    WorkMemberRole: { VIEWER: 'viewer', MANAGER: 'manager', OWNER: 'owner' },
}));

import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    NotFoundException,
} from '@nestjs/common';
import { BudgetsController } from './budgets.controller';
import { WorkBudgetScope, WorkMemberRole } from '@ever-works/agent/entities';
import type {
    WorkBudgetRepository,
    WorkRepository,
    WorkMemberRepository,
} from '@ever-works/agent/database';

/**
 * EW-602 — BudgetsController is the per-Work CRUD surface for monthly
 * caps. Coverage:
 *   - assertReadAccess on GET (owner OR member)
 *   - assertWriteAccess on POST/PATCH/DELETE (owner OR MANAGER+)
 *   - scope/pluginId invariants on create
 *   - Conflict guard on duplicate global / per-plugin budget
 *   - PATCH no-op when body is empty
 *   - Cross-Work tampering: PATCH/DELETE 404 if budget.workId mismatches
 */

function makeAuth(userId = 'user-1') {
    return { userId } as any;
}

function makeDeps(overrides: Partial<Record<string, any>> = {}) {
    const budgetRepository = {
        findGlobal: jest.fn().mockResolvedValue(null),
        findForPlugin: jest.fn().mockResolvedValue(null),
        findAllForWork: jest.fn().mockResolvedValue([]),
        findById: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn().mockResolvedValue(undefined),
        ...(overrides.budgetRepository ?? {}),
    } as unknown as jest.Mocked<WorkBudgetRepository>;

    const workRepository = {
        findById: jest.fn().mockResolvedValue({ id: 'work-1', userId: 'user-1' }),
        ...(overrides.workRepository ?? {}),
    } as unknown as jest.Mocked<WorkRepository>;

    const workMemberRepository = {
        isMember: jest.fn().mockResolvedValue(false),
        hasRole: jest.fn().mockResolvedValue(false),
        ...(overrides.workMemberRepository ?? {}),
    } as unknown as jest.Mocked<WorkMemberRepository>;

    const controller = new BudgetsController(
        budgetRepository,
        workRepository,
        workMemberRepository,
    );
    return { controller, budgetRepository, workRepository, workMemberRepository };
}

describe('BudgetsController.list', () => {
    it('returns the configured budgets for the Work owner', async () => {
        const budgets = [{ id: 'b1' }, { id: 'b2' }];
        const { controller, budgetRepository } = makeDeps({
            budgetRepository: { findAllForWork: jest.fn().mockResolvedValue(budgets) },
        });
        const result = await controller.list(makeAuth(), 'work-1');
        expect(result).toEqual({ budgets });
        expect(budgetRepository.findAllForWork).toHaveBeenCalledWith('work-1');
    });

    it('allows access to a member who is not the owner', async () => {
        const { controller } = makeDeps({
            workRepository: {
                findById: jest.fn().mockResolvedValue({ id: 'work-1', userId: 'someone-else' }),
            },
            workMemberRepository: { isMember: jest.fn().mockResolvedValue(true) },
        });
        await expect(controller.list(makeAuth('user-1'), 'work-1')).resolves.toEqual({
            budgets: [],
        });
    });

    it('throws ForbiddenException when not owner and not a member', async () => {
        const { controller } = makeDeps({
            workRepository: {
                findById: jest.fn().mockResolvedValue({ id: 'work-1', userId: 'someone-else' }),
            },
            workMemberRepository: { isMember: jest.fn().mockResolvedValue(false) },
        });
        await expect(controller.list(makeAuth('user-1'), 'work-1')).rejects.toBeInstanceOf(
            ForbiddenException,
        );
    });

    it('throws NotFoundException when the work does not exist', async () => {
        const { controller } = makeDeps({
            workRepository: { findById: jest.fn().mockResolvedValue(null) },
        });
        await expect(controller.list(makeAuth(), 'work-1')).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });
});

describe('BudgetsController.create', () => {
    it('creates a global budget with default currency=usd and allowOverage=false', async () => {
        const created = { id: 'b-new' };
        const { controller, budgetRepository } = makeDeps({
            budgetRepository: { create: jest.fn().mockResolvedValue(created) },
        });
        const result = await controller.create(makeAuth(), 'work-1', {
            scope: WorkBudgetScope.GLOBAL,
            monthlyCapCents: 5000,
        } as any);
        expect(result).toEqual({ budget: created });
        expect(budgetRepository.create).toHaveBeenCalledWith({
            workId: 'work-1',
            scope: WorkBudgetScope.GLOBAL,
            pluginId: null,
            monthlyCapCents: 5000,
            allowOverage: false,
            currency: 'usd',
        });
    });

    it('creates a plugin-scoped budget and persists pluginId', async () => {
        const { controller, budgetRepository } = makeDeps({
            budgetRepository: { create: jest.fn().mockResolvedValue({ id: 'b' }) },
        });
        await controller.create(makeAuth(), 'work-1', {
            scope: WorkBudgetScope.PLUGIN,
            pluginId: 'openai',
            monthlyCapCents: 2000,
            allowOverage: true,
            currency: 'eur',
        } as any);
        expect(budgetRepository.create).toHaveBeenCalledWith({
            workId: 'work-1',
            scope: WorkBudgetScope.PLUGIN,
            pluginId: 'openai',
            monthlyCapCents: 2000,
            allowOverage: true,
            currency: 'eur',
        });
    });

    it('rejects scope=GLOBAL with a pluginId', async () => {
        const { controller } = makeDeps();
        await expect(
            controller.create(makeAuth(), 'work-1', {
                scope: WorkBudgetScope.GLOBAL,
                pluginId: 'openai',
                monthlyCapCents: 1000,
            } as any),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects scope=PLUGIN without a pluginId', async () => {
        const { controller } = makeDeps();
        await expect(
            controller.create(makeAuth(), 'work-1', {
                scope: WorkBudgetScope.PLUGIN,
                monthlyCapCents: 1000,
            } as any),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws ConflictException when a global budget already exists', async () => {
        const { controller } = makeDeps({
            budgetRepository: {
                findGlobal: jest.fn().mockResolvedValue({ id: 'existing' }),
            },
        });
        await expect(
            controller.create(makeAuth(), 'work-1', {
                scope: WorkBudgetScope.GLOBAL,
                monthlyCapCents: 5000,
            } as any),
        ).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws ConflictException when a plugin budget already exists for that pluginId', async () => {
        const { controller } = makeDeps({
            budgetRepository: {
                findForPlugin: jest.fn().mockResolvedValue({ id: 'existing' }),
            },
        });
        await expect(
            controller.create(makeAuth(), 'work-1', {
                scope: WorkBudgetScope.PLUGIN,
                pluginId: 'openai',
                monthlyCapCents: 2000,
            } as any),
        ).rejects.toBeInstanceOf(ConflictException);
    });

    it('blocks non-owner non-MANAGER from creating', async () => {
        const { controller } = makeDeps({
            workRepository: {
                findById: jest.fn().mockResolvedValue({ id: 'work-1', userId: 'owner' }),
            },
            workMemberRepository: { hasRole: jest.fn().mockResolvedValue(false) },
        });
        await expect(
            controller.create(makeAuth('user-1'), 'work-1', {
                scope: WorkBudgetScope.GLOBAL,
                monthlyCapCents: 5000,
            } as any),
        ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows a MANAGER member (non-owner) to create', async () => {
        const { controller, workMemberRepository } = makeDeps({
            workRepository: {
                findById: jest.fn().mockResolvedValue({ id: 'work-1', userId: 'owner' }),
            },
            workMemberRepository: { hasRole: jest.fn().mockResolvedValue(true) },
            budgetRepository: { create: jest.fn().mockResolvedValue({ id: 'b' }) },
        });
        await expect(
            controller.create(makeAuth('user-1'), 'work-1', {
                scope: WorkBudgetScope.GLOBAL,
                monthlyCapCents: 5000,
            } as any),
        ).resolves.toBeDefined();
        expect(workMemberRepository.hasRole).toHaveBeenCalledWith(
            'work-1',
            'user-1',
            WorkMemberRole.MANAGER,
        );
    });
});

describe('BudgetsController.update', () => {
    it('updates the cap, overage flag, and currency together', async () => {
        const existing = { id: 'b1', workId: 'work-1', monthlyCapCents: 1000 };
        const updated = { ...existing, monthlyCapCents: 2000, allowOverage: true, currency: 'eur' };
        const { controller, budgetRepository } = makeDeps({
            budgetRepository: {
                findById: jest.fn().mockResolvedValue(existing),
                update: jest.fn().mockResolvedValue(updated),
            },
        });
        const result = await controller.update(makeAuth(), 'work-1', 'b1', {
            monthlyCapCents: 2000,
            allowOverage: true,
            currency: 'eur',
        } as any);
        expect(result).toEqual({ budget: updated });
        expect(budgetRepository.update).toHaveBeenCalledWith('b1', {
            monthlyCapCents: 2000,
            allowOverage: true,
            currency: 'eur',
        });
    });

    it('returns the existing budget unchanged for an empty patch (no DB write)', async () => {
        const existing = { id: 'b1', workId: 'work-1' };
        const { controller, budgetRepository } = makeDeps({
            budgetRepository: { findById: jest.fn().mockResolvedValue(existing) },
        });
        const result = await controller.update(makeAuth(), 'work-1', 'b1', {} as any);
        expect(result).toEqual({ budget: existing });
        expect(budgetRepository.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the budget id does not exist', async () => {
        const { controller } = makeDeps({
            budgetRepository: { findById: jest.fn().mockResolvedValue(null) },
        });
        await expect(
            controller.update(makeAuth(), 'work-1', 'b-missing', {
                monthlyCapCents: 5,
            } as any),
        ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFoundException when budget belongs to a different work (cross-Work tampering guard)', async () => {
        const { controller } = makeDeps({
            budgetRepository: {
                findById: jest.fn().mockResolvedValue({ id: 'b1', workId: 'other-work' }),
            },
        });
        await expect(
            controller.update(makeAuth(), 'work-1', 'b1', { monthlyCapCents: 5 } as any),
        ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('only writes the fields explicitly present in the DTO', async () => {
        const existing = { id: 'b1', workId: 'work-1' };
        const { controller, budgetRepository } = makeDeps({
            budgetRepository: {
                findById: jest.fn().mockResolvedValue(existing),
                update: jest.fn().mockResolvedValue(existing),
            },
        });
        await controller.update(makeAuth(), 'work-1', 'b1', { allowOverage: false } as any);
        expect(budgetRepository.update).toHaveBeenCalledWith('b1', { allowOverage: false });
    });
});

describe('BudgetsController.delete', () => {
    it('deletes a budget that belongs to the work and returns the deleted id', async () => {
        const { controller, budgetRepository } = makeDeps({
            budgetRepository: {
                findById: jest.fn().mockResolvedValue({ id: 'b1', workId: 'work-1' }),
            },
        });
        const result = await controller.delete(makeAuth(), 'work-1', 'b1');
        expect(result).toEqual({ deletedId: 'b1' });
        expect(budgetRepository.delete).toHaveBeenCalledWith('b1');
    });

    it('throws NotFoundException when the budget id does not exist', async () => {
        const { controller } = makeDeps({
            budgetRepository: { findById: jest.fn().mockResolvedValue(null) },
        });
        await expect(controller.delete(makeAuth(), 'work-1', 'b-missing')).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });

    it('throws NotFoundException when budget belongs to a different work', async () => {
        const { controller, budgetRepository } = makeDeps({
            budgetRepository: {
                findById: jest.fn().mockResolvedValue({ id: 'b1', workId: 'other-work' }),
            },
        });
        await expect(controller.delete(makeAuth(), 'work-1', 'b1')).rejects.toBeInstanceOf(
            NotFoundException,
        );
        expect(budgetRepository.delete).not.toHaveBeenCalled();
    });

    it('blocks non-MANAGER members from deleting', async () => {
        const { controller } = makeDeps({
            workRepository: {
                findById: jest.fn().mockResolvedValue({ id: 'work-1', userId: 'owner' }),
            },
            workMemberRepository: { hasRole: jest.fn().mockResolvedValue(false) },
        });
        await expect(controller.delete(makeAuth('user-1'), 'work-1', 'b1')).rejects.toBeInstanceOf(
            ForbiddenException,
        );
    });
});
