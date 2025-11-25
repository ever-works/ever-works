import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SubscriptionPlan, SubscriptionPlanCode } from '@src/entities';

@Injectable()
export class SubscriptionPlanRepository {
    constructor(
        @InjectRepository(SubscriptionPlan)
        private readonly repository: Repository<SubscriptionPlan>,
    ) {}

    async findAllActive(): Promise<SubscriptionPlan[]> {
        return this.repository.find({ where: { active: true } });
    }

    async findByCode(code: SubscriptionPlanCode): Promise<SubscriptionPlan | null> {
        return this.repository.findOne({ where: { code } });
    }

    async upsert(plan: Partial<SubscriptionPlan>): Promise<SubscriptionPlan> {
        let existing = plan.code ? await this.findByCode(plan.code as SubscriptionPlanCode) : null;

        if (existing) {
            await this.repository.update(existing.id, plan);
            return this.repository.findOne({ where: { id: existing.id } });
        }

        const created = this.repository.create(plan);
        return this.repository.save(created);
    }
}
