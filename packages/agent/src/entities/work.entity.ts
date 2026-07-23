import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    ManyToOne,
    OneToMany,
    OneToOne,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';
import { User } from './user.entity';
import type {
    ClassToObject,
    CommunityPrState,
    WorkScheduleCadence,
    WorkScheduleStatus,
    GenerateStatus,
    WorkMemberRole,
} from './types';
import type {
    ImportSourceType,
    RelatedRepositories,
    RepoVisibility,
    RepositoryRole,
    RepositoryTarget,
    SourceRepository as ContractSourceRepository,
    WorksConfigSnapshot as ContractWorksConfigSnapshot,
} from '@ever-works/contracts/api';
import type { PRUpdate } from '@src/generators/data-generator';
import { WorkGenerationHistory } from './work-generation-history.entity';
import { TimestampColumn } from './_types';
import { WorkSchedule } from './work-schedule.entity';
import { WorkCustomDomain } from './work-custom-domain.entity';
import { WorkDeployment } from './work-deployment.entity';
import { WorkMember } from './work-member.entity';
import type { WorkKbConfig } from './kb-types';

/**
 * Work kinds a user can pick at creation time — the chip catalog on
 * `/new` and `/works/new`. Persisting the choice on `work.kind` is what
 * lets `WebsiteTemplateResolverService.resolveForWork` pick a
 * kind-appropriate default website template (general-purpose kinds →
 * the `web` template; directory-ish kinds stay on `classic`). See
 * `getWebsiteTemplateIdForWorkKind` in
 * `generators/website-generator/config/website-template.config.ts`.
 *
 * `company` is deliberately NOT in this list: Company Works are minted
 * only through the dedicated Register-Company flow
 * (`WorkLifecycleService.createCompanyWork`), never via the general
 * create path.
 */
export const USER_SELECTABLE_WORK_KINDS = [
    'website',
    'landing-page',
    'blog',
    'directory',
    'awesome-repo',
] as const;

export type UserSelectableWorkKind = (typeof USER_SELECTABLE_WORK_KINDS)[number];

/**
 * EW-665 (Tenants & Organizations Phase 13) — Work "kind" discriminator.
 *
 *   - `'default'` — every Work that predates the kind-aware create path
 *     (directories, websites, landing pages, etc.). The column default,
 *     so every pre-Phase-13 row backfills to it.
 *   - `'company'` — a Work registered through the Company chip /
 *     Register-Company flow ([spec.md §5.4](../../../../docs/specs/features/tenants-and-organizations/spec.md#54-user-registers-a-company-via-a-work-of-type-company)).
 *     When such a Work transitions to `status = 'registered'`, a
 *     `work.status.changed` event fires and the
 *     `WorkRegisteredListener` (API layer) spawns the backing
 *     `Organization` via `OrganizationService.createOrganizationFromCompanyWork`.
 *   - the `USER_SELECTABLE_WORK_KINDS` members — the work-kind chip the
 *     user picked at creation, persisted so the website-template
 *     resolver can apply a kind-appropriate default.
 *
 * String union + `varchar(32)` mirrors the `TemplateKind` convention on
 * `template.entity.ts` — keeps the value space open without churning a
 * Postgres enum type on every new member.
 */
export type WorkKind = 'default' | 'company' | UserSelectableWorkKind;

/**
 * Normalize a caller-supplied work-kind string for the general create
 * path. Whitelist semantics — arbitrary input can never become
 * `work.kind`:
 *
 *   - nullish / blank → `undefined` (caller leaves the column default,
 *     `'default'`, in place);
 *   - `'landing'` → `'landing-page'` (accepted alias — the resolver map
 *     understands both, but we persist only the canonical chip value);
 *   - a known user-selectable kind or `'default'` → itself;
 *   - anything else (including `'company'`, which is reserved for the
 *     Register-Company flow) → `'default'`.
 */
