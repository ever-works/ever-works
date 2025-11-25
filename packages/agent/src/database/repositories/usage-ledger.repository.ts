import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
    UsageLedgerEntry,
    UsageLedgerStatus,
    UsageLedgerTriggerType,
} from '@src/entities/usage-ledger-entry.entity';

@Injectable()
export class UsageLedgerRepository {
    constructor(
        @InjectRepository(UsageLedgerEntry)
        private readonly repository: Repository<UsageLedgerEntry>,
    ) {}

    async record(entry: Partial<UsageLedgerEntry>): Promise<UsageLedgerEntry> {
        const created = this.repository.create(entry);
        return this.repository.save(created);
    }

    async findPendingByUser(userId: string): Promise<UsageLedgerEntry[]> {
        return this.repository.find({
            where: { userId, status: UsageLedgerStatus.PENDING },
            order: { createdAt: 'ASC' },
        });
    }

    async markQueued(ids: string[]): Promise<void> {
        if (!ids.length) {
            return;
        }

        await this.repository
            .createQueryBuilder()
            .update(UsageLedgerEntry)
            .set({ status: UsageLedgerStatus.QUEUED_FOR_SETTLEMENT })
            .whereInIds(ids)
            .execute();
    }

    async getUsageSummary(
        userId: string,
        triggerType: UsageLedgerTriggerType,
    ): Promise<{ totalUnits: number; totalAmountCents: number }> {
        const entries = await this.repository.find({
            where: { userId, triggerType },
            select: ['units', 'amountCents'],
        });

        return entries.reduce(
            (acc, entry) => {
                acc.totalUnits += entry.units || 0;
                acc.totalAmountCents += entry.amountCents || 0;
                return acc;
            },
            { totalUnits: 0, totalAmountCents: 0 },
        );
    }
}
