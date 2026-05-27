import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantRepository, UserRepository } from '@ever-works/agent/database';
import type { Tenant } from '@ever-works/agent/entities';
import { UsernameAllocatorService } from '../users/services/username-allocator.service';

/**
 * EW-658 (Tenants & Organizations Phase 6) — lazy Tenant creation for
 * the "first Organization" flow described in [spec.md §5.2](../../../../docs/specs/features/tenants-and-organizations/spec.md#52-user-creates-their-first-organization).
 *
 * Every user has at most one Tenant (1:1 via `tenants.ownerUserId
 * UNIQUE`). Tenants are NOT created at user signup — they're created
 * on demand the first time the user does something that requires one
 * (today: creating their first Organization; later phases may add
 * other triggers like accepting an Org invite).
 *
 * `ensureTenant(userId)` is idempotent: if the user already has a
 * Tenant, returns it; otherwise creates one, sets `users.tenantId` to
 * the new row, and returns. Slug allocation runs through
 * [`UsernameAllocatorService`](../users/services/username-allocator.service.ts)
 * which guarantees the chosen slug doesn't collide with any existing
 * user, slug, or Org row.
 *
 * **The Tenant's slug is the user's username.** That keeps the
 * single-user case clean: a user named `alice` gets a Tenant whose
 * slug is `alice`, so `everworks.com/alice/...` is their personal
 * scope — and if they create an Org later, that Org gets its own slug
 * inside the same Tenant. (Note: the Tenant slug is mostly internal
 * routing today; the user-facing scope label is the User's slug for
 * the bare-Tenant surface and the Org's slug for org scopes.)
 */
@Injectable()
export class TenantBootstrapService {
    private readonly logger = new Logger(TenantBootstrapService.name);

    constructor(
        private readonly userRepository: UserRepository,
        private readonly tenantRepository: TenantRepository,
        private readonly usernameAllocator: UsernameAllocatorService,
    ) {}

    /**
     * Returns the user's Tenant, lazy-creating it if necessary.
     *
     * Idempotency: safe to call multiple times for the same user; the
     * second call returns the existing row instead of creating a new
     * one. Concurrent first-callers will race; the `tenants.ownerUserId`
     * UNIQUE constraint at the DB level is the source of truth and
     * will reject any duplicate insert at commit time.
     *
     * @throws `NotFoundException` if the user doesn't exist.
     */
    async ensureTenant(userId: string): Promise<Tenant> {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException(`User ${userId} not found`);
        }

        if (user.tenantId) {
            const existing = await this.tenantRepository.findById(user.tenantId);
            if (existing) {
                return existing;
            }
            // Defensive: `users.tenantId` is non-NULL but points to a
            // deleted row. The Tenant FK is `ON DELETE SET NULL`, so this
            // should be impossible in practice — but if a manual DBA
            // operation broke the invariant, fall through and create a
            // fresh Tenant for the user.
            this.logger.warn(
                `User ${userId} has tenantId=${user.tenantId} but the Tenant row is gone — recreating`,
            );
        }

        // First check: maybe another concurrent caller already created
        // a Tenant for this user but the user row hasn't been refreshed.
        const byOwner = await this.tenantRepository.findByOwnerUserId(userId);
        if (byOwner) {
            // Re-link the user row if it lost the FK somehow.
            if (user.tenantId !== byOwner.id) {
                await this.userRepository.update(userId, { tenantId: byOwner.id });
            }
            return byOwner;
        }

        // Allocate a slug. Defaults to the user's username — which is
        // itself already URL-safe and globally unique, so the allocator
        // will almost always pass it through unchanged. The cross-table
        // check still runs in case an Org grabbed the same string in a
        // race between User and Org creation.
        const slug = await this.usernameAllocator.allocateUsername(user.username);

        const tenant = await this.tenantRepository.create({
            ownerUserId: userId,
            slug,
            displayName: user.username,
        });

        // Link back from User → Tenant. We do this AFTER the Tenant
        // insert succeeds so the foreign-key invariant holds at every
        // intermediate state.
        await this.userRepository.update(userId, { tenantId: tenant.id });

        this.logger.log(
            `Lazy-created Tenant ${tenant.id} (slug=${tenant.slug}) for user ${userId}`,
        );

        return tenant;
    }
}