export function normalizeCreateWorkKind(value?: string | null): WorkKind | undefined {
    if (typeof value !== 'string') {
        return value === undefined || value === null ? undefined : 'default';
    }
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
        return undefined;
    }
    const canonical = normalized === 'landing' ? 'landing-page' : normalized;
    if (canonical === 'default') {
        return 'default';
    }
    return (USER_SELECTABLE_WORK_KINDS as readonly string[]).includes(canonical)
        ? (canonical as UserSelectableWorkKind)
        : 'default';
}

/**
 * EW-665 (Tenants & Organizations Phase 13) — Work lifecycle status.
 *
 * The platform had no Work-level lifecycle status before this phase
 * (generation / deployment / schedule each have their own independent
 * status columns — `generateStatus`, `deploymentState`,
 * `scheduledStatus` — none of which represent the Work as a whole).
 *
 *   - `'active'` — the column default. Every existing row backfills to
 *     it so behavior is unchanged (a Work that exists is "live").
 *   - `'draft'` — created-but-not-yet-finalized (e.g. a Company Work
 *     before its registration completes).
 *   - `'registered'` — the inflection point for Company Works: the
 *     transition into this state is what fires the Org-create lifecycle.
 *   - `'archived'` — soft-retired; reserved for a future archive flow.
 */
export type WorkStatus = 'draft' | 'active' | 'registered' | 'archived';

@Entity({ name: 'works' })
export class Work {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;

    @Column()
    slug: string;

    @Column()
    userId: string;

    @ManyToOne(() => User, (user) => user.works, { onDelete: 'CASCADE', eager: true })
    user: ClassToObject<User>;

    @OneToMany(() => WorkGenerationHistory, (history) => history.work, {
        cascade: false,
    })
    generationHistory?: ClassToObject<WorkGenerationHistory>[];

    @Column({ nullable: true })
    owner?: string;

    @Column({ default: 'github' })
    gitProvider: string; // 'github', 'gitlab', etc.

    @Column({ default: 'user-github' })
    storageProvider: string; // 'ever-works-git' | 'user-github' | 'user-gitlab' | 'user-git'

    // Explicit `type: 'varchar'` is REQUIRED now that the TS type is a
    // `string | null` union: without it TypeORM's reflect-metadata
    // infers the column type as `Object`, which better-sqlite3 (the
    // test/CLI adapter) rejects with DataTypeNotSupportedError. The
    // `| null` itself exists because Company Works (EW-665) set this to
    // null to stay out of the Ever Works Deploy quota counter. Still no
    // schema change — the column was already `nullable: true` varchar.
    @Column({ type: 'varchar', default: 'ever-works', nullable: true })
    deployProvider?: string | null; // 'ever-works' | 'vercel' | 'k8s' | null (company) | ...

    @Column({ nullable: true })
    website: string;

    @Column({ nullable: true })
    companyName: string;

    /**
     * Cached `company_website` from `.works/works.yml`. See `configCache`
     * for the full design — populated by the generator and by the lazy
     * backfill path in `WorkQueryService`.
     *
     * `type: 'varchar'` is required for `string | null` unions —
     * TypeORM's reflect-metadata fallback emits `Object` for the
     * union, which better-sqlite3 (used in CLI tests) rejects with
     * `DataTypeNotSupportedError`. Same pattern as `committerName`
     * / `committerEmail` above. See develop commit f1ad254e.
     */
    @Column({ type: 'varchar', nullable: true })
    companyWebsite?: string | null;

    @Column({ default: false })
    organization: boolean;

    /**
     * EW-665 (Tenants & Organizations Phase 13) — Work "kind"
     * discriminator. `'default'` for every Work that exists today;
     * `'company'` for Works created via the Register-Company flow. See
     * the `WorkKind` type above. `varchar(32)` mirrors `TemplateKind`.
     */
    @Column({ type: 'varchar', length: 32, default: 'default' })
    kind: WorkKind;

