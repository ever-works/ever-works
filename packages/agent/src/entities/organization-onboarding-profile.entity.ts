import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { Organization } from './organization.entity';

/**
 * Audit item A53 — organization-scoped mirror of the onboarding wizard's
 * "What do you do" answers (roles multi-select + team size).
 *
 * The wizard already persists these on `users.onboarding_state`, which is
 * per-user and therefore invisible to anyone else in the same
 * organization. Suggestion surfaces that reason about the WHOLE team
 * (agent recommendations, digest tone, seat sizing) need an org-level
 * answer, so the same payload is mirrored here whenever the PATCH runs
 * inside a resolved organization scope.
 *
 * Shape mirrors `OrganizationNotificationDefault`: PK = `organizationId`,
 * one row per organization, `ON DELETE CASCADE` from `organizations`.
 * The user-level blob stays the source of truth for the wizard UI; this
 * row is the org-wide read model (last writer inside the org wins, and
 * `updatedByUserId` records who that was).
 *
 * Values are validated against `ROLE_OPTIONS` / `TEAM_SIZE_OPTIONS` ids
 * before they reach this table (drop-if-unrecognised, never defaulted).
 */
@Entity({ name: 'organization_onboarding_profiles' })
export class OrganizationOnboardingProfile {
    @PrimaryColumn({ type: 'uuid' })
    organizationId: string;

    /**
     * No `@ManyToOne`/eager relation is declared beyond this `@OneToOne`
     * back-pointer — same call as `OrganizationNotificationDefault`, which
     * keeps the organization/tenant/user import cycle from widening.
     */
    @OneToOne(() => Organization, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'organizationId' })
    organization?: Organization;

    /**
     * Selected role ids (kebab-case `ROLE_OPTIONS` ids). `simple-json`
     * maps to `text` on Postgres and better-sqlite3 alike. NULL when the
     * step was skipped without picking a role.
     */
    @Column({ type: 'simple-json', nullable: true })
    roles?: string[] | null;

    /** Selected `TEAM_SIZE_OPTIONS` id, or NULL when never answered. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    teamSize?: string | null;

    /** Last user in this organization whose wizard write produced this row. */
    @Column({ type: 'uuid', nullable: true })
    updatedByUserId?: string | null;

    @UpdateDateColumn()
    updatedAt: Date;
}
