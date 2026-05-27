import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    OneToMany,
    CreateDateColumn,
    UpdateDateColumn,
    ManyToOne,
    JoinColumn,
    BeforeInsert,
} from 'typeorm';
import type { ClassToObject } from './types';
import { TimestampColumn, PortableDateColumn } from './_types';
import { Work } from './work.entity';
import { WorkGenerationHistory } from './work-generation-history.entity';
import { UserSubscription } from './user-subscription.entity';
import { SubscriptionPlan } from './subscription-plan.entity';
import { WorkSchedule } from './work-schedule.entity';
import { WorkMember } from './work-member.entity';
import type { OnboardingWizardStateV2 } from '@ever-works/contracts/api';

export interface InferredUserProfile {
    industry?: string;
    role?: string;
    expertise: string[];
    topics: string[];
    businessType?: string;
    confidence: 'low' | 'medium' | 'high';
    sources: { url: string; title: string }[];
    researchedAt: string;
    tokensUsed?: number;
    toolCallsCount?: number;
}

@Entity({ name: 'users' })
export class User {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    // EW-652 (Tenants & Organizations Phase 0): username uniqueness is enforced
    // ONLY by the case-insensitive expression UNIQUE index on `lower(username)`
    // in migration `1779991000000-AddUniqueIndexToUsername.ts`. Do NOT add
    // `unique: true` here — the column-level UNIQUE would generate a
    // case-sensitive constraint that conflicts with the expression index
    // (two different UNIQUE indexes covering the same column) and can confuse
    // schema-sync tooling.
    @Column()
    username: string;

    // EW-652: URL-safe denormalized form of `username`, used by the slug
    // routing layer (EW-659 Phase 7). Always lowercase, matches `[a-z0-9-]+`.
    // Uniqueness is enforced by `idx_users_slug_unique` in migration
    // `1779991001000-AddSlugToUsers.ts`. Same rationale as `username` above —
    // we keep the column declaration plain and let the migration own the
    // UNIQUE constraint. Future rename flows (out of scope for v1 — spec
    // says no slug_redirects table) are responsible for explicitly updating
    // BOTH `username` AND `slug` when a user renames; the `@BeforeInsert`
    // hook below only fires on INSERT.
    @Column()
    slug: string;

    // EW-617 G2: anonymous (zero-friction) users have no email/password until
    // they claim the account via POST /api/auth/claim. Existing rows keep
    // their non-null values; new anonymous rows persist NULLs here.
    // Explicit `type: 'varchar'` because TS reflect-metadata flattens
    // `string | null` to `Object`, which better-sqlite3 (used by internal
    // CLI tests) refuses with DataTypeNotSupportedError.
    @Column({ type: 'varchar', unique: true, nullable: true })
    email: string | null;

    @Column({ type: 'varchar', nullable: true })
    password: string | null;

    @Column({ default: 'local' })
    registrationProvider: string; // 'local', 'github', 'google', 'anonymous' - how user initially signed up

    // EW-617 G2: zero-friction anonymous users.
    // `isAnonymous=true` rows have nullable email/password and live until
    // `anonymousExpiresAt`. The nightly cleanup task deletes expired rows
    // and cascades to their Works. Claim-account flow flips this to false
    // and clears the TTL.
    @Column({ default: false })
    isAnonymous: boolean;

    @TimestampColumn({ nullable: true })
    anonymousExpiresAt?: Date | null;

    @Column({ nullable: true })
    avatar: string;

    // Email verification
    @Column({ default: false })
    emailVerified: boolean;

    @Column({ nullable: true })
    emailVerificationToken: string;

    @Column({ nullable: true })
    emailVerificationExpires: Date;

    // User status
    @Column({ default: true })
    isActive: boolean;

    @Column({ nullable: true })
    lastLoginAt: Date;

    @Column({ nullable: true })
    lastLoginIp: string;

    // H-17 (rest): per-user login lockout. IP throttle (`@Throttle` on
    // /auth/login) only protects against a single attacker IP; an attacker
    // rotating IPs targeting one account walks past it. We count consecutive
    // failed credential verifies in `failedLoginAttempts` and, once they
    // cross `LOGIN_LOCKOUT_THRESHOLD`, set `lockedUntil = now +
    // LOGIN_LOCKOUT_DURATION_MS`. Successful login resets both columns to
    // 0 / null.
    @Column({ type: 'int', default: 0 })
    failedLoginAttempts: number;

    // H-17: `type: 'timestamp'` is Postgres-only and breaks integration specs
    // that boot the User entity under better-sqlite3 (work-proposal.entity.
    // integration.spec). `PortableDateColumn` (`type: Date`) lets TypeORM pick
    // the right column type per dialect — Postgres still gets `timestamp`,
    // sqlite gets `datetime`.
    @PortableDateColumn({ nullable: true })
    lockedUntil?: Date | null;

    // Password reset
    @Column({ nullable: true })
    passwordResetToken: string;

    @Column({ nullable: true })
    passwordResetExpires: Date;

    // 1f — Magic-link passwordless auth. Stored as sha256(token); raw
    // token only travels via the link in the issuance email. Same
    // PortableDateColumn dance as `lockedUntil` so sqlite + postgres
    // pick the right column type per dialect.
    //
    // Note: `type: 'varchar'` is REQUIRED — without it TypeORM tries to
    // infer the column type from `string | null` and falls back to
    // "Object", which better-sqlite3 then refuses with
    // DataTypeNotSupportedError. This bites the e2e CI run (sqlite
    // in-memory) but not Postgres prod, so it's easy to miss locally.
    @Column({ type: 'varchar', nullable: true })
    magicLinkToken?: string | null;