    /**
     * EW-665 (Tenants & Organizations Phase 13) — Work lifecycle status.
     * Defaults to `'active'` so every existing row is treated as live
     * (no behavior change). The `'draft' → 'registered'` transition on a
     * `kind = 'company'` Work is what fires the `work.status.changed`
     * event that spawns the backing Organization. See `WorkStatus` above.
     */
    @Column({ type: 'varchar', length: 32, default: 'active' })
    status: WorkStatus;

    // EW-655 (Tenants & Organizations Phase 3) — Tier A tenant scope.
    // organizationId already exists from earlier work (below); tenantId
    // joins it here. Both NULL until first-Org create (Phase 6).
    // Ordered tenantId-first to match the other 17 Tier A entities.
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    /**
     * EW-641 Phase 2/e row 37c — owning organization id.
     *
     * Free-form UUID, NOT (yet) a foreign key to any `Organization` entity:
     * the spec (§7.6) describes a future `Organization` entity for KB
     * org-overlay membership, but no such entity has landed on develop yet.
     * Treat this column the same way `WorkKnowledgeDocument.organizationId`
     * is stored — a string that future code links to a yet-to-exist
     * Organization table.
     *
     * Starts NULL for every existing Work. Population happens lazily: org
     * onboarding flows (not in this PR) will set it on Works the org owns,
     * and the KB org-overlay fanout (row 37d) reads it to resolve the
     * target Work id list before dispatching the `kb-org-overlay-fanout`
     * task. Until then, the column is harmless metadata — no read paths
     * depend on it.
     *
     * Indexed (single-column) for the row-37d
     * `WorkRepository.findIdsByOrganization(orgId)` lookup.
     */
    @Column({ type: 'uuid', nullable: true })
    organizationId?: string | null;

    @Column()
    description: string;

    @Column('simple-json', { nullable: true })
    readmeConfig: MarkdownReadmeConfig;

    // Generation FIELDS
    @Column('simple-json', { nullable: true })
    generateStatus?: GenerateStatus;

    @TimestampColumn({ nullable: true })
    generationStartedAt?: Date;

    @TimestampColumn({ nullable: true })
    generationProgressedAt?: Date;

    @TimestampColumn({ nullable: true })
    generationFinishedAt?: Date;

    // Domain Type FIELDS (for smart image routing)
    @Column({ type: 'varchar', length: 20, nullable: true })
    domainType?: string; // 'software' | 'ecommerce' | 'services' | 'general'

    @Column({ type: 'float', nullable: true })
    domainTypeConfidence?: number;

    @Column({ type: 'boolean', default: false })
    domainTypeManuallySet: boolean;

    @OneToOne(() => WorkSchedule, (schedule) => schedule.work)
    schedule?: ClassToObject<WorkSchedule>;

    @OneToMany(() => WorkMember, (member) => member.work)
    members?: ClassToObject<WorkMember>[];

    @OneToMany(() => WorkCustomDomain, (customDomain) => customDomain.work)
    customDomains?: ClassToObject<WorkCustomDomain>[];

    @OneToMany(() => WorkDeployment, (deployment) => deployment.work)
    deployments?: ClassToObject<WorkDeployment>[];

    @Column({ type: 'boolean', default: false })
    scheduledUpdatesEnabled: boolean;

    @Column({ type: 'varchar', nullable: true })
    scheduledCadence?: WorkScheduleCadence | null;

    @TimestampColumn({ nullable: true })
    scheduledNextRunAt?: Date | null;

    @Column({ type: 'varchar', nullable: true })
    scheduledStatus?: WorkScheduleStatus | null;

    // Deployment FIELDS
    @Column({ nullable: true })
    deployProjectId?: string;

    @Column({ nullable: true })
    deploymentState?: string;

    @TimestampColumn({ nullable: true })
    deploymentStartedAt?: Date;

