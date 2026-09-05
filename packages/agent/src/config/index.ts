import {
    clampQueuedMaxAgeSec,
    DEFAULT_FLEET_AGENT_EXECUTION_MODE,
    DEFAULT_FLEET_AGENT_EXECUTION_PERMISSION_MODE,
    DEFAULT_FLEET_AGENT_EXECUTION_PROVIDER,
    FLEET_AGENT_CREDENTIAL_ENV_NAMES,
    FLEET_AGENT_EXECUTION_DEFAULT_TIMEOUT_SEC,
    FLEET_AGENT_EXECUTION_MAX_BUDGET_USD,
    FLEET_AGENT_EXECUTION_MAX_TIMEOUT_SEC,
    FLEET_AGENT_EXECUTION_MIN_TIMEOUT_SEC,
    FLEET_AGENT_EXECUTION_MODEL_PATTERN,
    isFleetAgentExecutionEffort,
    isFleetAgentExecutionMode,
    isFleetAgentExecutionPermissionMode,
    isFleetAgentExecutionProvider,
    type FleetAgentExecutionEffort,
    type FleetAgentExecutionMode,
    type FleetAgentExecutionPermissionMode,
    type FleetAgentExecutionProvider,
    type FleetJobKind,
    FLEET_DEFAULT_CREDENTIAL_ROTATION_OVERLAP_MS,
    FLEET_DEFAULT_ENROLLMENT_TOKEN_TTL_MS,
    FLEET_DEFAULT_MAX_CAPABILITY_TAG_LENGTH,
    FLEET_DEFAULT_MAX_CAPABILITY_TAGS,
    FLEET_DEFAULT_NODE_OFFLINE_AFTER_MS,
    FLEET_DEFAULT_NODE_OFFLINE_NOTICE_AFTER_MS,
    FLEET_MAX_CAPABILITY_TAG_LENGTH_CEILING,
    FLEET_MAX_CAPABILITY_TAGS_CEILING,
    FLEET_MAX_CREDENTIAL_ROTATION_OVERLAP_MS,
    FLEET_MAX_DAILY_COST_CEILING_CENTS,
    FLEET_MIN_CREDENTIAL_ROTATION_OVERLAP_MS,
    FLEET_MIN_ENROLLMENT_TOKEN_TTL_MS,
    FLEET_MIN_NODE_OFFLINE_AFTER_MS,
} from '@ever-works/contracts';
import { DatabaseType } from '@src/database';

import {
    catalogCreditsMarginPercent,
    catalogPaygMaxMonthlyCapCredits,
} from '../subscriptions/billing/stripe-catalog';
type AppType = 'cli' | 'api';

/**
 * Fleet cost accounting (EW-777) — parse a dollar env var into whole
 * cents, or null when unset. Unlike the clamped knobs, a nonsense value
 * (non-numeric, zero, negative, above the contract cap) is `null` = "no
 * ceiling", NOT a clamped one: a ceiling nobody typed correctly must not
 * silently become a ceiling nobody chose. The service logs which value is
 * in force, and the settings page shows it.
 */
function usdEnvToCents(raw: string | undefined): number | null {
    const usd = parseFloat(raw || '');
    if (!Number.isFinite(usd) || usd <= 0) return null;
    const cents = Math.round(usd * 100);
    return cents >= 1 && cents <= FLEET_MAX_DAILY_COST_CEILING_CENTS ? cents : null;
}

/**
 * Parse an integer env var into a clamped range, falling back to
 * `fallback` when unset/unparseable. Used by the Fleet knobs, where a
 * deploy-manifest typo must degrade to the documented default rather
 * than to `NaN` (which silently expires every enrollment token).
 */
