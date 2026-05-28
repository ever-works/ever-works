import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { TenantEmailAddress, EmailAddressDirection } from '../../entities';

/**
 * Notifications v2 — Email Providers (EW-650, EW-667).
 *
 * Repository for `tenant_email_addresses`. Single-tenant per `userId`
 * in v1 (spec §8); multi-tenant ownership lands later.
 */
@Injectable()
export class TenantEmailAddressRepository {
    constructor(
        @InjectRepository(TenantEmailAddress)
        private readonly repository: Repository<TenantEmailAddress>,
    ) {}

    create(entry: Partial<TenantEmailAddress>): TenantEmailAddress {
        return this.repository.create(entry);
    }

    async save(entry: TenantEmailAddress): Promise<TenantEmailAddress> {
        return this.repository.save(entry);
    }

    async findById(id: string): Promise<TenantEmailAddress | null> {
        return this.repository.findOne({ where: { id } });
    }

    async findByIdForUser(id: string, userId: string): Promise<TenantEmailAddress | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    /** Active (non-disabled) addresses owned by this user. */
    async findActiveByUser(
        userId: string,
        direction?: EmailAddressDirection,
    ): Promise<TenantEmailAddress[]> {
        const where: Record<string, unknown> = { userId, disabledAt: IsNull() };
        if (direction) {
            where.direction = direction;
        }
        return this.repository.find({ where, order: { createdAt: 'ASC' } });
    }

    async findByVerificationToken(token: string): Promise<TenantEmailAddress | null> {
        return this.repository.findOne({ where: { verificationToken: token } });
    }

    async update(id: string, patch: Partial<TenantEmailAddress>): Promise<void> {
        await this.repository.update({ id }, patch);
    }

    async delete(id: string, userId: string): Promise<void> {
        await this.repository.delete({ id, userId });
    }
}