    /**
     * EW-617 G8 — last zero-friction funnel correlation id observed for
     * this work. Set by `WorkLifecycleService.createWork` when the create
     * DTO carries one, so the async DEPLOY_READY poller can emit with the
     * same correlationId the rest of the funnel used. Nullable so existing
     * rows + non-funnel creates keep working unchanged.
     */
    @Column({ type: 'varchar', length: 64, nullable: true })
    lastDeployCorrelationId?: string | null;

    // Repository FIELDS
    @Column('simple-json', { nullable: true })
    lastPullRequest?: { main?: PRUpdate; data?: PRUpdate };

    @Column('simple-json', { nullable: true })
    repoVisibility?: RepoVisibility;

    @Column({ nullable: true })
    itemsCount?: number;

    /**
     * Denormalised counts cached from the Work's data repo, so the
     * Overview tab can render without `gitFacade.cloneOrPull()`.
     * Populated by the generator on every successful run and by the
     * lazy backfill in `WorkQueryService` on first read after the
     * caching migration deploys. Source of truth is still the
     * `categories.yml` / `tags.yml` / comparisons listing in the repo.
     */
    @Column({ nullable: true })
    categoriesCount?: number;

    @Column({ nullable: true })
    tagsCount?: number;

    @Column({ nullable: true })
    comparisonsCount?: number;

    /**
     * Cached `.works/works.yml` payload (the full `IDataConfig`) so
     * tabs that need config fields — Overview, Generator, Settings,
     * Deploy — can read straight from Postgres instead of cloning the
     * data repo. Populated alongside the count columns above and
     * refreshed whenever the generator (or the Settings save path)
     * writes the YAML back to the repo. Stored as `text` + parsed at
     * read time, matching the `simple-json` convention used elsewhere
     * on this entity (`readmeConfig`, `kbConfig`, etc.).
     */
    @Column('simple-json', { nullable: true, name: 'configCache' })
    configCache?: WorksConfigCache | null;

    // Git committer overrides at work level (optional — fallback to user/default)
    @Column({ type: 'varchar', nullable: true })
    committerName?: string | null;

    @Column({ type: 'varchar', nullable: true })
    committerEmail?: string | null;

    // Import Source FIELDS
    @Column('simple-json', { nullable: true })
    sourceRepository?: SourceRepository;

    // Community PR Processing FIELDS
    @Column({ type: 'boolean', default: false })
    communityPrEnabled: boolean;

    @Column({ type: 'boolean', default: true })
    communityPrAutoClose: boolean;

    @Column('simple-json', { nullable: true })
    communityPrState?: CommunityPrState;

    // Comparison Generation FIELDS
    @Column({ type: 'boolean', default: false })
    comparisonsEnabled: boolean;

    @Column({ type: 'varchar', nullable: true, default: null })
    websiteTemplateId?: string | null;

    // Website Template Auto-Update FIELDS
    @Column({ type: 'boolean', default: false })
    websiteTemplateAutoUpdate: boolean;

    @Column({ type: 'boolean', default: false })
    websiteTemplateUseBeta: boolean;

    @Column({ type: 'varchar', nullable: true })
    websiteTemplateLastCommit?: string | null;

    @Column({ type: 'varchar', nullable: true })
    websiteTemplateLastError?: string | null;

    // Data-repo Instant-Sync FIELDS (EW-628)
    // See docs/specs/features/data-repo-instant-sync/{spec,plan}.md
    /** Most recent data-repo SHA the main repo has been rendered against. Updated on successful sync. */
    @Column({ type: 'varchar', length: 40, nullable: true })
    lastSyncedDataRepoSha?: string | null;

    /**
     * Webhook flag — set to `now()` by the GitHub App `push` handler.
     * The dispatcher flushes when the row is ≥ 30 s old (quiet-period
     * debounce). Cleared by a successful sync. NULL when no sync is
     * pending for this Work.
     */
    @TimestampColumn({ nullable: true })
    pendingSyncRequestedAt?: Date | null;

