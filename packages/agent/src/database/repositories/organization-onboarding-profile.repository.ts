import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrganizationOnboardingProfile } from '../../entities/organization-onboarding-profile.entity';

/** Fields a wizard write may set on the org-level onboarding profile. */
export interface OrganizationOnboardingProfileInput {
    readonly roles?: readonly string[] | null;
    readonly teamSize?: string | null;
    readonly updatedByUserId?: string | null;
}

/**
 * Audit item A53 — repository for `organization_onboarding_profiles`.
 *
 * Single row per organization, keyed by `organizationId`. Mirrors the
 * shape of `OrganizationNotificationDefaultRepository` (find + upsert,
 * no list/delete) because the table has exactly the same access
 * pattern: read the one row for the active scope, overwrite it on the
 * next answer.
 *
 * `upsert` is field-level: omitting `roles` (or `teamSize`) leaves the
 * persisted value alone, so a roles-only wizard patch cannot silently
 * wipe a previously answered team size. Passing an explicit `null`
 * clears the field.
 */
@Injectable()
export class OrganizationOnboardingProfileRepository {
    constructor(
        @InjectRepository(OrganizationOnboardingProfile)
        private readonly repository: Repository<OrganizationOnboardingProfile>,
    ) {}

    async findByOrg(organizationId: string): Promise<OrganizationOnboardingProfile | null> {
        return this.repository.findOne({ where: { organizationId } });
    }

    async upsert(
        organizationId: string,
        input: OrganizationOnboardingProfileInput,
    ): Promise<OrganizationOnboardingProfile> {
        const existing = await this.findByOrg(organizationId);

        const patch: Partial<OrganizationOnboardingProfile> = {};
        if (input.roles !== undefined) {
            patch.roles = input.roles ? [...input.roles] : null;
        }
        if (input.teamSize !== undefined) {
            patch.teamSize = input.teamSize ?? null;
        }
        if (input.updatedByUserId !== undefined) {
            patch.updatedByUserId = input.updatedByUserId ?? null;
        }

        if (existing) {
            await this.repository.update({ organizationId }, patch);
            return (await this.findByOrg(organizationId)) as OrganizationOnboardingProfile;
        }

        const created = this.repository.create({ organizationId, ...patch });
        return this.repository.save(created);
    }
}
