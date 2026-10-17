import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import {
    TenantEmailAddress,
    EmailAddressDirection,
} from '../../entities/tenant-email-address.entity';
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

    /**
     * @internal Trusted-internal lookup — no ownership check.
     * Callers MUST have already validated that the requesting user owns the
     * record (e.g. via {@link findByIdForUser}) OR be operating on a row
     * resolved from an unguessable token (verificationToken). Do NOT call
     * this from a request-scoped context without a prior ownership gate.
     */
    async findById(id: string): Promise<TenantEmailAddress | null> {
        return this.repository.findOne({ where: { id } });
    }

    async findByIdForUser(id: string, userId: string): Promise<TenantEmailAddress | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    /** Active (non-disabled) addresses owned by this user. */
    /**
     * EW-P4-3 — every address of the user, disabled ones included (the
     * settings page, where a disabled address can be enabled again). Sending
     * and receiving keep using {@link findActiveByUser}.
     */
    async findAllByUser(
        userId: string,
        direction?: EmailAddressDirection,
    ): Promise<TenantEmailAddress[]> {
        const where: Record<string, unknown> = { userId };
        if (direction) {
            where.direction = direction;
        }
        return this.repository.find({ where, order: { createdAt: 'ASC' } });
    }

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

    /**
     * Resolve an active address row by its literal mailbox — used by the
     * inbound-email dispatcher (EW-670 / T25) to map a webhook recipient
     * to its tenant address. Returns the first non-disabled match; an
     * address that handles both directions matches an inbound lookup via
     * the `direction IN ('inbound','both')` filter the caller supplies.
     */
    async findByAddress(
        address: string,
        directions: readonly EmailAddressDirection[] = ['inbound', 'both'],
    ): Promise<TenantEmailAddress | null> {
        const rows = await this.repository.find({
            where: { address, disabledAt: IsNull() },
            order: { createdAt: 'ASC' },
        });
        return rows.find((r) => directions.includes(r.direction)) ?? null;
    }

    async findByVerificationToken(token: string): Promise<TenantEmailAddress | null> {
        return this.repository.findOne({ where: { verificationToken: token } });
    }

    /**
     * @internal Trusted-internal update — no ownership check.
     * Callers MUST have already validated ownership before invoking this
     * method (e.g. via {@link findByIdForUser} or a prior
     * {@link findByVerificationToken} resolution). Do NOT call this from a
     * request-scoped context without a prior ownership gate.
     */
    async update(id: string, patch: Partial<TenantEmailAddress>): Promise<void> {
        await this.repository.update({ id }, patch);
    }

    /**
     * EW-P4-3 — claim the right to send a confirmation email now: stamps
     * `verificationSentAt = sentAt` only when no email was sent at or after
     * `notBefore` (compare-and-set), so concurrent requests send one email.
     * Answers whether this caller won. Trusted-internal, like {@link update}:
     * the caller has already checked ownership.
     */
    async claimVerificationSend(id: string, notBefore: Date, sentAt: Date): Promise<boolean> {
        // An explicit query builder with object conditions (TypeORM quotes the
        // camelCase columns): `Repository.update` treats an ARRAY criteria as a
        // list of primary keys in some TypeORM versions, which would drop the
        // `verificationSentAt` condition and defeat the compare-and-set.
        const result = await this.repository
            .createQueryBuilder()
            .update(TenantEmailAddress)
            .set({ verificationSentAt: sentAt })
            .where({ id, verificationSentAt: IsNull() })
            .orWhere({ id, verificationSentAt: LessThan(notBefore) })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    async delete(id: string, userId: string): Promise<void> {
        await this.repository.delete({ id, userId });
    }
}