    /**
     * Poller cadence (App-not-installed path). Allowed range 1–60.
     * Ignored when `githubAppInstalled = true`.
     */
    @Column({ type: 'int', default: 5 })
    syncIntervalMinutes: number;

    /**
     * Denormalised selector — `true` iff the Ever Works GitHub App is
     * installed on this Work's data repo. Flipped by the App's
     * `installation_repositories` webhook. Used by the dispatcher to pick
     * Path A (webhook) vs Path B (poller).
     */
    @Column({ type: 'boolean', default: false })
    githubAppInstalled: boolean;

    /** Last time the poller probed `ls-remote HEAD`. Updated regardless of SHA delta. */
    @TimestampColumn({ nullable: true })
    lastPolledAt?: Date | null;

    @TimestampColumn({ nullable: true })
    websiteTemplateLastUpdatedAt?: Date | null;

    @TimestampColumn({ nullable: true })
    websiteTemplateLastCheckedAt?: Date | null;

    // Source Validation FIELDS
    @Column({ type: 'boolean', default: false })
    sourceValidationEnabled: boolean;

    @Column({ type: 'varchar', nullable: true })
    sourceValidationCadence?: WorkScheduleCadence | null;

    @TimestampColumn({ nullable: true })
    sourceValidationNextRunAt?: Date | null;

    @TimestampColumn({ nullable: true })
    sourceValidationLastRunAt?: Date | null;

    // Activity Feed sync — per-Work transport for surfacing
    // website-side events (signups, item submissions, reports) in the
    // platform Activity Feed tab. See ADR-004.
    //
    //   pull     — platform fetches on-demand via DirectoryWebsiteClient
    //              (HMAC-signed), using `platformSyncSecretEncrypted` as
    //              the per-Work shared secret.
    //   push     — deployed site POSTs each event to
    //              /api/activity-log/ingest using the platform-wide
    //              `PLATFORM_API_SECRET_TOKEN` bearer.
    //   disabled — feed shows only platform-internal categories.
    //
    // Source-of-truth is the directory's `works.yml` activity_sync.mode;
    // this column is the read path used everywhere on the platform.
    @Column({ type: 'varchar', length: 16, default: 'pull' })
    activitySyncMode: 'pull' | 'push' | 'disabled';

    // Pull-mode only. AES-256-GCM-encrypted per-Work HMAC secret used by
    // DirectoryWebsiteClient to sign outbound requests to the deployed
    // site. NULL until the next deploy lazily provisions it.
    @Column({ type: 'text', nullable: true })
    platformSyncSecretEncrypted?: string | null;

    // AES-256-GCM-encrypted per-Work webhook secret used by the deployed
    // site's `/api/webhook` endpoint (registered by the minimal template's
    // `@ever-works/astro-integration` when `process.env.WEBHOOK_SECRET` is
    // set at build time) to verify incoming GitHub push notifications via
    // X-Hub-Signature-256. Persistent across deploys so a GH-side webhook
    // registered once stays valid through subsequent redeploys (rotating
    // would silently break signature verification until the workflow
    // re-registers the webhook). NULL until the first deploy provisions it.
    @Column({ type: 'text', nullable: true })
    webhookSecretEncrypted?: string | null;

    // AES-256-GCM-encrypted per-Work runtime env injected into a k8s-deployed
    // site's container (deploy_k8s renders a `${slug}-runtime-env` Secret that
    // deployment.yaml mounts via envFrom). Vercel supplied these from project
    // env + the external Postgres integration; k8s has no such source, so the deploy
    // feature provisions them (EW: k8s runtime-env). `AUTH_SECRET`/
    // `COOKIE_SECRET` are generated once and persisted so they stay stable
    // across redeploys (rotating would invalidate live sessions); the database
    // URL is the per-Work Postgres connection string (e.g. the reused external Postgres DB).
    // All NULL until the first k8s deploy / explicit set.
    @Column({ type: 'text', nullable: true })
    deployAuthSecretEncrypted?: string | null;