function clampedIntEnv(
    raw: string | undefined,
    fallback: number,
    min: number,
    max: number,
): number {
    const parsed = parseInt(raw ?? '', 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(Math.max(parsed, min), max);
}

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
        /**
         * Per-attempt deadline for one worker → API internal-RPC request.
         *
         * Chosen to sit BELOW the infrastructure timeouts so the client is the
         * thing that gives up first, predictably and with an error that names
         * the deadline — instead of inheriting whatever the hop in front of it
         * decides. In production the worker runs on Trigger.dev cloud and
         * reaches `https://api.ever.works/internal/trigger`, so the request
         * crosses two proxies that will each kill it on their own schedule:
         *
         *  - nginx-ingress, whose `proxy_read_timeout` default is **60s** (no
         *    override annotation exists in `.deploy/`) → 504.
         *  - Cloudflare in front of it, ~**100s** origin read → 524.
         *
         * 45s leaves ~15s of headroom under the tighter of the two so TLS
         * setup and Cloudflare→origin latency can never push us past it.
         *
         * A deadline does NOT cancel the work already running on the API pod —
         * it only stops the worker waiting for it. That is precisely why
         * timing out must not imply retrying; see `RETRY_SAFE_REMOTE_METHODS`
         * in `trigger-internal-api.client.ts`.
         */
        getInternalRequestTimeoutMs() {
            const raw = parseInt(process.env.TRIGGER_INTERNAL_REQUEST_TIMEOUT_MS || '45000', 10);
            return Number.isFinite(raw) && raw > 0 ? raw : 45000;
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
        getActiveProviderId(): 'trigger' | 'temporal' | 'bullmq' | 'pgboss' | 'inngest' | 'node' {
            const raw = (process.env.EVER_WORKS_JOB_RUNTIME ?? '').trim().toLowerCase();
            if (
                raw === 'temporal' ||
                raw === 'bullmq' ||
                raw === 'pgboss' ||
                raw === 'inngest' ||
                // Desktop PRD M4 — the fleet runtime (job-runtime-node).
                raw === 'node'
            ) {
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

    /**
     * Desktop PRD §6.2 / M4 — operator knobs for the `node` job runtime
     * (the `job-runtime-node` plugin, whose "queue" is the owner's Fleet).
     *
     * These are the `FLEET_NODE_*` names the plugin already declares in
     * its manifest + settings schema; reading them HERE is what lets the
     * API-side producer size a fleet job (lease TTL), narrow which
     * machines may lease it (capability tags) and know what a node is
     * actually supposed to run (`FLEET_NODE_AGENT_TASK_COMMAND`) without
     * every call site re-parsing `process.env`.
     *
     * Nothing in this group turns the fleet runtime ON by itself — that
     * is still `EVER_WORKS_JOB_RUNTIME=node` (or a tenant overlay row).
     * `FLEET_NODE_RUNTIME_ENABLED=false` is a ROUTING SELECTOR that wins
     * over both — work falls back to the cloud. It is NOT a panic control;
     * the control that stops work is the DB-backed global stop flag
     * (`FleetKillSwitchService`, EW-778).
     */
    fleetNode: {
        /**
         * Origin the nodes poll for work. Informational on the server
         * side (the node stores its own `apiUrl` at enrollment); exposed
         * so the Fleet UI and the installer can render one value.
         */
        getApiUrl(): string | undefined {
            const raw = (process.env.FLEET_NODE_API_URL || '').trim();
            return raw ? raw : undefined;
        },
        /**
         * Requested claim duration for jobs this install enqueues onto
         * the fleet. Unset/nonsense → undefined, which lets the server's
         * own `clampLeaseTtlSec` default apply rather than inventing a
         * second default here.
         */
        getLeaseTtlSeconds(): number | undefined {
            const raw = parseInt(process.env.FLEET_NODE_LEASE_TTL_SECONDS || '', 10);
            return Number.isFinite(raw) && raw > 0 ? raw : undefined;
        },
        /**
         * Queue SLA (self-build slice S / EW-775): the longest a `queued`
         * job of `kind` may wait for an eligible runner before
         * `FleetJobService.expireQueued` fails it.
         *
         * `FLEET_NODE_QUEUE_MAX_AGE_SECONDS` sets every kind; the per-kind
         * `FLEET_NODE_QUEUE_MAX_AGE_SECONDS_AGENT_TASK` /
         * `_ACCEPTANCE_CHECKS` / `_BROWSER_CHECK` overrides it. Always
         * passed through `clampQueuedMaxAgeSec`: unset or nonsense is the
         * kind's default, out-of-range is clamped, and there is no value
         * that means "wait forever" — a deploy-manifest typo must fail
         * closed to the documented bound, not to an unbounded queue.
         */
        getQueuedMaxAgeSeconds(kind: FleetJobKind): number {
            const suffix = kind.toUpperCase().replace(/-/g, '_');
            const perKind = parseInt(
                process.env[`FLEET_NODE_QUEUE_MAX_AGE_SECONDS_${suffix}`] || '',
                10,
            );
            if (Number.isFinite(perKind) && perKind > 0) {
                return clampQueuedMaxAgeSec(kind, perKind);
            }
            const all = parseInt(process.env.FLEET_NODE_QUEUE_MAX_AGE_SECONDS || '', 10);
            return clampQueuedMaxAgeSec(kind, Number.isFinite(all) && all > 0 ? all : undefined);
        },
        /**
         * Capability tags a node must advertise to be eligible for this
         * install's work. Empty (the default) means any enrolled node —
         * narrowing is opt-in, because an over-narrow tag set produces a
         * queue nothing can ever lease.
         */
        getRequiredCapabilities(): string[] {
            const raw = process.env.FLEET_NODE_REQUIRED_CAPABILITIES || '';
            const out: string[] = [];
            for (const entry of raw.split(',')) {
                const tag = entry.trim();
                if (!tag || out.includes(tag)) continue;
                out.push(tag);
            }
            return out;
        },
        /**
         * Kill switch. `false` disables the fleet runtime even when it is
         * the selected provider — the dispatch path then falls back to
         * the platform default rather than writing rows nothing runs.
         * `true` force-enables it for an install that has no dispatcher
         * factory wired yet (dev). Unset = "decide from the wiring".
         */
        isRuntimeEnabled(): boolean | undefined {
            const raw = (process.env.FLEET_NODE_RUNTIME_ENABLED || '').trim().toLowerCase();
            if (raw === 'false' || raw === '0') return false;
            if (raw === 'true' || raw === '1') return true;
            return undefined;
        },
        /**
         * Command template a node runs for one `agent-task` job.
         * Supports `{taskId}`, `{runId}` and `{agentId}` placeholders,
         * each substituted with an id validated against a strict
         * `[A-Za-z0-9_-]` pattern first (a fleet node runs this through a
         * shell, so an unvalidated substitution would be a command
         * injection).
         *
         * Unset means the platform has nothing to ask a node to DO for a
         * general agent run: the producer still enqueues, and the node
         * fails the job naming this variable. Loud degradation beats a
         * queue that silently succeeds at nothing.
         */
        getAgentTaskCommand(): string | undefined {
            const raw = (process.env.FLEET_NODE_AGENT_TASK_COMMAND || '').trim();
            return raw ? raw : undefined;
        },
        /**
         * Absolute directory ON THE NODE that `agent-task` steps run in.
         * Unset lets the node choose (its own working directory).
         */
        getAgentTaskWorkspacePath(): string | undefined {
            const raw = (process.env.FLEET_NODE_AGENT_TASK_WORKSPACE || '').trim();
            return raw ? raw : undefined;
        },
        /**
         * Environment variable NAMES an `agent-task` step may read from
         * the node's own environment.
         *
         * A node scrubs its subprocess env and drops secret-shaped names
         * unless a step grants them, so without this the CLI credentials
         * never arrive and the agent fails looking like a model problem.
         * Only `HOME`-based logins work ungranted, which covers a person's
         * desktop and not a headless node, a container, an API key, or a
         * ChatGPT workspace access token.
         *
         * Defaults to the well-known Claude/Codex credential names. That
         * is not an escalation: `HOME` is already allowlisted, so a step
         * can already read `~/.claude/.credentials.json`. Granting a name
         * a machine does not set is a no-op, which is why ONE list works
         * for a fleet of differently-credentialled machines.
         *
         * Set to an empty string to grant nothing.
         */
        getAgentTaskEnvPassthrough(): string[] {
            const raw = process.env.FLEET_NODE_AGENT_TASK_ENV_PASSTHROUGH;
            if (raw === undefined) {
                return [...FLEET_AGENT_CREDENTIAL_ENV_NAMES];
            }
            return raw
                .split(',')
                .map((name) => name.trim())
                .filter((name) => name.length > 0);
        },

        // ── Agent execution v2 — model CLIs on the node ─────────────
        //
        // Instance-level DEFAULTS for how a fleet node executes an
        // `agent-task`. A tenant overrides them through the
        // `job-runtime-node` plugin's settings (same keys, resolved per
        // user by the planner); these getters are the floor that applies
        // when no tenant setting is present.

        /**
         * `command` (legacy template, the default) or `model-cli` (the
         * platform assembles the agent's instructions and the node runs
         * a local Claude Code / Codex on them). Unknown values fall back
         * to the default so a typo can never silently switch modes.
         */
        getAgentExecutionMode(): FleetAgentExecutionMode {
            const raw = (process.env.FLEET_NODE_AGENT_EXECUTION_MODE || '').trim();
            return isFleetAgentExecutionMode(raw) ? raw : DEFAULT_FLEET_AGENT_EXECUTION_MODE;
        },
        /** Which local CLI the node drives in `model-cli` mode. */
        getAgentExecutionProvider(): FleetAgentExecutionProvider {
            const raw = (process.env.FLEET_NODE_AGENT_EXECUTION_PROVIDER || '').trim();
            return isFleetAgentExecutionProvider(raw)
                ? raw
                : DEFAULT_FLEET_AGENT_EXECUTION_PROVIDER;
        },
        /**
         * Model id handed to the CLI (`--model`). Unset = the CLI's own
         * default. Refused (→ undefined) unless it is an opaque
         * identifier, because it ends up on a command line.
         */
        getAgentExecutionModel(): string | undefined {
            const raw = (process.env.FLEET_NODE_AGENT_EXECUTION_MODEL || '').trim();
            return raw && FLEET_AGENT_EXECUTION_MODEL_PATTERN.test(raw) ? raw : undefined;
        },
        /** Claude Code `--effort`. Unset = the CLI's default. */
        getAgentExecutionEffort(): FleetAgentExecutionEffort | undefined {
            const raw = (process.env.FLEET_NODE_AGENT_EXECUTION_EFFORT || '').trim();
            return isFleetAgentExecutionEffort(raw) ? raw : undefined;
        },
        /** What the CLI may do without asking. Default `acceptEdits`. */
        getAgentExecutionPermissionMode(): FleetAgentExecutionPermissionMode {
            const raw = (process.env.FLEET_NODE_AGENT_EXECUTION_PERMISSION_MODE || '').trim();
            return isFleetAgentExecutionPermissionMode(raw)
                ? raw
                : DEFAULT_FLEET_AGENT_EXECUTION_PERMISSION_MODE;
        },
        /**
         * Wall-clock budget for one model run, clamped into the node's
         * supported range. Default 20 minutes.
         */
        getAgentExecutionTimeoutSeconds(): number {
            const raw = parseInt(process.env.FLEET_NODE_AGENT_EXECUTION_TIMEOUT_SECONDS || '', 10);
            if (!Number.isFinite(raw) || raw <= 0) {
                return FLEET_AGENT_EXECUTION_DEFAULT_TIMEOUT_SEC;
            }
            return Math.min(
                Math.max(raw, FLEET_AGENT_EXECUTION_MIN_TIMEOUT_SEC),
                FLEET_AGENT_EXECUTION_MAX_TIMEOUT_SEC,
            );
        },
        /**
         * Per-run dollar cap handed to the CLI. Unset/nonsense = no cap
         * (the CLI's own limits and the platform budgets still apply).
         */
        getAgentExecutionMaxBudgetUsd(): number | undefined {
            const raw = parseFloat(process.env.FLEET_NODE_AGENT_EXECUTION_MAX_BUDGET_USD || '');
            // Same ceiling the wire contract enforces (`normalizeFleetAgentModelExecution`):
            // a value the node would refuse must never be planned in the first place.
            return Number.isFinite(raw) && raw > 0 && raw <= FLEET_AGENT_EXECUTION_MAX_BUDGET_USD
                ? raw
                : undefined;
        },
        /**
         * Whether runs may bypass the CLI's permission prompts entirely
         * (`--dangerously-skip-permissions`). Default OFF; an unattended
         * node usually needs it, which is exactly why it is an explicit
         * operator decision recorded on every job.
         */
        isAgentExecutionSkipPermissionsEnabled(): boolean {
            const raw = (process.env.FLEET_NODE_AGENT_EXECUTION_SKIP_PERMISSIONS || '')
                .trim()
                .toLowerCase();
            return raw === 'true' || raw === '1';
        },
    },

    /**
     * Fleet — the owner's own machines (desktop nodes, headless nodes,
     * their configured clusters) and the job-lease channel that runs
     * work on them.
     *
     * ONE switch for the whole surface: the `/api/fleet/**` controllers
     * (registry, admin and the node work channel), the Fleet settings
     * page and its nav entry. Turning it off is a deployment saying "my
     * users have no machines of their own" — the platform's own runtimes
     * are untouched.
     *
     * **Default ON**, deliberately, and that is not a style choice: the
     * Fleet surface already ships, so a default-off flag would silently
     * REMOVE a working feature from every existing deployment on
     * upgrade. Operators who want it gone set `FLEET_ENABLED=false`
     * explicitly, exactly like `SCHEDULED_UPDATES_ENABLED`.
     *
     * Off is a hard gate, not a hint: the API answers 404 (not 403) on
     * every fleet route, so a disabled deployment does not even confirm
     * the surface exists, and an enrolled node's credential buys nothing.
     */
    fleet: {
        isEnabled(): boolean {
            return process.env.FLEET_ENABLED !== 'false';
        },
        /**
         * How long a one-time enrollment token stays redeemable.
         * Default 15 minutes (`FLEET_ENROLLMENT_TOKEN_TTL_MS`), floored
         * at 30s so a token can always actually be typed in.
         */
        getEnrollmentTokenTtlMs(): number {
            return clampedIntEnv(
                process.env.FLEET_ENROLLMENT_TOKEN_TTL_MS,
                FLEET_DEFAULT_ENROLLMENT_TOKEN_TTL_MS,
                FLEET_MIN_ENROLLMENT_TOKEN_TTL_MS,
                Number.MAX_SAFE_INTEGER,
            );
        },
        /**
         * Credential lifecycle (EW-799) — how long BOTH credentials are
         * accepted after a node rotates itself
         * (`FLEET_CREDENTIAL_ROTATION_OVERLAP_MS`, default 15 minutes,
         * floor 30s, ceiling 24h).
         *
         * The window exists so a machine can finish the job it is holding
         * and persist its new secret before the old one dies. It closes on
         * a clock, never on a callback: a node that never comes back still
         * loses its old credential on time. Long enough to survive a
         * restart; the 24h ceiling is where a handover window would stop
         * being a handover and become a second permanent credential.
         */
        getCredentialRotationOverlapMs(): number {
            return clampedIntEnv(
                process.env.FLEET_CREDENTIAL_ROTATION_OVERLAP_MS,
                FLEET_DEFAULT_CREDENTIAL_ROTATION_OVERLAP_MS,
                FLEET_MIN_CREDENTIAL_ROTATION_OVERLAP_MS,
                FLEET_MAX_CREDENTIAL_ROTATION_OVERLAP_MS,
            );
        },
        /**
         * Silence after which an `online` node is swept to `offline` by
         * the next owner-scoped list read. Default 5 minutes.
         *
         * Shortening this below a node's heartbeat cadence makes healthy
         * nodes flap; the 30s floor stops the value becoming nonsense,
         * it does not stop it becoming unwise.
         */
        getNodeOfflineAfterMs(): number {
            return clampedIntEnv(
                process.env.FLEET_NODE_OFFLINE_AFTER_MS,
                FLEET_DEFAULT_NODE_OFFLINE_AFTER_MS,
                FLEET_MIN_NODE_OFFLINE_AFTER_MS,
                Number.MAX_SAFE_INTEGER,
            );
        },
        /**
         * Fleet health signals (EW-776) — how long an already-offline node
         * stays gone before its owner gets a SECOND, louder Inbox notice.
         * Default 30 minutes (`FLEET_NODE_OFFLINE_NOTICE_AFTER_MS`).
         *
         * Floored at {@link getNodeOfflineAfterMs}, not at a constant: a
         * window shorter than the sweep window would fire the escalation
         * before the node is even considered offline, i.e. two notices for
         * one event. The floor is read live so lowering it below a raised
         * `FLEET_NODE_OFFLINE_AFTER_MS` still cannot invert the pair.
         */
        getNodeOfflineNoticeAfterMs(): number {
            return clampedIntEnv(
                process.env.FLEET_NODE_OFFLINE_NOTICE_AFTER_MS,
                FLEET_DEFAULT_NODE_OFFLINE_NOTICE_AFTER_MS,
                this.getNodeOfflineAfterMs(),
                Number.MAX_SAFE_INTEGER,
            );
        },
        /** Max capability tags one node may advertise. Default 16, hard ceiling 64. */
        getMaxCapabilityTags(): number {
            return clampedIntEnv(
                process.env.FLEET_MAX_CAPABILITY_TAGS,
                FLEET_DEFAULT_MAX_CAPABILITY_TAGS,
                1,
                FLEET_MAX_CAPABILITY_TAGS_CEILING,
            );
        },
        /** Max length of one capability tag. Default 32, hard ceiling 128. */
        getMaxCapabilityTagLength(): number {
            return clampedIntEnv(
                process.env.FLEET_MAX_CAPABILITY_TAG_LENGTH,
                FLEET_DEFAULT_MAX_CAPABILITY_TAG_LENGTH,
                1,
                FLEET_MAX_CAPABILITY_TAG_LENGTH_CEILING,
            );
        },
        /**
         * Fleet cost accounting (EW-777) — deployment-default DAILY (UTC
         * day) model-spend ceiling for ONE node, in cents, or null for no
         * ceiling. `FLEET_NODE_DAILY_COST_CEILING_USD`; a node's own
         * `dailyCostCeilingCents` column overrides it. Unset (the default)
         * means no ceiling and zero behaviour change — enabling one is an
         * explicit decision, and crossing it DRAINS the node until its
         * owner re-enables it.
         */
        getDefaultNodeDailyCostCeilingCents(): number | null {
            return usdEnvToCents(process.env.FLEET_NODE_DAILY_COST_CEILING_USD);
        },
        /**
         * Deployment-default FLEET-WIDE daily ceiling (every node of one
         * owner, summed), in cents, or null. `FLEET_DAILY_COST_CEILING_USD`;
         * the owner's `fleet_cost_policies` row overrides it. Same
         * unset-means-none rule as the per-node default.
         */
        getDefaultFleetDailyCostCeilingCents(): number | null {
            return usdEnvToCents(process.env.FLEET_DAILY_COST_CEILING_USD);
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
        /**
         * E2E-only fixture escape hatch for seat-consuming setup writes.
         *
         * The sharded suite enables subscriptions so billing scenarios can
         * exercise real plan behavior, but its unrelated scenarios create
         * agents and members for fresh users. A fresh free user already uses
         * the plan's one seat, so those fixture writes otherwise fail with a
         * 402 before the behavior under test is reached.
         *
         * Production ignores this value even if it is configured by mistake.
         */
        bypassSeatLimitsInE2E() {
            return (
                process.env.NODE_ENV !== 'production' &&
                process.env.E2E_BYPASS_SEAT_LIMITS === 'true'
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
        // Pay-as-you-go (billing spec §3.5).
        payg: {
            /**
             * Hard ceiling for a self-service monthly cap. Defaults to the
             * catalog's `payg.maxMonthlyCapCredits`; raise per deployment.
             */
            getMaxMonthlyCapCredits() {
                const parsed = parseInt(process.env.PAYG_MAX_MONTHLY_CAP_CREDITS || '');
                return Number.isFinite(parsed) && parsed > 0
                    ? Math.max(500, parsed)
                    : catalogPaygMaxMonthlyCapCredits();
            },
        },
        // Credits ledger (pricing Wave 9 M1) — credits are the usage
        // currency layered on the costCents metering. Every knob is
        // env-configurable per the Wave 9 house rule; defaults keep
        // 1 credit = 1 cent at the catalog margin (billing spec §3.4).
        credits: {
            /** costCents → credits conversion: credits per $1 (default 100 = 1¢/credit). */
            getCreditsPerDollar() {
                const parsed = parseFloat(process.env.CREDITS_PER_DOLLAR || '100');
                return Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
            },
            /**
             * Platform margin applied at debit time, in percent. An explicit
             * `CREDITS_MARGIN_PERCENT` wins (self-hosters); otherwise the
             * catalog's `creditsMarginPercent` (billing spec §3.4) — the one
             * number that decides whether a credit pack is sold at a loss
             * lives next to the pack prices and ships with a test.
             */
            getMarginPercent() {
                const raw = process.env.CREDITS_MARGIN_PERCENT;
                if (raw !== undefined && raw !== '') {
                    const parsed = parseFloat(raw);
                    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
                }
                return catalogCreditsMarginPercent();
            },
            /**
             * When true, consumption may take a balance below zero
             * (overdraft). Default false: a debit that would cross zero
             * is rejected with `InsufficientCreditsError` (mapped 4xx —
             * never an unmapped 500), per the billing/usage PRD §6.
             */
            allowOverdraft() {
                return process.env.CREDITS_ALLOW_OVERDRAFT === 'true';
            },
            /** Daily free credits fallback when the plan has no entitlement row. */
            getDailyFreeCredits() {
                const parsed = parseInt(process.env.CREDITS_DAILY_FREE || '50');
                return Number.isFinite(parsed) && parsed >= 0 ? parsed : 50;
            },
            /** EntitlementsService in-memory cache TTL (ms, default 60s). */
            getEntitlementsCacheTtlMs() {
                const parsed = parseInt(process.env.CREDITS_ENTITLEMENTS_CACHE_TTL_MS || '60000');
                return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60000;
            },
            /** Users per page while sweeping the daily grant (default 500). */
            getDailyGrantBatchSize() {
                const parsed = parseInt(process.env.CREDITS_DAILY_GRANT_BATCH || '500');
                return Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
            },
            /**
             * Credits enforcement (pricing Wave 9 M2; billing spec FR-30).
             *
             * Explicit `CREDITS_ENFORCEMENT=on|true|1` / `off|false|0`
             * always wins. UNSET resolves to **on when the billing
             * provider is configured** (`STRIPE_SECRET_KEY` present —
             * money is real, so a zero balance with no pay-as-you-go
             * headroom parks new runs) and **off otherwise** (self-hosted,
             * dev, CI — exactly the pre-2026-08 behaviour). Debits and
             * metering are unaffected by this flag; it gates ONLY whether
             * the dispatch gate parks runs
             * (`queuedReason='insufficient-credits'`).
             */
            isEnforcementEnabled() {
                const raw = (process.env.CREDITS_ENFORCEMENT || '').toLowerCase();
                if (raw === 'on' || raw === 'true' || raw === '1') return true;
                if (raw === 'off' || raw === 'false' || raw === '0') return false;
                const stripeKey = process.env.STRIPE_SECRET_KEY;
                return typeof stripeKey === 'string' && stripeKey.trim().length > 0;
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

    /**
     * Agent Plugins standard interop — support for the open, cross-vendor
     * package format at <https://github.com/agentplugins/agent-plugins-spec>.
     *
     * Lives HERE, in the agent package, rather than in `apps/api`'s config,
     * and that is not a stylistic choice: the first consumer is
     * `SkillsFacadeService` in `packages/agent/src/facades/`, which has no
     * import path to `apps/api`. Putting the flag in the API-tier constants
     * would strand it from its own reader.
     */
    agentPlugins: {
        /**
         * Master switch. Default `false`, so every existing deployment keeps
         * behaving exactly as it does today: no package registry is read, no
         * additional catalog source is consulted, nothing changes.
         */
        isEnabled() {
            return (process.env.FEATURE_AGENT_PLUGINS ?? 'false').toLowerCase() === 'true';
        },

        /**
         * Directories scanned for locally-installed packages.
         *
         * Three deliberate decisions:
         *
         * 1. `||`, not `??`. `envsubst` renders a variable that a manifest
         *    references but the deploy workflow does not export as an EMPTY
         *    STRING, and `??` passes an empty string straight through as if
         *    it were a real value. `||` falls back to the default, which is
         *    what an operator means by "I did not set this".
         * 2. The default is NOT `/app/plugins`. That path holds the ~66
         *    native plugins baked into the image, and an emptyDir mounted
         *    over it once took out every AI, search and deploy capability in
         *    production because the loader then discovered zero plugins.
         * 3. Nothing creates the default directory — no Dockerfile mkdir, no
         *    volume mount. It will not exist on any current deployment, so
         *    the scanner treats a missing directory as an empty registry
         *    rather than an error. Turning this flag on must never be able to
         *    fail a boot.
         */
        getPackageDirs(): string {
            return process.env.AGENT_PLUGINS_DIR || '/app/agent-plugins';
        },

        /**
         * Whether stdio MCP servers declared by packages may be LAUNCHED.
         *
         * A second switch, deliberately separate from `isEnabled()`, because
         * the two authorise very different things. The master flag lets
         * packages contribute documents and remote server declarations —
         * inert data. This one lets the platform execute a subprocess from a
         * package's contents, which is a categorically larger grant, and one
         * a deployment may never want even while using packages happily.
         *
         * Default `false`, and SaaS keeps it off: no sandbox is built in this
         * feature, so a stdio server would run with the API pod's own
         * privileges. Self-hosted operators who control what they install can
         * turn it on.
         *
         * A stdio server on a deployment with this off is reported as
         * "present, disabled by policy" (AP-19) rather than hidden, so the
         * operator can see what a package would run if they allowed it.
         */
        isStdioEnabled(): boolean {
            return (process.env.AGENT_PLUGINS_STDIO ?? 'false').toLowerCase() === 'true';
        },

        /**
         * Root for per-package writable data (`${PLUGIN_DATA}`).
         *
         * Deliberately NOT under `getPackageDirs()`. Package contents are
         * read-only and replaced wholesale on update; data must survive that,
         * and a writable directory inside a scanned tree would also be walked
         * by the package scanner. `||` for the same envsubst reason as above.
         *
         * Nothing creates this directory either — the launcher creates the
         * per-package subdirectory it needs, so turning the flag on cannot
         * fail a boot.
         */
        getDataDir(): string {
            return process.env.AGENT_PLUGINS_DATA_DIR || '/app/agent-plugins-data';
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
        /**
         * State-aware sweeper (Wave 4 M6) — park a stale RUNNING run
         * instead of hard-failing it. Default ON.
         *
         * A `running` row past the cutoff means the worker died, not that
         * the work was wrong: the conversation (`cliSessionId`) is still
         * valid and `RunSteeringService.resume` can revive it. Parking
         * writes `terminalEndedReason='parked'`, which is exactly the
         * token `RESUMABLE_ENDED_REASONS` already recognises — so a
         * parked run gets a Resume button instead of a red error row.
         *
         * Set `AGENT_RUN_STALE_PARK_ENABLED=false` to fall back to the
         * pre-M6 behavior (every stale row hard-fails). A rollback valve,
         * not a product knob. `queued` rows are unaffected by this switch:
         * a queued row never started, so there is no conversation to park
         * — see {@link getRunQueuedTooLongMinutes}.
         */
        getRunStaleParkEnabled() {
            return process.env.AGENT_RUN_STALE_PARK_ENABLED !== 'false';
        },
        /**
         * How long a run may sit `queued` before it is surfaced as needing
         * a human. Default 60 minutes.
         *
         * This is a NOTICE threshold, never a reap threshold: crossing it
         * stamps `attentionReason='queued-too-long'`, notifies the owner
         * once, and leaves the row exactly where it is. The plan is
         * explicit — "`queued` older than a bound → surface, don't
         * silently drop".
         *
         * Deliberately much shorter than the stuck cutoff (hours): a run
         * that cannot get capacity for an hour is a capacity problem
         * somebody should see, whereas the stuck cutoff protects a
         * legitimately long-running worker from being killed.
         *
         * `0` (or negative) disables queued-too-long surfacing entirely.
         */
        getRunQueuedTooLongMinutes() {
            const raw = parseInt(process.env.AGENT_RUN_QUEUED_TOO_LONG_MINUTES || '60', 10);
            return Number.isFinite(raw) ? raw : 60;
        },
        /**
         * Rows flagged per tick by the queued-too-long scan. Bounded for
         * the same reason as {@link getRunStuckSweepBatch}: a saturated
         * org is precisely when this runs, and each flagged row also emits
         * a notification.
         */
        getRunQueuedAttentionBatch() {
            const raw = parseInt(process.env.AGENT_RUN_QUEUED_ATTENTION_BATCH || '50', 10);
            return Number.isFinite(raw) && raw > 0 ? raw : 50;
        },
        /**
         * Judgment layer G2 — run the cheap L0 pre-check before spending a
         * model call. Default **off**.
         *
         * Off by default because it changes what the agent sees on its
         * FIRST turn: a Work whose L0 command is misconfigured would start
         * every run by describing a failure that is not the agent's to
         * fix. Operators turn it on once their `level: 'L0'` checks are
         * trustworthy. When off — or when the Work declares no L0 check —
         * the run is byte-for-byte what it is today.
         */
        isGateL0PreCheckEnabled() {
            return (process.env.AGENT_GATE_L0_PRECHECK || 'off').toLowerCase() === 'on';
        },
        /**
         * Wall-clock ceiling for the WHOLE L0 pre-check pass, in seconds.
         * Default 120.
         *
         * A pre-check exists to be cheap; if it is not cheap it is a
         * regression, not a feature. Applied per check on top of the
         * check's own `timeoutSec`, so a pre-check can never approach the
         * post-run gate's 30-minute ceiling.
         */
        getGateL0PreCheckTimeoutSec() {
            const raw = parseInt(process.env.AGENT_GATE_L0_PRECHECK_TIMEOUT_SEC || '120', 10);
            return Number.isFinite(raw) && raw > 0 ? raw : 120;
        },
        /**
         * Judgment layer G2 — grade a GREEN gate against the Task's
         * acceptance criteria with an LLM judge before the PR is opened.
         * Default **off**.
         *
         * Off by default because it can withhold a PR that every
         * deterministic check approved: that is the whole point of the
         * feature, and also exactly why an operator has to opt into it.
         * With it off (or with no AI provider wired, or with a Task that
         * declares no criteria) the gate is byte-for-byte what it is
         * today — see `shouldRunGateJudge`.
         */
        isGateJudgeEnabled() {
            return (process.env.AGENT_GATE_JUDGE || 'off').toLowerCase() === 'on';
        },
        /**
         * Judgment layer G3 — kill switch for structured escalation
         * records. Default ON: when an agent gives up, a human needs a
         * card saying so. Off falls back to log-lines-only.
         */
        isEscalationLoggingEnabled() {
            return process.env.AGENT_ESCALATION_LOGGING_ENABLED !== 'false';
        },
        /**
         * Judgment layer G3 — let the AI judge score escalation
         * confidence through the AI facade. Default **off**.
         *
         * Off by default because it turns a bookkeeping write into a
         * model call: escalations are rare, but they are also raised at
         * exactly the moments a deployment is already unhealthy, and a
         * provider timeout there would slow every give-up path. With it
         * off, `confidence` is still populated on every row — by the
         * deterministic reason-code table, which costs nothing and never
         * fails. Turn it on to get calibrated scores.
         */
        isEscalationConfidenceJudgeEnabled() {
            return (process.env.AGENT_ESCALATION_CONFIDENCE_JUDGE || 'off').toLowerCase() === 'on';
        },
        /**
         * Judgment layer G10 — the doom-loop / retry-storm detector.
         * Default ON.
         *
         * On by default because the thing it prevents (an agent spending
         * its whole budget failing the same check five times) is pure
         * waste with no upside, and the detector never fails a run on its
         * own account — it stops the retry loop early and files an
         * escalation carrying the evidence. Set
         * `AGENT_RUN_LOOP_DETECTOR_ENABLED=false` to fall back to the
         * attempt cap alone.
         */
        isRunLoopDetectorEnabled() {
            return process.env.AGENT_RUN_LOOP_DETECTOR_ENABLED !== 'false';
        },
        /**
         * How many CONSECUTIVE identical failures count as a loop.
         * Default 3, clamped 2..10 by `resolveLoopThresholds`.
         *
         * Three, not two: two identical failures is what a legitimate
         * "fix it and re-run" attempt looks like when the fix was wrong,
         * and firing there would make the detector a nuisance rather than
         * a saving.
         */
        getRunLoopRepeatThreshold() {
            const raw = parseInt(process.env.AGENT_RUN_LOOP_REPEAT_THRESHOLD || '3', 10);
            return Number.isFinite(raw) ? raw : 3;
        },
        /**
         * Attempt count at which a progress-free trail is called a retry
         * storm. Default 4, clamped 1..20 by `resolveLoopThresholds`.
         */
        getRunLoopMaxRetries() {
            const raw = parseInt(process.env.AGENT_RUN_LOOP_MAX_RETRIES || '4', 10);
            return Number.isFinite(raw) ? raw : 4;
        },
        /**
         * Run orchestration (Wave 4 M2) — concurrency safety valves for
         * `RunDispatchGateService`. These are operator knobs, NOT product
         * limits: defaults are deliberately generous (10 in-flight runs
         * per Work, 25 per org/user) and `0` / negative disables the
         * respective valve entirely.
         *
         * Future per-Work override: a nullable
         * `works.maxConcurrentAgentRuns` column (works.yml v2 field +
         * Work settings UI) will take precedence over this env default
         * when it lands — the gate already resolves limits through these
         * getters so only the resolution chain grows.
         */
        getMaxConcurrentRunsPerWork() {
            const raw = parseInt(process.env.AGENT_MAX_CONCURRENT_RUNS_PER_WORK || '10', 10);
            return Number.isFinite(raw) ? raw : 10;
        },
        /** Per-org (or, for org-less personal runs, per-user) valve. */
        getMaxConcurrentRunsPerOrg() {
            const raw = parseInt(process.env.AGENT_MAX_CONCURRENT_RUNS_PER_ORG || '25', 10);
            return Number.isFinite(raw) ? raw : 25;
        },
        /**
         * Task-graph fan-out (self-build slice AH) — how many TODO Tasks
         * `TaskGraphFanoutService` may START for ONE owner in a single
         * tick.
         *
         * 🛑 READ THE ZERO THE OTHER WAY ROUND. For the concurrency valves
         * above, `<= 0` means "no ceiling". Here `<= 0` means the driver
         * is OFF and starts nothing — which is the DEFAULT, because this
         * is the one knob on the platform that begins work nobody clicked.
         * An operator opts in by setting a positive number.
         *
         * The bound is per OWNER per tick, not a concurrency limit: the
         * real ceilings (the Work / org valves, the plan entitlement, the
         * credits precheck, the global stop flag) still decide whether any
         * given start is admitted, and a Task refused by them stays `todo`
         * and is a candidate again next tick.
         */
        getTaskFanoutMaxStartsPerOwner() {
            const raw = parseInt(process.env.TASK_FANOUT_MAX_STARTS_PER_OWNER || '0', 10);
            return Number.isFinite(raw) ? raw : 0;
        },
        /**
         * How many TODO Tasks one fan-out tick SCANS (before blocker,
         * agent and admission filtering). Bounds the tick's cost — the
         * blocker check is one query per blocker row — not how much work
         * starts; `getTaskFanoutMaxStartsPerOwner` does that.
         */
        getTaskFanoutScanLimit() {
            const raw = parseInt(process.env.TASK_FANOUT_SCAN_LIMIT || '50', 10);
            return Number.isFinite(raw) && raw > 0 ? raw : 50;
        },
        /**
         * H2 kill-switch for the plan-driven concurrency ceiling
         * (`plan_entitlements.max-concurrent-runs`), folded into the org
         * valve above as a RAISE-ONLY adjustment.
         *
         * Ships DARK (default off), like the credits kill-switch. The
         * adjustment can only ever raise a ceiling or switch the valve off
         * for an "unlimited" tier, so turning it on cannot park a run that
         * would not already have parked — but it does change how much
         * concurrent work the platform will accept, and that deserves a
         * deliberate flip rather than arriving with a deploy.
         *
         * Set `PLAN_CONCURRENCY_ENFORCEMENT=on` to honour the plan's
         * entitlement.
         */
        isPlanConcurrencyEnforcementEnabled() {
            const raw = (process.env.PLAN_CONCURRENCY_ENFORCEMENT || '').toLowerCase();
            return raw === 'on' || raw === 'true' || raw === '1';
        },
        /**
         * Merge-policy matrix (Wave 3, D4) — operator kill-switch for
         * enforcement at the git facade. Default ON: an agent-driven merge
         * consults the resolved policy and is refused when the policy says
         * no. Set `AGENT_MERGE_POLICY_ENFORCEMENT=off` to fall back to the
         * pre-feature behavior (no policy consult at all) if enforcement
         * ever misfires in production — a rollback valve, not a product
         * knob. The POLICY itself is configured per tenant / org / Work /
         * Agent, never by env.
         */
        isMergePolicyEnforcementEnabled() {
            return (process.env.AGENT_MERGE_POLICY_ENFORCEMENT || 'on').toLowerCase() !== 'off';
        },
    },

    /**
     * Fleet (Wave 12) — operator knobs for the node registry.
     *
     * These four values shipped as hard-coded constants in
     * `FleetService`, which made them un-tunable for anyone running the
     * platform: a fleet of slow-to-provision machines could not lengthen
     * the enrollment window, and an operator whose nodes advertise a
     * richer capability vocabulary could not raise the tag caps without
     * a code change. Defaults are EXACTLY the previous constants, so an
     * environment that sets nothing behaves byte-for-byte as before.
     *
     * Every getter clamps into a documented range rather than trusting
     * the env: `capabilities` is a stored JSON column and a lease-time
     * filter input, so an unbounded knob would be a denial-of-service
     * surface, and a zero/NaN TTL would expire every token instantly.
     */

    /**
     * Saved workflow graphs (judgment layer G5) — the `workflow_runs`
     * stuck-row sweep.
     *
     * `POST /api/workflows/:id/run` inserts the row `queued` and the
     * Trigger.dev `workflow-run` task owns it from `markStarted` onward.
     * That task runs `maxAttempts: 1`, so if its machine dies without
     * reaching a terminal write — OOM, node eviction, a
     * `release-trigger-prod` deploy, or `maxDuration` expiry — nothing
     * re-delivers it and the row stays `queued`/`running` forever. A
     * `queued` row is equally strandable: an enqueue that parks in
     * `PENDING_VERSION` across an API/worker deploy skew may never run.
     */
    workflows: {
        /** Kill switch for the `workflow_runs` stuck-row sweeper. Default on. */
        getRunSweeperEnabled() {
            return process.env.WORKFLOW_RUN_SWEEPER_ENABLED !== 'false';
        },
        /**
         * Age past which a `queued`/`running` workflow run is considered
         * abandoned, measured from `COALESCE(startedAt, createdAt)`.
         *
         * The two error costs are asymmetric in the same way
         * `agents.getStuckTimeoutMinutes` documents, so this is deliberately
         * generous. Sweeping LATE leaves a status field wrong for a few extra
         * hours. Sweeping EARLY marks a LIVE walk `failed`; the worker's own
         * `markCompleted` then no-ops against the terminal CAS and the real
         * result is lost, which is unrecoverable.
         *
         * The floor is the task's own ceiling: `workflow-run.task.ts` pins
         * `maxDuration: 60 * 60`, so a legitimate walk can occupy 60 minutes.
         * 90 leaves half an hour of margin. A value at or below 60 would reap
         * healthy long walks, so it is clamped up.
         */
        getRunStuckTimeoutMinutes() {
            const raw = parseInt(process.env.WORKFLOW_RUN_STUCK_TIMEOUT_MINUTES || '90', 10);
            const minutes = Number.isFinite(raw) && raw > 0 ? raw : 90;
            // `maxDuration` is 60 minutes; never reap inside a walk's own budget.
            return Math.max(minutes, 61);
        },
        /** Upper bound on rows reaped per sweep tick. */
        getRunSweeperMaxBatch() {
            const raw = parseInt(process.env.WORKFLOW_RUN_SWEEPER_MAX_BATCH || '100', 10);
            return Number.isFinite(raw) && raw > 0 ? raw : 100;
        },
    },

    /**
     * Streaming-terminal M9 / founder decision D1 — persisted terminal
     * transcripts.
     *
     * Retention itself is NOT an env default: it is a plan-tier lever
     * read from the `terminal-transcript-retention-days` entitlement
     * (-1 forever / 0 keep-nothing / N days), seeded per plan by the
     * `1784300000000` migration. The knobs here are operator safety
     * valves around that lever — a kill switch, sizing caps, and the
     * fallback for a plan code with no entitlement row.
     */
    terminal: {
        transcript: {
            /**
             * Master switch. Default ON. Off = the publish path skips
             * persistence entirely (the relay still fans out live).
             */
            isPersistenceEnabled(): boolean {
                const raw = (process.env.TERMINAL_TRANSCRIPT_PERSISTENCE || '').toLowerCase();
                return raw !== 'off' && raw !== 'false' && raw !== '0';
            },
            /**
             * Retention for a plan CODE with no entitlement row. Default
             * 0 — keep nothing. Fail-closed on purpose: an unrecognized
             * plan must not silently start retaining terminal output.
             */
            getFallbackRetentionDays(): number {
                const raw = parseInt(process.env.TERMINAL_TRANSCRIPT_RETENTION_DAYS || '0', 10);
                return Number.isFinite(raw) && raw >= -1 ? raw : 0;
            },
            /** Per-run retention-resolution cache TTL (ms, default 60s). */
            getRetentionCacheTtlMs(): number {
                const raw = parseInt(
                    process.env.TERMINAL_TRANSCRIPT_RETENTION_CACHE_TTL_MS || '60000',
                    10,
                );
                return Number.isFinite(raw) && raw >= 0 ? raw : 60000;
            },
            /** Hard cap on a single stored chunk's text (chars, default 64 KiB). */
            getMaxChunkChars(): number {
                const raw = parseInt(
                    process.env.TERMINAL_TRANSCRIPT_MAX_CHUNK_CHARS || '65536',
                    10,
                );
                return Number.isFinite(raw) && raw > 0 ? raw : 65536;
            },
            /** Max chunks returned by one replay page (default 500). */
            getReplayMaxChunks(): number {
                const raw = parseInt(
                    process.env.TERMINAL_TRANSCRIPT_REPLAY_MAX_CHUNKS || '500',
                    10,
                );
                return Number.isFinite(raw) && raw > 0 ? raw : 500;
            },
            /** Max total chars one replay page may return (default 512 KiB). */
            getReplayMaxChars(): number {
                const raw = parseInt(
                    process.env.TERMINAL_TRANSCRIPT_REPLAY_MAX_CHARS || '524288',
                    10,
                );
                return Number.isFinite(raw) && raw > 0 ? raw : 524288;
            },
            /** Candidate runs scanned per retention-sweep page (default 200). */
            getSweepBatchSize(): number {
                const raw = parseInt(process.env.TERMINAL_TRANSCRIPT_SWEEP_BATCH || '200', 10);
                return Number.isFinite(raw) && raw > 0 ? raw : 200;
            },
            /**
             * Upper bound the sweeper scans back from. Any retention
             * window is <= this, so the candidate scan uses it as the
             * "definitely old enough to consider" cutoff. Default 3650
             * days (10y).
             */
            getSweepHorizonDays(): number {
                const raw = parseInt(
                    process.env.TERMINAL_TRANSCRIPT_SWEEP_HORIZON_DAYS || '3650',
                    10,
                );
                return Number.isFinite(raw) && raw > 0 ? raw : 3650;
            },
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

    /**
     * Event-ingest spine — salience filter knobs.
     *
     * The ingest pipeline used to write EVERY envelope a connector
     * produced straight into the feed, so a chatty source (bot pings,
     * presence changes, reaction spam) could drown the signal a user
     * actually connected the source for.
     *
     * All three knobs default to OFF, which reproduces the previous
     * behaviour byte for byte: min score `0` admits everything, and both
     * mute lists are empty. An operator opts in per deployment.
     */
    ingest: {
        /**
         * Minimum salience score (0–100) an envelope must reach to be
         * stored. `0` (default) = filter disabled, everything is kept.
         * Values outside 0–100 and unparseable input fall back to `0` —
         * a typo must never start silently dropping a customer's events.
         */
        getSalienceMinScore(): number {
            const raw = Number.parseInt(process.env.INGEST_SALIENCE_MIN_SCORE || '', 10);
            if (!Number.isFinite(raw) || raw <= 0) return 0;
            return Math.min(raw, 100);
        },
        /**
         * Comma-separated event kinds to drop outright, e.g.
         * `slack.presence,github.watch`. Matched case-insensitively
         * against the envelope `kind`; a trailing `.*` makes it a
         * prefix match (`slack.*`). Empty (default) = nothing muted.
         */
        getSalienceMutedKinds(): string[] {
            return parseCsvList(process.env.INGEST_SALIENCE_MUTED_KINDS);
        },
        /**
         * Comma-separated actor names to drop outright (noisy bots and
         * automations). Matched case-insensitively as a SUBSTRING of the
         * envelope actor name, so `dependabot` mutes
         * `dependabot[bot]`. Empty (default) = nothing muted.
         */
        getSalienceMutedActors(): string[] {
            return parseCsvList(process.env.INGEST_SALIENCE_MUTED_ACTORS);
        },
        /** True when any knob is set — i.e. the filter can drop something. */
        isSalienceFilterEnabled(): boolean {
            return (
                this.getSalienceMinScore() > 0 ||
                this.getSalienceMutedKinds().length > 0 ||
                this.getSalienceMutedActors().length > 0
            );
        },
    },
};

/** Comma-separated env list → trimmed, lowercased, blank-dropped, deduped. */
function parseCsvList(raw: string | undefined): string[] {
    if (typeof raw !== 'string' || raw.trim().length === 0) return [];
    const seen = new Set<string>();
    for (const part of raw.split(',')) {
        const value = part.trim().toLowerCase();
        if (value.length > 0) seen.add(value);
    }
    return [...seen];
}
