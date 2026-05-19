import {
    BadRequestException,
    Body,
    ConflictException,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    NotFoundException,
    Param,
    Patch,
    Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
    WorkBudgetRepository,
    WorkRepository,
    WorkMemberRepository,
} from '@ever-works/agent/database';
import { WorkBudgetScope, WorkMemberRole } from '@ever-works/agent/entities';
import { CurrentUser } from '@src/auth/decorators/user.decorator';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';
import { CreateBudgetDto, UpdateBudgetDto } from './dto/budget.dto';

/**
 * EW-602 — CRUD for per-Work monthly budgets.
 *   GET    /api/works/:workId/budgets         — VIEWER+
 *   POST   /api/works/:workId/budgets         — MANAGER+
 *   PATCH  /api/works/:workId/budgets/:id     — MANAGER+
 *   DELETE /api/works/:workId/budgets/:id     — MANAGER+
 *
 * Read-side aggregations (current spend, per-plugin breakdown, daily
 * trend) live on UsageController; this controller only manages the
 * cap rows themselves.
 */
@ApiTags('Budgets')
@Controller('api/works/:workId/budgets')
export class BudgetsController {
    constructor(
        private readonly budgetRepository: WorkBudgetRepository,
        private readonly workRepository: WorkRepository,
        private readonly workMemberRepository: WorkMemberRepository,
    ) {}

    @Get()
    @ApiOperation({ summary: 'EW-602: list all budgets configured for a Work' })
    async list(@CurrentUser() auth: AuthenticatedUser, @Param('workId') workId: string) {
        await this.assertReadAccess(workId, auth.userId);
        const budgets = await this.budgetRepository.findAllForWork(workId);
        return { budgets };
    }

    @Post()
    @ApiOperation({ summary: 'EW-602: create a global or plugin-scoped budget' })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('workId') workId: string,
        @Body() dto: CreateBudgetDto,
    ) {
        await this.assertWriteAccess(workId, auth.userId);

        if (dto.scope === WorkBudgetScope.GLOBAL && dto.pluginId) {
            throw new BadRequestException('pluginId must be omitted when scope = global');
        }
        if (dto.scope === WorkBudgetScope.PLUGIN && !dto.pluginId) {
            throw new BadRequestException('pluginId is required when scope = plugin');
        }

        const existing =
            dto.scope === WorkBudgetScope.GLOBAL
                ? await this.budgetRepository.findGlobal(workId)
                : await this.budgetRepository.findForPlugin(workId, dto.pluginId!);
        if (existing) {
            throw new ConflictException(
                dto.scope === WorkBudgetScope.GLOBAL
                    ? 'A global budget already exists for this Work — patch it instead.'
                    : `A budget for plugin '${dto.pluginId}' already exists for this Work — patch it instead.`,
            );
        }

        const created = await this.budgetRepository.create({
            workId,
            scope: dto.scope,
            pluginId: dto.scope === WorkBudgetScope.PLUGIN ? dto.pluginId : null,
            monthlyCapCents: dto.monthlyCapCents,
            allowOverage: dto.allowOverage ?? false,
            currency: dto.currency ?? 'usd',
        });
        return { budget: created };
    }

    @Patch(':budgetId')
    @ApiOperation({ summary: 'EW-602: update an existing budget cap or overage flag' })
    async update(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('workId') workId: string,
        @Param('budgetId') budgetId: string,
        @Body() dto: UpdateBudgetDto,
    ) {
        await this.assertWriteAccess(workId, auth.userId);

        const budget = await this.budgetRepository.findById(budgetId);
        if (!budget || budget.workId !== workId) {
            throw new NotFoundException(`Budget ${budgetId} not found on work ${workId}`);
        }

        const patch: Partial<typeof budget> = {};
        if (dto.monthlyCapCents !== undefined) patch.monthlyCapCents = dto.monthlyCapCents;
        if (dto.allowOverage !== undefined) patch.allowOverage = dto.allowOverage;
        if (dto.currency !== undefined) patch.currency = dto.currency;

        if (Object.keys(patch).length === 0) {
            return { budget };
        }

        const updated = await this.budgetRepository.update(budgetId, patch);
        return { budget: updated };
    }

    @Delete(':budgetId')
    @ApiOperation({ summary: 'EW-602: delete a budget — removes its cap and any future alerts' })
    async delete(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('workId') workId: string,
        @Param('budgetId') budgetId: string,
    ) {
        await this.assertWriteAccess(workId, auth.userId);

        const budget = await this.budgetRepository.findById(budgetId);
        if (!budget || budget.workId !== workId) {
            throw new NotFoundException(`Budget ${budgetId} not found on work ${workId}`);
        }

        await this.budgetRepository.delete(budgetId);
        return { deletedId: budgetId };
    }

    private async assertReadAccess(workId: string, userId: string): Promise<void> {
        const work = await this.workRepository.findById(workId);
        if (!work) {
            throw new NotFoundException(`Work ${workId} not found`);
        }
        if (work.userId === userId) {
            return;
        }
        const isMember = await this.workMemberRepository.isMember(workId, userId);
        if (!isMember) {
            throw new ForbiddenException(`User does not have access to work ${workId}`);
        }
    }

    private async assertWriteAccess(workId: string, userId: string): Promise<void> {
        const work = await this.workRepository.findById(workId);
        if (!work) {
            throw new NotFoundException(`Work ${workId} not found`);
        }
        if (work.userId === userId) {
            return;
        }
        const hasManagerRole = await this.workMemberRepository.hasRole(
            workId,
            userId,
            WorkMemberRole.MANAGER,
        );
        if (!hasManagerRole) {
            throw new ForbiddenException(
                `User must be the Work owner or have MANAGER role to mutate budgets`,
            );
        }
    }
}