    @Column({ type: 'text', nullable: true })
    deployCookieSecretEncrypted?: string | null;

    @Column({ type: 'text', nullable: true })
    deployDatabaseUrlEncrypted?: string | null;

    // Which database backs this Work's deployed site:
    //   'shared' — a platform-managed database on the "Ever Works DB" cluster,
    //              auto-provisioned by EverWorksDbProvisionService (the stored
    //              `deployDatabaseUrlEncrypted` points at it).
    //   'custom' — a bring-your-own connection string the user set explicitly.
    // NULL for legacy rows: treated as 'custom' when a URL is set, otherwise
    // 'shared' when the shared-DB feature is enabled (see WorkRuntimeEnvService).
    @Column({ type: 'text', nullable: true })
    deployDatabaseMode?: 'shared' | 'custom' | null;

    /**
     * EW-734 / EW-736 — globally-unique persisted managed subdomain claim.
     *
     * Stores the leftmost label (e.g. `'ai-coding'`) of the Work's
     * `*.ever.works` hostname. The DB-level partial unique index (created
     * by migration `1780800000000-AddWorkManagedSubdomain`,
     * `WHERE "managedSubdomain" IS NOT NULL`) is the backstop that turns
     * `SubdomainAllocator`'s collision-detect-and-suffix algorithm into a
     * race-safe claim. NULL until a Work is allocated a managed subdomain
     * (the default for existing rows — fully backward-compatible with the
     * legacy `${slug}.ever.works` derivation, which keeps working).
     *
     * `type: 'varchar'` + explicit `nullable: true` are required for the
     * `string | null` union — TypeORM's reflect-metadata fallback infers
     * `Object` for unions, which the better-sqlite3 test adapter rejects
     * with `DataTypeNotSupportedError`. Same pattern as
     * `deployDatabaseUrlEncrypted` above.
     *
     * See `docs/specs/features/cloudflare-dns-plugin/spec.md` §4.3 / §5.
     */
    @Column({ type: 'varchar', length: 63, nullable: true })
    managedSubdomain?: string | null;

    // Pull-mode observability — drives the degraded banner UX.
    @TimestampColumn({ nullable: true })
    platformSyncLastSuccessAt?: Date | null;

    @TimestampColumn({ nullable: true })
    platformSyncLastErrorAt?: Date | null;

    @Column({ type: 'text', nullable: true })
    platformSyncLastErrorMessage?: string | null;

    // Knowledge Base configuration (see kb-types.ts -> WorkKbConfig).
    // Folded into a single simple-json column because none of these
    // fields are query-driven; everything that is queried lives on
    // dedicated KB entities.
    @Column('simple-json', { nullable: true })
    kbConfig?: WorkKbConfig | null;

    /**
     * FK back to the `WorkProposal` (Idea) this Work was built from
     * (spec §3.7 + PLAN §10.6). NULL for Works created via any
     * pre-Missions path (manual creation, wizard, import, etc.) —
     * those continue to exist exactly as they did before.
     *
     * The Mission detail page (Phase 6 PR R) uses this back-link
     * to roll up "all Works spawned by this Mission" via the join
     * `Mission -> WorkProposal (missionId) -> Work
     * (acceptedFromIdeaId)` without a heavy multi-hop traversal.
     *
     * Set by the `acceptInternal(ideaId, workId)` helper (Phase 1
     * PR B) when a build-from-Idea Goal completes successfully.
     * ON DELETE SET NULL: deleting the source Idea (rare; Ideas
     * are soft-hidden when Done, not deleted) does NOT delete the
     * built Work.
     */
    @Column({ type: 'uuid', nullable: true })
    acceptedFromIdeaId?: string | null;

    // Timestamps
    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;