    @PortableDateColumn({ nullable: true })
    magicLinkExpires?: Date | null;

    // Git committer overrides (optional — fallback to username/email if not set)
    @Column({ type: 'varchar', nullable: true })
    committerName?: string | null;

    @Column({ type: 'varchar', nullable: true })
    committerEmail?: string | null;

    // Onboarding wizard v2 — server-side state (so progress survives device
    // switches). `TimestampColumn` stores as `bigint` so the schema is
    // identical on Postgres + SQLite (the `internal-cli` test driver).
    @TimestampColumn({ nullable: true })
    onboardingCompletedAt?: Date | null;

    @TimestampColumn({ nullable: true })
    onboardingDismissedAt?: Date | null;

    @Column('simple-json', { nullable: true })
    onboardingState?: OnboardingWizardStateV2 | null;

    @Column('simple-json', { nullable: true })
    inferredInterests?: InferredUserProfile | null;

    @Column('simple-json', { nullable: true })
    suggestedVerticals?: string[] | null;

    @Column({ default: false })
    userResearchOptOut: boolean;

    /**
     * Agents/Skills/Tasks PR #1017 — Phase 18.5. Email opt-in flags
     * for the two new notification categories. Default OFF (in-app
     * notifications still fire; email is opt-in to keep new users
     * from getting flooded). UI toggle lives at /settings/profile
     * once the wiring lands.
     */
    @Column({ default: false })
    emailAgentAlerts: boolean;

    @Column({ default: false })
    emailTaskNotifications: boolean;

    /**
     * EW-602 — Self-hosted platform admin flag. Grants access to the
     * cross-user admin view at /admin/usage. Default false; the
     * self-hosted operator seeds it via SEED_PLATFORM_ADMIN_EMAIL on
     * first boot, or by manual UPDATE.
     */
    @Column({ default: false })
    isPlatformAdmin: boolean;

    /**
     * EW-602 — Per-user opt-out for budget-alert emails. Defaults to
     * true (opt-in by default) so users can disable just the budget
     * alert channel without touching the in-app notification, which
     * always fires.
     */
    @Column({ default: true })
    emailBudgetAlerts: boolean;

    // Timestamps
    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    @OneToMany(() => Work, (work) => work.user, { lazy: true })
    works: Promise<ClassToObject<Work>[]>;

    @OneToMany(() => WorkGenerationHistory, (history) => history.user, { lazy: true })
    generationHistory?: Promise<ClassToObject<WorkGenerationHistory>[]>;

    @OneToMany(() => UserSubscription, (subscription) => subscription.user, { lazy: true })
    subscriptions?: Promise<ClassToObject<UserSubscription>[]>;

    @OneToMany(() => WorkSchedule, (schedule) => schedule.user, { lazy: true })
    workSchedules?: Promise<ClassToObject<WorkSchedule>[]>;

    @OneToMany(() => WorkMember, (member) => member.user, { lazy: true })
    workMemberships?: Promise<ClassToObject<WorkMember>[]>;

    @Column({ type: 'varchar', nullable: true })
    defaultPlanId?: string | null;

    @ManyToOne(() => SubscriptionPlan, { nullable: true, eager: true })
    @JoinColumn({ name: 'defaultPlanId' })
    defaultPlan?: ClassToObject<SubscriptionPlan> | null;

    local: boolean = false;

    /**
     * EW-652 (Tenants & Organizations Phase 0) — auto-derive `slug` from
     * `username` at insert time if the caller didn't set it explicitly.
     *
     * This means every existing `userRepository.create({ username, ... })`
     * call site continues to work without modification: the slug is
     * derived in-memory before the row hits the DB. Callers that want
     * an explicit slug (e.g. `UsernameAllocatorService.allocateUsername`
     * pipelines) can still set `slug` directly and this hook is a no-op.
     *
     * Normalization is the same shape as `UsernameAllocatorService.normalize`
     * — lowercase, replace any non-`[a-z0-9-]` with hyphen, collapse runs,
     * trim leading/trailing hyphens. If the result is empty (degenerate
     * username), we fall back to `u-anon` which is guaranteed to collide
     * with at most one other unset row; the DB UNIQUE constraint will
     * catch any race.
     *
     * The hook only fires on INSERT — not on UPDATE. Username renames go
     * through a service layer (out of scope here) that explicitly updates
     * both columns.
     *
     * Visibility: NOT `private` — a private method gets stripped from
     * `ClassToObject<User>` (the mapped type doesn't see private members),
     * which breaks downstream consumers that pass `ClassToObject<User>`
     * where a `User` is expected (e.g. lazy-loaded relations). Same shape
     * as the public `asCommitter()` method below.
     */
    @BeforeInsert()
    deriveSlugIfMissing(): void {
        if (this.slug) {
            return;
        }
        if (!this.username) {
            this.slug = 'u-anon';
            return;
        }
        const normalized = this.username
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-+|-+$/g, '');
        this.slug = normalized.length > 0 ? normalized : 'u-anon';
    }

    asCommitter(): { name: string; email: string } {
        // Anonymous users have null email; only happens before claim-account.
        // Repo-touching paths (git commit, deploy) require a real email, so
        // we surface a parseable but obviously-synthetic address that won't
        // collide with anything real and signals 'fix before commit'.
        const fallbackEmail = `anon-${this.id}@anonymous.ever.works`;
        return {
            name: this.committerName || this.username,
            email: this.committerEmail || this.email || fallbackEmail,
        };
    }
}
