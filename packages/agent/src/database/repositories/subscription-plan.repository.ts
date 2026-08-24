import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SubscriptionPlan } from '@src/entities/subscription-plan.entity';
import { SubscriptionPlanCode } from '@src/entities/types';
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
        if (plan.code) {
            // API replicas seed the same catalog concurrently during rolling starts.
            // A find-then-save sequence lets both replicas observe a missing code and
            // makes one lose the UNIQUE(code) race inside onModuleInit. Let the database
            // resolve that conflict atomically on every supported driver instead.
            await this.repository.upsert(plan, { conflictPaths: ['code'] });
            const persisted = await this.findByCode(plan.code as SubscriptionPlanCode);
            if (!persisted) {
                throw new Error(`Subscription plan ${plan.code} missing after upsert`);
            }
            return persisted;
        }

        const created = this.repository.create(plan);
        return this.repository.save(created);
    }
}