    getDataRepo() {
        return this.getRelatedRepository('data').repo;
    }

    getWebsiteRepo() {
        return this.getRelatedRepository('website').repo;
    }

    getMainRepo() {
        return this.getRelatedRepository('work').repo;
    }

    getRepoOwner(type: RepositoryRole = 'data'): string {
        return this.getRelatedRepository(type).owner;
    }

    private getRelatedRepository(type: RepositoryRole): Required<RepositoryTarget> {
        const related = this.sourceRepository?.relatedRepositories?.[type];
        const owner = related?.owner || this.owner || this.user?.username || '';
        const repo = related?.repo || this.getDefaultRepositoryName(type);

        return { owner, repo };
    }

    private getDefaultRepositoryName(type: RepositoryRole): string {
        if (type === 'website') {
            return `${this.slug}-website`;
        }

        if (type === 'work') {
            return this.slug;
        }

        return `${this.slug}-data`;
    }

    /**
     * Resolve the git committer for this work.
     * Priority: work-level override → user-level override → user default (username/email)
     */
    resolveCommitter(user: User): { name: string; email: string } {
        const userCommitter = user.asCommitter();
        const name = this.committerName || userCommitter.name;
        const email = this.committerEmail || userCommitter.email;
        return { name, email };
    }

    /**
     * Check if a user is the creator/owner of this work.
     * Note: This checks the original creator (userId), not the OWNER role in members.
     */
    isCreator(userId: string): boolean {
        return this.userId === userId;
    }

    /**
     * Get member entry for a specific user.
     * Returns undefined if members are not loaded or user is not a member.
     */
    getMember(userId: string): WorkMember | undefined {
        if (!this.members) return undefined;
        return this.members.find((m) => m.userId === userId) as WorkMember | undefined;
    }

    /**
     * Check if a user has access to this work (either as creator or as member).
     * Note: Requires members relation to be loaded for member check.
     */
    hasAccess(userId: string): boolean {
        if (this.isCreator(userId)) return true;
        const member = this.getMember(userId);
        return !!member;
    }

    /**
     * Get the role of a user in this work.
     * Returns 'owner' for the creator, or the member's role if they're a member.
     */
    getUserRole(userId: string): WorkMemberRole | null {
        if (this.isCreator(userId)) {
            // Creator always has owner role
            return 'owner' as WorkMemberRole;
        }
        const member = this.getMember(userId);
        return member?.role || null;
    }
}

export interface MarkdownReadmeConfig {
    header?: string;
    overwriteDefaultHeader?: boolean;

    footer?: string;
    overwriteDefaultFooter?: boolean;
}

/**
 * Cached copy of the parsed `.works/works.yml` (the IDataConfig
 * shape returned by `DataRepository.getConfig()`). Mirrored from
 * the data repo by the generator + the lazy backfill path so that
 * dashboard tabs can render without cloning the data repo on every
 * request. Loose `Record`-shape because (a) we don't query any
 * fields inside it from SQL, and (b) we don't want the entity file
 * to import from `agent/generators` (would create a cycle).
 *
 * Consumers that need a strongly-typed view should cast to
 * `IDataConfig` from `@src/generators/data-generator`.
 */
export type WorksConfigCache = Record<string, unknown>;

export type {
    ImportSourceType,
    RelatedRepositories,
    RepoVisibility,
    RepositoryRole,
    RepositoryTarget,
};

export type WorksConfigSnapshot = ContractWorksConfigSnapshot & {
    additionalAgentsCount?: number;
};

export type SourceRepositoryAuth =
    | {
          mode: 'github_app_installation';
          providerId: 'github';
          installationId: string;
          installationRepositoryId?: string;
          repoFullName?: string;
      }
    | {
          mode: 'none';
      };

export type SourceRepository = ContractSourceRepository<Date> & {
    worksConfig?: WorksConfigSnapshot;
    auth?: SourceRepositoryAuth;
};
