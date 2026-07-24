import { DatabaseType } from '@src/database';

type AppType = 'cli' | 'api';

export const config = {
    getEnvironment() {
        return process.env.NODE_ENV;
    },
    getAppType(): AppType {
        return (process.env.APP_TYPE as AppType) || 'api';
    },
    isCli() {
        return this.getAppType() === 'cli';
    },

    trigger: {
        isEnabled() {
            return process.env.TRIGGER_ENABLED === 'true';
        },
        getSecretKey() {
            return process.env.TRIGGER_SECRET_KEY;
        },
        getApiUrl() {
            return process.env.TRIGGER_API_URL || 'https://api.trigger.dev';
        },
        getMachine() {
            return process.env.TRIGGER_MACHINE || undefined;
        },
        getInternalBaseUrl() {
            return process.env.TRIGGER_INTERNAL_API_URL;
        },
        getInternalSecret() {
            return process.env.TRIGGER_INTERNAL_SECRET;
        },
        shouldUseTrigger() {
            return this.isEnabled() && Boolean(this.getInternalSecret());
        },
    },

    /**
     * EW-683 / EW-685 P0 T3 — selector for the active job-runtime provider.
     *
     * Single instance-global knob per
     * [`docs/specs/architecture/job-runtime-providers.md`](../../../../docs/specs/architecture/job-runtime-providers.md)
     * §4. The shape of the contract lives in
     * `packages/plugin/src/contracts/capabilities/job-runtime.interface.ts`
     * (`JobRuntimeId` literal-union shipped EW-685 P0); the binding factory
     * that consumes this selector (`packages/agent/src/tasks/job-runtime.providers.ts`)
     * lands with EW-686 P1, alongside the rehoused `TriggerService` as the
     * first concrete provider.
     *
     * Until then this getter is **read but not bound** — every dispatcher
     * symbol still routes through `TriggerService` directly. Adding it
     * here ahead of the binding factory means:
     *   - Operators can set the env var in deploy manifests without
     *     waiting for the binding to land (the value sits inert).
     *   - The startup-log line that surfaces "active runtime id =
     *     `<id>`" (EW-685 P0 T6) has somewhere to read from.
     *   - The unknown-value fail-open path is exercised by tests today.
     */
    jobRuntime: {
        /**
         * Returns the active job-runtime provider id. Unknown / unset / empty
         * → falls back to `'trigger'` (the default per ADR-015) and emits a
         * startup-log warning when the value was set but unrecognised (T6
         * lands the log emitter). Lowercased + trimmed for resilience to
         * deploy-manifest typos (`Trigger ` → `trigger`).
         */
        getActiveProviderId(): 'trigger' | 'temporal' | 'bullmq' | 'pgboss' | 'inngest' {
            const raw = (process.env.EVER_WORKS_JOB_RUNTIME ?? '').trim().toLowerCase();
            if (raw === 'temporal' || raw === 'bullmq' || raw === 'pgboss' || raw === 'inngest') {
                return raw;
            }
            return 'trigger';
        },
        /**
         * True when the env var was set to a value other than `'trigger'`.
         * Surfaces "experimental runtime active" warnings until every
         * provider passes the conformance suite (per
         * [ADR-015](../../../../docs/specs/decisions/015-job-runtime-provider-pluggability.md)
         * §"All providers pass one shared conformance suite").
         */
        isExperimentalProvider(): boolean {
            return this.getActiveProviderId() !== 'trigger';
        },
    },

    // Database configuration
    database: {
        getType() {
            return (process.env.DATABASE_TYPE as DatabaseType) || 'better-sqlite3';
        },
        isSqlite() {
            return Boolean(config.database.getType()?.includes('sqlite'));
        },
        getUrl() {
            return process.env.DATABASE_URL;
        },
        getHost() {
            return process.env.DATABASE_HOST;
        },
        getPort() {
            return process.env.DATABASE_PORT;
        },
        autoMigrate() {
            // C-07 PR-B: default to `false` everywhere except the unit-test
            // environment. The audit batch 1 set DATABASE_AUTOMIGRATE=false
            // explicitly in every k8s manifest (PR-A); this flip makes the
            // safer default the new baseline so a future env / deploy that
            // forgets to set the flag still doesn't run TypeORM `synchronize`
            // against production. Opt back in by setting
            // DATABASE_AUTOMIGRATE=true explicitly.
            //
            // IMPORTANT: this controls TypeORM `synchronize` — auto-derive
            // schema from entities, DANGEROUS in prod. It is NOT the same
            // as "run pending migrations on startup"; that's
            // `runMigrations()` below. The two flags serve two different
            // purposes and must not be conflated.
            if (process.env.DATABASE_AUTOMIGRATE === 'true') return true;
            if (process.env.DATABASE_AUTOMIGRATE === 'false') return false;
            return process.env.NODE_ENV === 'test';
        },
        runMigrations() {
            // Whether to run pending TypeORM migrations on API startup.
            // Default `true` everywhere except `NODE_ENV=test` (the test
            // suite owns its own schema bootstrap via `synchronize`).
            //
            // This is the SAFE auto-apply path — TypeORM consults the
            // `migrations` table and applies anything new in order, one
            // transaction per migration. Idempotent across replicas (the
            // adapter takes a row-level lock on the table). Distinct from
            // `autoMigrate()` (which controls the dangerous `synchronize`
            // flag); these two flags should never be conflated.
            //
            // Opt out with RUN_MIGRATIONS=false (e.g. one-off debugging
            // pods that should not touch schema).
            if (process.env.RUN_MIGRATIONS === 'true') return true;
            if (process.env.RUN_MIGRATIONS === 'false') return false;
            return process.env.NODE_ENV !== 'test';
        },
        loggingEnabled() {
            return process.env.DATABASE_LOGGING === 'true';
        },
        sslMode() {
            return process.env.DATABASE_SSL_MODE === 'true';
        },
        databaseCaCert() {
            return process.env.DATABASE_CA_CERT;
        },
        getPath() {
            return process.env.DATABASE_PATH;
        },
        getInMemory() {
            return process.env.DATABASE_IN_MEMORY === 'true';
        },
        getUsername() {
            return process.env.DATABASE_USERNAME;
        },
        getPassword() {
            return process.env.DATABASE_PASSWORD;
        },
        getDatabaseName() {
            return process.env.DATABASE_NAME;
        },
    },

    // GitHub configuration
    github: {
        getApiKey() {
            return process.env.GH_APIKEY;
        },
        getOwner() {
            return process.env.GH_OWNER;
        },
    },

    githubApp: {
        getAppId() {
            return process.env.GITHUB_APP_ID;
        },
        getPrivateKey() {
            return process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
        },
    },

    // Git configuration
    git: {
        getName() {
            return process.env.GIT_NAME;
        },
        getEmail() {
            return process.env.GIT_EMAIL;
        },
    },

    // Sentry configuration
    sentry: {
        getDsn() {
            return process.env.SENTRY_DSN;
        },
        getProjectId() {
            return process.env.SENTRY_PROJECT_ID;
        },
    },

    // PostHog configuration
    posthog: {
        getApiKey() {
            return process.env.POSTHOG_API_KEY;
        },
        getHost() {
            return process.env.POSTHOG_HOST;
        },
    },

    subscriptions: {
        isEnabled() {
            return process.env.SUBSCRIPTIONS_ENABLED === 'true';
        },
        /**
         * E2E/test-only escape hatch (default OFF, hard-gated off in
         * production). When enabled, `changePlanSelfService` permits
         * self-assigning a PAID plan so the subscription tier-gating /
         * billing-grace e2e specs can drive a user onto STANDARD/PREMIUM
         * without a real billing integration wired in.
         *
         * The EW-711 #23 free→paid privilege-escalation guard stays fully
         * active in production: the flag is IGNORED unless
         * `NODE_ENV !== 'production'`, so even an accidental prod env value
         * can never re-open the self-serve paid escalation. Mirrors the
         * existing e2e-only relaxations (E2E_DISABLE_AUTH_THROTTLE,
         * REQUIRE_EMAIL_VERIFICATION=false).
         */
        allowSelfServePaidPlans() {
            return (
                process.env.NODE_ENV !== 'production' &&
                process.env.SUBSCRIPTIONS_ALLOW_SELF_SERVE_PAID === 'true'
            );
        },
        scheduledUpdatesEnabled() {
            return process.env.SCHEDULED_UPDATES_ENABLED !== 'false';
        },
        getDispatchIntervalMinutes() {
            return parseInt(process.env.SCHEDULED_UPDATES_DISPATCH_INTERVAL_MINUTES || '5');
        },
        getMaxBatch() {
            return parseInt(process.env.SCHEDULED_UPDATES_MAX_BATCH || '25');
        },
        getDefaultPlanCode() {
            return (process.env.SUBSCRIPTIONS_DEFAULT_PLAN as string) || 'free';
        },
        getMaxFailureBeforePause() {
            return parseInt(process.env.SCHEDULED_UPDATES_MAX_FAILURE_BEFORE_PAUSE || '3');
        },
        getScheduleStuckTimeoutMinutes() {
            return parseInt(process.env.SCHEDULE_STUCK_TIMEOUT_MINUTES || '180');
        },
        getPayPerUsePriceCents() {
            const usd = parseFloat(process.env.PAY_PER_USE_PRICE_USD || '5');
            return Math.max(0, Math.round(usd * 100));
        },
        // EW-628 data-repo instant-sync feature flags + tunables (Phase 8).
        // Both flags default to FALSE so the new code paths are inert in
        // production until the soak window completes; flip via env.
        // Spec: docs/specs/features/data-repo-instant-sync/spec.md §7.
        dataSync: {
            webhookEnabled() {
                return process.env.DATA_SYNC_WEBHOOK_ENABLED === 'true';
            },
            dispatcherEnabled() {
                return process.env.DATA_SYNC_DISPATCHER_ENABLED === 'true';
            },
            getDebounceMs() {
                return parseInt(process.env.DATA_SYNC_DEBOUNCE_MS || '30000');
            },
            getLockTtlSeconds() {
                return parseInt(process.env.DATA_SYNC_LOCK_TTL_SECONDS || '300');
            },
            getRetryBackoffSeconds() {
                return parseInt(process.env.DATA_SYNC_RETRY_BACKOFF_SECONDS || '300');
            },
            getSkipNoiseWindowMs() {
                return parseInt(process.env.DATA_SYNC_SKIP_NOISE_WINDOW_MS || '3600000');
            },
            getGenInProgressNoiseWindowMs() {
                return parseInt(process.env.DATA_SYNC_GEN_IN_PROGRESS_NOISE_WINDOW_MS || '900000');
            },
        },
    },

    websiteTemplate: {
        autoUpdateEnabled() {
            return process.env.WEBSITE_TEMPLATE_AUTO_UPDATE_ENABLED !== 'false';
        },
        getCatalogOrganization() {
            return process.env.WEBSITE_TEMPLATE_CATALOG_ORG || 'ever-works';
        },
        getDefaultTemplateId() {
            return process.env.WEBSITE_TEMPLATE_DEFAULT_ID || 'classic';
        },
        getBetaBranch() {
            return process.env.WEBSITE_TEMPLATE_BETA_BRANCH || 'stage';
        },
        getMinimalOwner() {
            return process.env.WEBSITE_TEMPLATE_MINIMAL_OWNER || 'ever-works';
        },
        getMinimalRepo() {
            return process.env.WEBSITE_TEMPLATE_MINIMAL_REPO || 'directory-web-minimal-template';
        },
        getMinimalBranch() {
            return process.env.WEBSITE_TEMPLATE_MINIMAL_BRANCH || 'main';
        },
        getMinimalBetaBranch() {
            return process.env.WEBSITE_TEMPLATE_MINIMAL_BETA_BRANCH || null;
        },
    },

    billing: {
        getDefaultCurrency() {
            return process.env.BILLING_DEFAULT_CURRENCY || 'usd';
        },
        stripe: {
            getSecretKey() {
                return process.env.STRIPE_SECRET_KEY;
            },
            getWebhookSecret() {
                return process.env.STRIPE_WEBHOOK_SECRET;
            },
        },
    },

    branding: {
        getAppName() {
            return process.env.APP_NAME || process.env.NEXT_PUBLIC_APP_NAME || 'Ever Works';
        },
        getCompanyOwner() {
            return process.env.COMPANY_OWNER || process.env.NEXT_PUBLIC_COMPANY_OWNER || 'Ever Co.';
        },
        getPlatformWebsite() {
            return (
                process.env.PLATFORM_WEBSITE ||
                process.env.NEXT_PUBLIC_COMPANY_OWNER_WEBSITE ||
                'https://ever.works'
            );
        },
    },

    // Ever Works platform-default providers used by the onboarding wizard.
    // Each is env-gated until the underlying external resource is provisioned.
    everWorks: {
        // "Ever Works Git" storage option — push customer repos to a
        // platform-owned GitHub org using a server-held PAT, so users can
        // ship without bringing their own GitHub account.
        git: {
            isEnabled() {
                return process.env.STORAGE_EVER_WORKS_GIT_ENABLED === 'true';
            },
            getOrg() {
                return process.env.EVER_WORKS_CUSTOMERS_GITHUB_ORG || 'ever-works-cloud';
            },
            getPat() {
                return process.env.EVER_WORKS_CUSTOMERS_GITHUB_PAT || '';
            },
            getVisibility(): 'private' | 'public' {
                return process.env.EVER_WORKS_CUSTOMERS_GITHUB_VISIBILITY === 'public'
                    ? 'public'
                    : 'private';
            },
        },

        // "Ever Works" deployment option — deploy to a platform-owned
        // Kubernetes cluster configured from env, with a per-user active-Works
        // cap so a single user can't exhaust the shared cluster.
        deploy: {
            isEnabled() {
                return process.env.DEPLOY_EVER_WORKS_ENABLED === 'true';
            },
            getKubeconfig() {
                return process.env.EVER_WORKS_DEPLOY_KUBECONFIG || '';
            },
            getKubeconfigPath() {
                return process.env.EVER_WORKS_DEPLOY_KUBECONFIG_PATH || '';
            },
            getNamespace() {
                return process.env.EVER_WORKS_DEPLOY_NAMESPACE || 'ever-works-tenants';
            },
            getIngressHostTemplate() {
                return process.env.EVER_WORKS_DEPLOY_INGRESS_HOST_TEMPLATE || '{slug}.ever.works';
            },
            getIngressClass() {
                return process.env.EVER_WORKS_DEPLOY_INGRESS_CLASS || 'nginx';
            },
            getTlsIssuer() {
                return process.env.EVER_WORKS_DEPLOY_TLS_ISSUER || 'letsencrypt-prod';
            },
            getRegistry() {
                return process.env.EVER_WORKS_DEPLOY_REGISTRY || '';
            },
            getMaxWorksPerUser() {
                const raw = parseInt(process.env.EVER_WORKS_DEPLOY_MAX_WORKS_PER_USER || '3', 10);
                return Number.isFinite(raw) && raw > 0 ? raw : 3;
            },
        },

        // "Ever Works DB" — a platform-managed SHARED Postgres so customer
        // Works get a working database without bringing their own. Distinct
        // from the platform's OWN database (`DATABASE_*`): today they point at
        // the same server, but keeping them separate lets us move customer
        // (tenant) DBs to a dedicated cluster later with only an env change.
        //
        // Two endpoints on purpose (mirrors Neon's pooled/unpooled split):
        //  - `getAdminUrl()` — a least-privilege provisioner (CREATEDB +
        //    CREATEROLE, NOT superuser) used ONLY for DDL (CREATE DATABASE /
        //    ROLE). MUST be a DIRECT/session endpoint — a transaction-pooled
        //    PgBouncer cannot run CREATE DATABASE.
        //  - `getHost()/getPort()` — the endpoint used to compose the per-Work
        //    `DATABASE_URL` injected into the deployed site. May be a PgBouncer
        //    LB reachable from a separate customer cluster (cross-cluster).
        sharedDb: {
            isEnabled() {
                return process.env.DB_EVER_WORKS_SHARED_ENABLED === 'true';
            },
            getAdminUrl() {
                return process.env.DB_EVER_WORKS_SHARED_ADMIN_URL || '';
            },
            getHost() {
                return process.env.DB_EVER_WORKS_SHARED_HOST || '';
            },
            getPort() {
                const raw = parseInt(process.env.DB_EVER_WORKS_SHARED_PORT || '5432', 10);
                return Number.isFinite(raw) && raw > 0 ? raw : 5432;
            },
            getSslMode() {
                return process.env.DB_EVER_WORKS_SHARED_SSLMODE || 'require';
            },
            // Prefix for the deterministic per-Work database + role names
            // (e.g. `ew_<workId>` / `ewr_<workId>`).
            getNamePrefix() {
                return (process.env.DB_EVER_WORKS_SHARED_NAME_PREFIX || 'ew').replace(
                    /[^a-z0-9]/gi,
                    '',
                );
            },
            // The feature can be OFFERED to users (isEnabled) yet not actually
            // provisionable until an operator wires the admin + host env.
            isReady() {
                return this.isEnabled() && Boolean(this.getAdminUrl()) && Boolean(this.getHost());
            },
        },
    },

    /**
     * PR-4 (domain-model evolution) — Idea → Work build executor.
     *
     * The Idea build pipeline is DORMANT on `develop`: creating a
     * `WorkAgentGoal` via `POST /me/work-proposals/:id/build` (or
     * retry / rebuild), or via Mission auto-build, flips the Idea to
     * QUEUED but nothing ever transitions the Goal past
     * WAITING_FOR_APPROVAL, so no Work is ever produced.
     *
     * This flag turns the executor on. It is **OFF by default**, so
     * merging this PR is a strict no-op in production until an
     * operator explicitly sets `EVER_WORKS_IDEA_BUILD_EXECUTOR_ENABLED=true`.
     * When off, every enqueue site short-circuits and behavior is
     * EXACTLY as today (Goal created, Idea QUEUED, nothing executes).
     *
     * `isDryRun()` defaults to `true`: even once the executor is
     * enabled, it does NOT spend on real AI/deploy — it synthesizes a
     * deterministic Goal outcome and drives the full completion state
     * machine (accept → acceptedWorkId / retry / failed) so the wiring
     * is observable without cost. Turning dry-run off is intentionally
     * a second, separate switch; the real-generation path is a
     * documented not-implemented stub (guarded by the budget guard),
     * so flipping dry-run off today produces a telemetry no-op rather
     * than real spend.
     *
     * NOTE (approval gate): enabling the executor implies auto-approval
     * of Idea-build Goals — `WorkAgentService.createGoal` seeds them at
     * WAITING_FOR_APPROVAL, and the executor advances them to RUNNING
     * without a human approval click. This is scoped to Idea-build
     * Goals (`ideaId` set); power-user direct Goals are untouched.
     */
    ideaBuildExecutor: {
        /** Master switch. Default `false` — production no-op until flipped. */
        isEnabled() {
            return process.env.EVER_WORKS_IDEA_BUILD_EXECUTOR_ENABLED === 'true';
        },
        /**
         * Dry-run mode. Default `true` (only `=== 'false'` disables it),
         * so an operator who enables the executor still cannot trigger
         * real spend without explicitly opting out of dry-run.
         */
        isDryRun() {
            return process.env.EVER_WORKS_IDEA_BUILD_EXECUTOR_DRY_RUN !== 'false';
        },
        /**
         * Deterministic synthetic outcome for dry-run mode: `success`
         * (default) drives the accept → acceptedWorkId path; `failure`
         * drives the terminal-failure path. Both exercise the full
         * completion state machine without real generation. Operators
         * flip this to watch either branch in a live dry-run.
         */
        getDryRunOutcome(): 'success' | 'failure' {
            return process.env.EVER_WORKS_IDEA_BUILD_EXECUTOR_DRY_RUN_OUTCOME === 'failure'
                ? 'failure'
                : 'success';
        },
    },

    // EW-120 Activity Feed pull-mode plumbing — per-Work HMAC secret is
    // encrypted at rest with this key. AES-256-GCM expects a 32-byte key;
    // the consumer service decodes hex / base64 / utf8 in that order.
    // Pull mode is the default transport (see Work.activitySyncMode).
    platformSync: {
        getEncryptionKey() {
            return process.env.PLATFORM_ENCRYPTION_KEY || '';
        },
    },

    // Agents/Skills/Tasks PR #1017 — Phase 6. Per-Agent heartbeat
    // dispatcher tunables. Defaults are conservative: the cron
    // fires every minute (cheapest if no Agents are due, matches
    // mission-tick), batches at 25 Agents per tick, and pauses an
    // Agent after 3 consecutive failures.
    agents: {
        dispatcherEnabled() {
            return process.env.AGENTS_DISPATCHER_ENABLED !== 'false';
        },
        getDispatchIntervalMinutes() {
            const raw = parseInt(process.env.AGENT_DISPATCH_INTERVAL_MINUTES || '1', 10);
            return Number.isFinite(raw) && raw > 0 ? raw : 1;
        },
        getMaxBatch() {
            const raw = parseInt(process.env.AGENT_DISPATCH_MAX_BATCH || '25', 10);
            return Number.isFinite(raw) && raw > 0 ? raw : 25;
        },
        getStuckTimeoutMinutes() {
            const raw = parseInt(process.env.AGENT_STUCK_TIMEOUT_MINUTES || '60', 10);
            return Number.isFinite(raw) && raw > 0 ? raw : 60;
        },
        getMaxRunDurationSeconds() {
            const raw = parseInt(process.env.AGENT_MAX_RUN_DURATION_SECONDS || '1800', 10);
            return Number.isFinite(raw) && raw > 0 ? raw : 1800;
        },
        /** Kill switch for the agent_runs stuck-run sweeper. Default on. */
        getRunSweeperEnabled() {
            return process.env.AGENT_RUN_SWEEPER_ENABLED !== 'false';
        },
        /**
         * Age past which a `queued`/`running` AgentRun is considered abandoned.
         *
         * Deliberately generous, because the two error costs are wildly
         * asymmetric. Sweeping too LATE means one task-agent pair cannot
         * dispatch for a few extra hours — recoverable. Sweeping too EARLY
         * destroys a live run's real result: the row reads `failed`, the
         * worker's `markCompleted` then no-ops against the CAS, and the user
         * sees the sweeper's message in the Activity tab where the summary
         * should be. That is unrecoverable, and it manufactures exactly the
         * class of corruption the terminal-transition CAS exists to prevent.
         *
         * Derived from the run-duration ceiling rather than hard-coded, so it
         * self-corrects if that ceiling is raised. The ceiling is the largest
         * `maxDuration` across the three agent tasks (agent-task-execute pins
         * 3600s), not just this config's value.
         *
         * The floor clamp is the most important line here: a worker may burn
         * up to 3 attempts, so anything below 3x the ceiling can reap a run
         * that is legitimately still retrying. Without the clamp,
         * `AGENT_RUN_STUCK_SWEEP_MINUTES=30` would silently reintroduce that.
         */
        getRunStuckSweepMinutes() {
            const ceilingMinutes = Math.ceil(Math.max(3600, this.getMaxRunDurationSeconds()) / 60);
            const floor = ceilingMinutes * 3;
            const raw = parseInt(process.env.AGENT_RUN_STUCK_SWEEP_MINUTES || '', 10);
            const configured = Number.isFinite(raw) && raw > 0 ? raw : ceilingMinutes * 6;
            return Math.max(floor, configured);
        },
        /**
         * Rows swept per tick. Bounded on purpose — `agent_runs` is the
         * high-cardinality child table, and a post-outage backlog is precisely
         * when this runs. Successive ticks drain; there is no pagination loop,
         * so a runaway predicate cannot become an unbounded write storm.
         */
        getRunStuckSweepBatch() {
            const raw = parseInt(process.env.AGENT_RUN_STUCK_SWEEP_BATCH || '200', 10);
            return Number.isFinite(raw) && raw > 0 ? raw : 200;
        },
    },

    /**
     * EW-643 Phase 3 — Knowledge Base operator knobs.
     *
     * Default-on for normalize so an upload of a `.mov` doesn't silently
     * produce an unplayable workbench viewer entry. Operators flip
     * `KB_MEDIA_NORMALIZE=false` to bypass the ffmpeg lane entirely
     * (the KB ingest path then dispatches kb-transcribe directly).
     *
     * The pinned provider env is consumed by `AiFacadeService.transcribe`
     * — see the JSDoc on `IAiProviderPlugin.transcribe` for the
     * selection chain. Without a pin, the facade falls back to the
     * first AI provider plugin whose transcribe is defined.
     */
    kb: {
        /** Master switch for the ffmpeg normalize stage. Default `true`. */
        isMediaNormalizeEnabled(): boolean {
            const v = process.env.KB_MEDIA_NORMALIZE;
            if (v === undefined || v === '') return true;
            return v.toLowerCase() === 'true' || v === '1';
        },
        /** Path to the ffmpeg binary. Default `ffmpeg` (resolves via $PATH). */
        getFfmpegBin(): string {
            return process.env.KB_FFMPEG_BIN || 'ffmpeg';
        },
        /** Video codec. libx264 is the broadest browser-compatible default. */
        getVideoOutputCodec(): string {
            return process.env.KB_VIDEO_OUTPUT_CODEC || 'libx264';
        },
        /** Video output container/extension. `mp4` is the spec §14.3 default. */
        getVideoOutputExt(): string {
            return process.env.KB_VIDEO_OUTPUT_EXT || 'mp4';
        },
        /** Audio codec. libmp3lame keeps Whisper-friendly file sizes. */
        getAudioOutputCodec(): string {
            return process.env.KB_AUDIO_OUTPUT_CODEC || 'libmp3lame';
        },
        /** Audio output container/extension. `mp3` is the spec §14.3 default. */
        getAudioOutputExt(): string {
            return process.env.KB_AUDIO_OUTPUT_EXT || 'mp3';
        },
        /**
         * Operator-pinned transcription provider plugin id. When set,
         * `AiFacadeService.transcribe` ONLY tries this provider — no
         * silent fallback. Leave unset to let the facade auto-resolve
         * to the first available provider whose `transcribe` is
         * defined.
         */
        getTranscriptionProviderId(): string | undefined {
            const v = process.env.KB_TRANSCRIPTION_PROVIDER_ID;
            return v && v.length > 0 ? v : undefined;
        },
        /** KbDocumentClass for materialized transcripts. `research` per spec §14.3. */
        getTranscriptionTargetClass(): string {
            return process.env.KB_TRANSCRIPTION_TARGET_CLASS || 'research';
        },
        /** BCP-47 language hint forwarded to the transcribe call. Unset = auto-detect. */
        getTranscriptionLanguage(): string | undefined {
            const v = process.env.KB_TRANSCRIPTION_LANGUAGE;
            return v && v.length > 0 ? v : undefined;
        },
        /**
         * EW-643 Phase 3 slice 4a — how long an upload may sit in
         * `extractionStatus='running'` before the daily reconcile sweep
         * declares it stale and force-marks it `failed`. Default 24h —
         * comfortably longer than the `kb-transcribe` task's 30-minute
         * `maxDuration`, so a slow-but-legitimate retry isn't mistaken
         * for a dead row.
         */
        getReconcileStaleAfterMs(): number {
            const raw = parseInt(process.env.KB_RECONCILE_STALE_AFTER_MS || '', 10);
            return Number.isFinite(raw) && raw > 0 ? raw : 24 * 60 * 60 * 1000;
        },
        /**
         * EW-642 — operator-pinned vector-store provider plugin id.
         * When set, `VectorStoreFacadeService` ONLY tries this provider
         * — no silent fallback. Leave unset to let the facade resolve
         * via per-Work pin → scope-active → first-available chain.
         * Mirrors the `KB_TRANSCRIPTION_PROVIDER_ID` knob shape.
         */
        getVectorStoreProviderId(): string | undefined {
            const v = process.env.KB_VECTOR_STORE_PROVIDER_ID;
            return v && v.length > 0 ? v : undefined;
        },
        /**
         * EW-642 — embedding routing mode. `'pgvector'` keeps the
         * legacy `WorkKnowledgeChunkRepository` SQL path; `'external'`
         * forces the facade-routed `IVectorStorePlugin` path; `'auto'`
         * (default) lets the facade pick based on whether a non-pgvector
         * vector-store plugin is registered. Free-form string so the
         * future "hybrid" / "shadow-write" modes don't need a contract
         * bump.
         */
        getEmbeddingMode(): 'pgvector' | 'external' | 'auto' | string {
            return process.env.KB_EMBEDDING_MODE || 'auto';
        },
    },
};
