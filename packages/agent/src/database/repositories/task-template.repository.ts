import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { EntityManager } from 'typeorm';
import { Repository } from 'typeorm';
import { TaskTemplate } from '../../entities/task-template.entity';
import { TaskTemplateStep } from '../../entities/task-template-step.entity';

/**
 * Tasks upgrades — repositories for workflow Task Templates.
 *
 * Cross-user reads route through `findByIdAndUser` so the service can
 * 404 instead of leaking existence (house rule, mirrors TaskRepository).
 */
@Injectable()
export class TaskTemplateRepository {
    constructor(
        @InjectRepository(TaskTemplate)
        private readonly repository: Repository<TaskTemplate>,
        @InjectRepository(TaskTemplateStep)
        private readonly steps: Repository<TaskTemplateStep>,
    ) {}

    async findByUserId(userId: string): Promise<TaskTemplate[]> {
        return this.repository.find({ where: { userId }, order: { createdAt: 'ASC' } });
    }

    async countByUserId(userId: string): Promise<number> {
        return this.repository.count({ where: { userId } });
    }

    async findByIdAndUser(id: string, userId: string): Promise<TaskTemplate | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    async findBySlugAndUser(slug: string, userId: string): Promise<TaskTemplate | null> {
        return this.repository.findOne({ where: { slug, userId } });
    }

    async findStepsByTemplateId(templateId: string): Promise<TaskTemplateStep[]> {
        return this.steps.find({ where: { templateId }, order: { position: 'ASC' } });
    }

    /** Batch step lookup for list views — one IN query, grouped by template. */
    async findStepsByTemplateIds(templateIds: string[]): Promise<Map<string, TaskTemplateStep[]>> {
        const out = new Map<string, TaskTemplateStep[]>();
        if (templateIds.length === 0) return out;
        const rows = await this.steps
            .createQueryBuilder('step')
            .where('step.templateId IN (:...templateIds)', { templateIds })
            .orderBy('step.templateId', 'ASC')
            .addOrderBy('step.position', 'ASC')
            .getMany();
        for (const row of rows) {
            const list = out.get(row.templateId) ?? [];
            list.push(row);
            out.set(row.templateId, list);
        }
        return out;
    }

    /**
     * Create a template WITH its steps in one transaction — a template
     * with half its steps is not a usable workflow.
     */
    async createWithSteps(
        template: Partial<TaskTemplate>,
        steps: Partial<TaskTemplateStep>[],
    ): Promise<TaskTemplate> {
        return this.repository.manager.transaction(async (manager) => {
            const created = await manager.save(manager.create(TaskTemplate, template));
            for (const step of steps) {
                await manager.save(
                    manager.create(TaskTemplateStep, { ...step, templateId: created.id }),
                );
            }
            return created;
        });
    }

    async updateById(id: string, patch: Partial<TaskTemplate>): Promise<void> {
        await this.repository.update(id, patch);
    }

    /** Replace the step list wholesale (positions re-derived by caller). */
    async replaceSteps(templateId: string, steps: Partial<TaskTemplateStep>[]): Promise<void> {
        await this.repository.manager.transaction(async (manager) => {
            await manager.delete(TaskTemplateStep, { templateId });
            for (const step of steps) {
                await manager.save(manager.create(TaskTemplateStep, { ...step, templateId }));
            }
        });
    }

    async deleteById(id: string): Promise<void> {
        // Steps cascade via the DB FK; delete explicitly anyway so the
        // sqlite CI schema (where the FK may lack ON DELETE CASCADE
        // enforcement under pragma-off) cannot orphan rows.
        await this.repository.manager.transaction(async (manager) => {
            await manager.delete(TaskTemplateStep, { templateId: id });
            await manager.delete(TaskTemplate, { id });
        });
    }

    /**
     * Run `fn` inside a single DB transaction, handing it the tx-scoped
     * EntityManager. Used by `TaskTemplatesService.instantiateTemplate`
     * so the whole task tree (parent + subtasks + blocks + assignees +
     * approvers) lands or rolls back atomically.
     */
    async withTransaction<T>(fn: (manager: EntityManager) => Promise<T>): Promise<T> {
        return this.repository.manager.transaction(fn);
    }
}
