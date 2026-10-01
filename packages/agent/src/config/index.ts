import { Logger } from '@nestjs/common';
import { isIP } from 'node:net';

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
    EMAIL_INBOX_BURST_RECIPIENTS,
    EMAIL_INBOX_BURST_SENDS,
    EMAIL_INBOX_DEFAULT_DAILY_CAP,
    EMAIL_MAX_RECIPIENTS_PER_MESSAGE,
    EMAIL_SEND_CAP_MAX_CONFIGURABLE,
    EMAIL_SEND_CAP_RECOMMENDED_DEFAULTS,
    EMAIL_WORKSPACE_DAILY_CAP,
    EMAIL_WORKSPACE_MONTHLY_CAP,
    DEFAULT_CREDIT_SETTLEMENT_MODE,
    isCreditSettlementMode,
    type AgentInboxMode,
    type CreditSettlementMode,
    type EmailSendCapField,
} from '@ever-works/contracts';
import { DatabaseType } from '@src/database';

import {
    catalogCreditsMarginPercent,
    catalogPaygMaxMonthlyCapCredits,
} from '../subscriptions/billing/stripe-catalog';
// CI feedback + autonomous fix loop (slice AC, EW-806). Concrete file
// import, not the tasks-domain barrel: `task-ci-auto-resume.ts` is a pure
// leaf (its only import is `node:crypto`) and pulling the barrel here
// would drag the Nest service graph into config resolution.
import {
    DEFAULT_CI_AUTO_RESUME_ATTEMPTS,
    MAX_CI_AUTO_RESUME_ATTEMPTS,
    clampAutoResumeAttempts,
} from '../tasks-domain/task-ci-auto-resume';
// Same reasoning as the import above: the clamps that decide how much
// money the reviewer agent stage may spend live next to the constants
// they clamp against, and their unit tests are only worth anything if
// these are the functions actually shipped.
import {
    clampAgentReviewApproversPerEntry,
    clampAgentReviewRunsPerTask,
} from '../tasks-domain/task-agent-review';
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
        /**
         * Run secrets (self-build slice Y) — the instance kill switch on
         * delivering a repository's seed `.env` files to a fleet node.
         *
         * Default ON, because the feature is opt-in per repository already:
         * a registry row with no env files delivers nothing, and turning
         * this off is for an operator who wants the whole PATH shut, not
         * for narrowing one repository.
         *
         * Turning it OFF fails a run that NEEDS env files closed, with
         * `FLEET_RUN_SECRETS_DISABLED_REASON` — it never starts the run
         * with a partial environment, because "the suite ran and every
         * database test failed" is a far worse answer than "the run
         * refused, here is the setting".
         */
        isRunEnvFilesEnabled(): boolean {
            const raw = (process.env.FLEET_NODE_RUN_ENV_FILES || '').trim().toLowerCase();
            if (raw === 'false' || raw === '0') return false;
            return true;
        },

        // ── Self-build slice Z (EW-796) — the platform-MCP bridge ───
        //
        // OFF by default and off in two independent ways: this operator
        // switch AND a configured server URL. Neither implies the other,
        // and a run additionally needs its Agent's `canCallExternalTools`
        // permission, so three separate facts have to line up before a
        // node is ever asked to mint a credential.
        //
        // Why an operator switch at all: the bridge hands a model on
        // someone's desktop a live (if short-lived and narrowly scoped)
        // platform credential. That is a deployment-level decision about
        // the whole install, not a per-tenant preference, and it must be
        // possible to turn the whole thing off in one place during an
        // incident without touching a single Agent.

        /**
         * Operator switch for the fleet MCP bridge. Default FALSE —
         * only the literal `true` / `1` turns it on, so a typo or an
         * empty value fails closed to today's behaviour (no platform
         * tools in a fleet run).
         */
        isMcpBridgeEnabled(): boolean {
            const raw = (process.env.FLEET_NODE_MCP_BRIDGE_ENABLED || '').trim().toLowerCase();
            return raw === 'true' || raw === '1';
        },
        /**
         * Absolute URL of the platform MCP endpoint the node's loopback
         * proxy forwards to (`apps/mcp` streamable-HTTP transport, whose
         * endpoint is `/mcp` on `EVER_WORKS_MCP_PORT`).
         *
         * Validated here rather than at the node: a nonsense value must
         * fail on the platform, where an operator reads logs, and not on
         * fifteen desktops. Anything that is not an absolute http(s) URL
         * is treated as unset — which switches the bridge off rather
         * than pointing a credential-bearing proxy at a garbage host.
         */
        getMcpServerUrl(): string | undefined {
            const raw = (process.env.FLEET_NODE_MCP_URL || '').trim();
            if (!raw) return undefined;
            let parsed: URL;
            try {
                parsed = new URL(raw);
            } catch {
                return undefined;
            }
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
            // Strip a trailing slash so the node builds one canonical URL.
            return raw.endsWith('/') && raw.length > 1 ? raw.slice(0, -1) : raw;
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
             * AW-17 — how a run's platform-paid spend becomes a credits debit
             * (`CREDITS_SETTLEMENT_MODE`).
             *
             * - `provider_cost` (default): every billable row settles from its
             *   provider cost at `CREDITS_PER_DOLLAR` and the margin above —
             *   exactly how runs were debited before the credit price list.
             * - `price_list`: rows priced by a fixed `per-unit` entry debit their
             *   published credits; every other row still settles from cost.
             *
             * Unset or unrecognised resolves to the default, so an install that
             * configures nothing is billed exactly as before. Accepts either
             * `_` or `-` and any case (`price-list`, `PRICE_LIST`).
             */
            getSettlementMode(): CreditSettlementMode {
                const raw = (process.env.CREDITS_SETTLEMENT_MODE || '')
                    .trim()
                    .toLowerCase()
                    .replace(/-/g, '_');
                return isCreditSettlementMode(raw) ? raw : DEFAULT_CREDIT_SETTLEMENT_MODE;
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
        /**
         * APW-01 T7 — the App Work instance setting (spec FR-3, plan §12).
         *
         * `EVER_WORKS_APP_WORKS_ENABLED` is the API-side twin of the web's gate
         * (`apps/web/src/lib/feature-flags/work-kinds.ts`), and the reason both
         * read the SAME variable name rather than two: a chip that offers `app`
         * while the API refuses to build one is a dead end, and an API that
         * accepts `app` while the picker hides it is a missing feature. The web
         * half reads its own deployment's copy at request time; when the API
         * starts publishing this on `/api/config`, callers pass that answer and
         * the environment read becomes the fallback.
         *
         * Exactly `'true'` is on, defaulting to OFF, beside the other
         * `*_ENABLED` getters — the same posture as `config.appLauncher`.
         */
        apps: {
            worksEnabled() {
                return process.env.EVER_WORKS_APP_WORKS_ENABLED === 'true';
            },

            /**
             * APW-08 T17 — may the API-side (cloud) isolated-Task path PUSH an
             * App Work branch? (`APP_WORKS_CLOUD_PUSH_ENABLED`, owner decision
             * 2026-09-25.)
             *
             * OFF by default, and on only for exactly `'true'`: APW-08 FR-12
             * says an App Work run executes only on an enrolled Fleet node or in
             * an isolated environment with no platform secret, and the admission
             * that enforces it (T12) has not landed. Until it does, a cloud run
             * on an App Work commits locally and `finalizeRun` refuses to publish
             * — the Task is blocked with a message naming FR-12, nothing is
             * pushed and no pull request is opened. Turned on, the cloud path
             * judges the exact local commit with the change gate's `checkPaths`
             * BEFORE publishing exactly that commit, then judges the pushed
             * branch again with `evaluate`.
             *
             * Asked only through `appWorkCloudPushAllowed`
             * (`tasks-domain/app-work-cloud-push.ts`), the one gate both cloud
             * publishers share: `finalizeRun`, and the agent git tools
             * `commitToRepo` / `openPullRequest` in the API's `AGENT_GIT_FACADE`,
             * which refuse an App Work with the same words while this is off.
             *
             * Read per call (never captured at import), so tests can flip it; a
             * running API reads its environment once, at process start, so a
             * changed value takes effect when the API restarts or is redeployed.
             * Every other Work kind ignores it, and so does `finalizeRun` for an
             * App Work with no change gate bound (a partial construction; every
             * real graph binds the gate through `TasksDomainModule`).
             */
            cloudPushEnabled() {
                return process.env.APP_WORKS_CLOUD_PUSH_ENABLED === 'true';
            },

            /**
             * APW-06 T19 — the apex an App Work's managed subdomain lives under
             * (`EVER_WORKS_APPS_DOMAIN`, plan §8.3, spec FR-40, Resolution R-16).
             *
             * ## Two branches, exactly as plan §8.3 states them
             *
             * ⚠️ **A disagreement between the task text and the plan, resolved for the
             * plan and recorded here rather than left implicit** (the plan is the spec
             * of record for APW-06). T19's own line reads: "apps domain equal to /
             * under / parent of `EVER_WORKS_DOMAIN` ⇒ `getDomain() === null`
             * (ACC-06-27)" — with no branch qualifier, which read literally would also
             * refuse the *unset* case. Plan §8.3 scopes those three relations to the
             * dedicated-apex branch and keeps the shared default enabled
             * ("**Shared-default branch** (apex resolves to `EVER_WORKS_DOMAIN`): the
             * equality check is satisfied by definition and recorded as such"), and
             * ACC-06-27 itself says "a subdomain of the platform's own `ever.works` IS
             * allowed — owner decision 2026-09-17". Following the task text literally
             * would disable the managed subdomain out of the box and contradict D10's
             * headline promise, so the plan wins: the three relations refuse an
             * **explicitly configured** apex (the tests pin exactly that), and the
             * unset case returns the platform domain.
             *
             * - **Shared-default branch** (the variable is unset or blank): the apex
             *   *is* the installation's platform domain, so the equality check is
             *   "satisfied by definition and recorded as such" (plan §8.3:1135-1138).
             *   The value returned is `EVER_WORKS_DOMAIN`, defaulting to the
             *   documented `ever.works` — the same default
             *   `managed-subdomain.service.ts:298`, `cloudflare-dns.provider.ts:430`
             *   and `subdomain-allocator.service.ts:192` already read, restated here
             *   so the config module and those callers cannot disagree. This is the
             *   branch that makes "installing Gauzy from a template should just work
             *   at `<slug>.EVER_WORKS_DOMAIN>`" true (program README §2 D10:213-218).
             *   The platform-domain safeguards of R-16 apply instead of the strict
             *   validation below: host-only `__Host-` Secure cookies on platform
             *   routes, no platform session cookie on app hosts, app hosts that
             *   never serve platform pages.
             * - **Dedicated-apex branch** (the operator set the variable explicitly):
             *   "the apex must not equal, end with `.` + `EVER_WORKS_DOMAIN`, or be a
             *   suffix of `EVER_WORKS_DOMAIN` or the host of the platform web/API URL
             *   — this is what keeps the cookie-isolating configuration honest"
             *   (plan §8.3:1133-1135). Equality is refused **here** and only here:
             *   an operator who sets the variable to the platform domain itself is
             *   asking for a dedicated apex and handing us the shared one, which is
             *   the configuration the strict branch exists to catch. The refusal is
             *   logged with the way out (unset the variable).
             *
             * ## What "unusable" means, and what it costs
             *
             * A malformed apex (not a plain dotted DNS name: a scheme, a port, a
             * path, a wildcard, an IP literal, a single label, an empty or
             * over-long label, an underscore) and a relation clash both make this
             * getter **log an error and return `null`** — "a malformed or unusable
             * apex makes the feature log an error and `getDomain()` return `null`,
             * which disables the managed subdomain only — custom domains keep
             * working" (plan §8.3:1138-1140). `null` never means "no address": it
             * means "no *managed* address", and the caller (`AppHostsService`,
             * plan §8.1:1099-1101) then offers custom domains alone. The same
             * answer, for the same reason, is given when `EVER_WORKS_DOMAIN` itself
             * is set to something unusable: the shared default would otherwise be
             * "repaired" into a domain the operator never wrote.
             *
             * ## What this getter deliberately does NOT do
             *
             * - **No Public Suffix List check.** The PSL probe is APW-10's launch-gate
             *   item LG-15 (`APEX_NOT_ON_PSL` / `PSL_UNREACHABLE`) and it "stays
             *   exactly as it is … simply not exercised by an installation that does
             *   not [configure a dedicated apex]" (program README §2 D10:222-227).
             *   Making this getter reach the network would put a PSL round-trip on
             *   every config read; keeping it out is what leaves LG-15 the single
             *   place that decides it.
             * - **No DNS-zone check.** `getDnsZoneId()` unset means no record is ever
             *   written (CONTRACTS §7), which withdraws the managed *address* without
             *   this getter having to pretend the apex is invalid.
             * - **Nothing is ever removed here.** Every address shape R-16 and D10
             *   allow keeps working; this getter only answers which apex applies.
             */
            getDomain(): string | null {
                const raw = process.env.EVER_WORKS_APPS_DOMAIN;
                const configured = typeof raw === 'string' ? raw.trim() : '';
                const platform = platformManagedDomain();

                if (platform === null) {
                    appsDomainLogger.error(
                        `EVER_WORKS_DOMAIN="${String(process.env.EVER_WORKS_DOMAIN ?? '')}" is not a ` +
                            `usable apex domain, so no managed App Work subdomain can be addressed. ` +
                            `Set it to the installation's platform domain (for example ever.works).`,
                    );
                    return null;
                }

                if (configured.length === 0) {
                    // Shared-default branch — see the docstring: the apex resolves to
                    // the platform domain and the R-16 cookie controls carry isolation.
                    recordAppsDomainSharedDefault(platform);
                    return platform;
                }

                const apex = normalizeApexDomain(configured);
                if (apex === null) {
                    appsDomainLogger.error(
                        `EVER_WORKS_APPS_DOMAIN="${configured}" is not a usable apex domain, so no managed ` +
                            `subdomain is offered. Set it to a dotted DNS name (for example ` +
                            `apps.example.com), or unset it to use EVER_WORKS_DOMAIN.`,
                    );
                    return null;
                }

                const clash = appsDomainClash(apex);
                if (clash !== null) {
                    appsDomainLogger.error(
                        `EVER_WORKS_APPS_DOMAIN="${apex}" is ${clash} the platform domain ` +
                            `"${platform}", so it cannot be a dedicated cookie-isolating apex and no ` +
                            `managed subdomain is offered. Unset EVER_WORKS_APPS_DOMAIN to serve ` +
                            `<slug>.${platform} instead.`,
                    );
                    return null;
                }

                return apex;
            },

            /**
             * APW-06 T19 — how many App Works one owner may run on **Ever Works
             * Apps** (`EVER_WORKS_APPS_MAX_PER_USER`, plan §5.1/§9.5; default 3,
             * CONTRACTS §7).
             *
             * APW-10's own plan (§5.5:715) fixes the relationship: the per-owner
             * limit is APW-06's cap, `capReached` is "a presentation of APW-06's
             * cap, not a second cap", and this value is read through APW-06's quota
             * service rather than through a constant or table in that epic. This
             * getter is therefore the **only** reading of the variable, and the
             * default lives here beside it.
             *
             * Unset, blank, non-numeric or non-positive keeps the documented 3 —
             * the same posture as `everWorks.deploy.getMaxWorksPerUser()` next to
             * it: a deploy-manifest typo must degrade to the documented default,
             * never to `NaN` (which would refuse every managed Deployment) and
             * never to `0` (which would silently close the tier).
             */
            getMaxPerUser(): number {
                const raw = parseInt(process.env.EVER_WORKS_APPS_MAX_PER_USER || '3', 10);
                return Number.isFinite(raw) && raw > 0 ? raw : 3;
            },

            /**
             * APW-06 T19 — the DNS zone the managed records are written into
             * (`EVER_WORKS_APPS_DNS_ZONE_ID`, plan §8.3:1130; **not a secret**).
             *
             * `undefined` is the documented default and it is load-bearing:
             * CONTRACTS §7 says "unset — no managed subdomains without it", so the
             * managed address is withdrawn by the absence of a zone rather than by
             * `getDomain()` pretending the apex is invalid. On the shared default
             * this is the platform domain's own zone.
             *
             * On the shared default the apps DNS configuration is the **only** DNS
             * configuration the App path reads (plan §8.3:1141-1143): the platform's
             * `EverWorksDnsService` and this pair stay separate, and a follow-up
             * moves both behind the `dns` capability (EW-738).
             */
            getDnsZoneId(): string | undefined {
                const value = process.env.EVER_WORKS_APPS_DNS_ZONE_ID?.trim();
                return value ? value : undefined;
            },

            /**
             * APW-06 T19 — the DNS API token the managed records are written with
             * (`EVER_WORKS_APPS_DNS_API_TOKEN`, plan §8.3:1131; **secret**,
             * CONTRACTS §7).
             *
             * Unset/blank → `undefined`, the documented default. This getter is
             * read by `AppsDomainDnsService` (plan §8.3:1141) and by nothing that
             * logs: the value never enters a message, an Activity payload or a
             * `WorkDeployment` row, which is the same rule the Cloudflare provider
             * already follows for its own token.
             */
            getDnsApiToken(): string | undefined {
                const value = process.env.EVER_WORKS_APPS_DNS_API_TOKEN?.trim();
                return value ? value : undefined;
            },

            /**
             * APW-06 T19 — the operator's attestation that the App cluster worker
             * has no route to internal networks
             * (`EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED`, plan §6.2:950-952,
             * CONTRACTS §7; default `false`).
             *
             * "Production (`NODE_ENV=production`) refuses to dispatch any `app-*`
             * cluster job unless `EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED=true` — an
             * operator attestation that the worker for this queue has no route to
             * internal networks" (plan §6.2). The network design behind the
             * attestation lives in the private operations repository; this getter
             * only reports what the operator declared.
             *
             * Fails closed: exactly `'true'` is on, so an unset, blank, `'1'` or
             * `'TRUE'` value refuses App cluster jobs in production rather than
             * assuming an isolation nobody attested. It is a **read**, never a
             * substitute for the process-level worker-context flag
             * (`app-runtime/worker-context.ts`, plan §6.2:943-949) — the flag says
             * *where the code is running*, this says *what the operator promised
             * about that place*.
             */
            isClusterWorkerIsolated(): boolean {
                return process.env.EVER_WORKS_APPS_CLUSTER_WORKER_ISOLATED === 'true';
            },

            /**
             * APW-06 T19 — the CIDRs exempt from the public-address rule
             * (`EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST`, plan §6.1:922-934, §8.3;
             * default empty).
             *
             * Plan §6.1's own words for this accessor: "§8.3's
             * `getClusterPrivateAllowlist()` returns `parsePrivateAllowlist(env).cidrs`,
             * and `AppHostsService` uses `resolvePublicAddresses` before any DNS
             * record write and on re-validation". So the contract is: comma- or
             * whitespace-separated CIDRs (a bare address reads as `/32` or `/128`),
             * entries that do not parse are **dropped with a warning** and never
             * widen the policy (plan §6.1:929-930), and the surviving entries are
             * returned **verbatim** — the same strings the operator typed, exactly
             * as the `k8s` plugin's own `parsePrivateAllowlist` returns them
             * (`packages/plugins/k8s/src/app/app-kubeconfig.guard.ts:184-201`), so
             * one environment value cannot mean two different lists on the two
             * sides of the worker boundary.
             *
             * ⚠️ **Provisional, reported (APW06-G20 / plan:923-934).** The parser is
             * supposed to live in the plugin SDK as
             * `@ever-works/plugin/helpers/cluster-address-policy` (`parsePrivateAllowlist`)
             * and this accessor is supposed to call it. That module does not exist on
             * this branch — the `k8s` plugin kept the classifier local for the same
             * reason and exported it (`app-kubeconfig.guard.ts:27-39`) — so the
             * narrowest local seam is kept here, and when the SDK module lands this
             * getter delegates to it in one line. Nothing is removed either way: the
             * local filter is what makes the behaviour testable today, and the swap is
             * an import.
             *
             * The allow-list is an **operator decision with a name**, never a silent
             * default: an empty value means every private address stays refused
             * (THREAT-MODEL T-13, residual accepted in Wave 1).
             */
            getClusterPrivateAllowlist(): string[] {
                const parsed = parseClusterPrivateAllowlist(
                    process.env.EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST,
                );

                for (const entry of parsed.invalid) {
                    appsDomainLogger.warn(
                        `Ignoring unparseable ${APPS_CLUSTER_PRIVATE_ALLOWLIST_ENV} entry "${entry}": ` +
                            `it is not an IP address or CIDR, so it does not widen the cluster address policy.`,
                    );
                }

                return parsed.cidrs;
            },
        },

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
         * CI feedback + autonomous fix loop (self-build slice AC, EW-806) —
         * how many times ONE Task may be auto-resumed, over its whole life,
         * because CI went red or a reviewer rejected its pull request.
         *
         * 💸 THIS KNOB SPENDS MONEY. Each attempt is a full
         * `agent-task-execute` run on a fleet PC — the same order of model
         * spend as the run that opened the pull request. The default of
         * TWO therefore caps what this feature can add to any one Task at
         * two extra runs, forever, not two per push and not two per day.
         *
         * `0` switches the loop OFF: check results are still ingested and
         * the board still goes red, nothing is resumed. Values are clamped
         * to 0..5; an unparseable value falls back to the default rather
         * than silently disabling a shipped loop.
         *
         * The COUNTER is not here — it is rows in
         * `task_ci_auto_resume_attempts`. This is only the ceiling.
         */
        getCiAutoResumeMaxAttempts() {
            // `clampAutoResumeAttempts` rather than the local
            // `clampedIntEnv`: the clamp that decides how much money this
            // loop may spend has its own unit tests next to the constants
            // it clamps against, and those tests are only worth anything
            // if this is the function actually shipped. `parseInt` of an
            // absent or unparseable value yields NaN, which the clamp maps
            // to DEFAULT_CI_AUTO_RESUME_ATTEMPTS.
            return clampAutoResumeAttempts(
                parseInt(process.env.TASK_CI_AUTO_RESUME_MAX_ATTEMPTS ?? '', 10),
            );
        },
        /**
         * Reviewer agent stage (self-build slice AD, EW-811) — how many
         * REVIEW runs one Task may ever buy.
         *
         * 💸 THIS KNOB SPENDS MONEY. Each review is a full
         * `agent-task-execute` run on a fleet PC whose input is a pull
         * request diff. The default of FOUR caps what this feature can add
         * to any one Task, forever — not four per push, not four per
         * reviewer, four in total across every entry into `in_review`.
         *
         * `0` switches the stage OFF: agent approver rows are still
         * honoured by the `in_review → done` gate (they stay `pending`, so
         * a human still has to look), no diff is fetched and no run
         * starts. Values are clamped to 0..12; an unparseable value falls
         * back to the default rather than silently disabling a shipped
         * stage.
         *
         * The COUNTER is not here — it is rows in `task_agent_reviews`.
         * This is only the ceiling.
         */
        getAgentReviewMaxRunsPerTask() {
            return clampAgentReviewRunsPerTask(
                parseInt(process.env.TASK_AGENT_REVIEW_MAX_RUNS ?? '', 10),
            );
        },
        /**
         * Reviewer agent stage — how many approvers ONE entry into
         * `in_review` may fan out to.
         *
         * A different question from the lifetime budget above: that one
         * stops a Task bouncing in and out of review forever, this one
         * stops a single transition starting six runs at once because
         * somebody attached six agent approvers. Clamped to 0..5; `0`
         * dispatches nothing.
         */
        getAgentReviewMaxApproversPerEntry() {
            return clampAgentReviewApproversPerEntry(
                parseInt(process.env.TASK_AGENT_REVIEW_MAX_APPROVERS ?? '', 10),
            );
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
    /**
     * Agent email (AW-05) — operator knobs for the approve-before-send gate
     * and the send ceilings. Organizations and individual Agent inboxes can
     * refine these from the product; these are the deployment-wide defaults
     * underneath.
     *
     * Send ceilings are opt-in: with no `EMAIL_SEND_CAP_*` variable set (and
     * no organization policy or Agent settings) nothing is enforced. Setting
     * one turns that ceiling on for every account on the deployment.
     */
    email: {
        sendCaps: {
            /**
             * `EMAIL_SEND_CAPS_ENFORCEMENT=off` turns every send ceiling off
             * for this deployment — sends are then only bounded the way they
             * were before ceilings existed. Default ON; anything other than
             * an explicit `off` / `false` / `0` keeps them on, so a typo can
             * never silently lift them.
             */
            isEnforced(): boolean {
                const raw = (process.env.EMAIL_SEND_CAPS_ENFORCEMENT || '').trim().toLowerCase();
                return raw !== 'off' && raw !== 'false' && raw !== '0';
            },
            /**
             * The platform ceilings the OPERATOR turned on — one entry per
             * `EMAIL_SEND_CAP_*` env var that is set, nothing else. This is
             * what the send path enforces: a deployment that sets none of
             * them enforces no platform ceiling, so it sends exactly as it did
             * before ceilings existed.
             *
             * `0` = explicitly no ceiling for that limit. A variable that is
             * set but unparseable or out of range still counts as "the
             * operator asked for a ceiling" and takes the recommended number,
             * so a typo can never silently lift a limit.
             */
            getConfiguredPlatformCaps(): Partial<Record<EmailSendCapField, number>> {
                const configured: Partial<Record<EmailSendCapField, number>> = {};
                for (const [field, envName] of EMAIL_SEND_CAP_ENV) {
                    const raw = process.env[envName];
                    if (typeof raw !== 'string' || raw.trim() === '') continue;
                    configured[field] = emailCapEnv(
                        raw,
                        EMAIL_SEND_CAP_RECOMMENDED_DEFAULTS[field],
                    );
                }
                return configured;
            },
            /**
             * The recommended ceilings with any operator replacement applied
             * — a REFERENCE record (what each limit would be once turned on),
             * not what is enforced; see {@link getConfiguredPlatformCaps}.
             * `0` = no ceiling for that limit; an unparseable or out-of-range
             * value falls back to the documented default rather than to "none".
             */
            getPlatformCaps(): Record<EmailSendCapField, number> {
                return {
                    inboxDailySends: emailCapEnv(
                        process.env.EMAIL_SEND_CAP_INBOX_DAILY,
                        EMAIL_INBOX_DEFAULT_DAILY_CAP,
                    ),
                    inboxBurstSends: emailCapEnv(
                        process.env.EMAIL_SEND_CAP_INBOX_PER_MINUTE,
                        EMAIL_INBOX_BURST_SENDS,
                    ),
                    inboxBurstRecipients: emailCapEnv(
                        process.env.EMAIL_SEND_CAP_INBOX_RECIPIENTS_PER_5_MINUTES,
                        EMAIL_INBOX_BURST_RECIPIENTS,
                    ),
                    recipientsPerMessage: emailCapEnv(
                        process.env.EMAIL_SEND_CAP_RECIPIENTS_PER_MESSAGE,
                        EMAIL_MAX_RECIPIENTS_PER_MESSAGE,
                    ),
                    workspaceDailySends: emailCapEnv(
                        process.env.EMAIL_SEND_CAP_WORKSPACE_DAILY,
                        EMAIL_WORKSPACE_DAILY_CAP,
                    ),
                    workspaceMonthlySends: emailCapEnv(
                        process.env.EMAIL_SEND_CAP_WORKSPACE_MONTHLY,
                        EMAIL_WORKSPACE_MONTHLY_CAP,
                    ),
                };
            },
        },
        /**
         * Mode for an Agent that has no inbox settings of its own and whose
         * organization does not set one. Default `auto-send`: Agents that
         * could already send keep doing so. `draft-review` holds every such
         * Agent's mail for approval deployment-wide.
         */
        getDefaultAgentMode(): AgentInboxMode {
            const raw = (process.env.EMAIL_DEFAULT_AGENT_SEND_MODE || '').trim().toLowerCase();
            return raw === 'draft-review' ? 'draft-review' : 'auto-send';
        },
    },

    /**
     * APW-11 (App Launcher) — the installation switch of FR-54/FR-65, read by
     * **both** the API guard and the public feature list, so the web UI and the
     * API can never disagree about whether the launcher exists (APW11-G12,
     * plan §7).
     *
     * ## Why exactly `'true'`, and not the platform's `truthy()` set
     *
     * T9's task text asks for the accessor on one line to accept the
     * `'true' | '1' | 'yes'` set that `apps/api/src/api.controller.ts` uses for
     * the other public flags, while the line above it specifies the guard as
     * "404 unless `EVER_WORKS_APP_LAUNCHER_ENABLED === 'true'`". Those two
     * cannot both hold, and this is the resolution — taken deliberately, and
     * recorded here rather than left for the next reader to discover:
     *
     *   - The guard's contract is the explicit one, and it is what the
     *     launcher's own controller spec pins today: `'1'`, `'yes'`, `'TRUE'`,
     *     `''` and `'true '` are all **OFF** (`app-launcher.controller.spec.ts`,
     *     "treats %p as OFF — only the exact string 'true' switches it on").
     *   - The rationale offered for the wider set — "no installation that works
     *     today stops working" — cannot apply to a variable this epic
     *     introduces: nothing reads `EVER_WORKS_APP_LAUNCHER_ENABLED` outside
     *     the launcher, and all three deploy manifests ship `'false'` (T31,
     *     `apps/api/src/app-launcher/__tests__/launcher-deploy-switches.spec.ts`).
     *   - A surface-wide feature gate fails **closed**: a stray `1` in an
     *     environment file is far more likely to be a mistake than an
     *     intentional launch, and this switch is what keeps an unfinished
     *     feature invisible (404, never 403).
     *
     * If the wider set is ever wanted, it is this one function that changes —
     * the guard, the controller and the public config all read it through here,
     * which is the whole reason the accessor exists.
     *
     * An unset, empty or unrecognised value is OFF.
     */
    appLauncher: {
        isEnabled(): boolean {
            return process.env.EVER_WORKS_APP_LAUNCHER_ENABLED === 'true';
        },
    },
};

/** AW-05 — the operator env var that turns on each send ceiling platform-wide. */
const EMAIL_SEND_CAP_ENV: ReadonlyArray<readonly [EmailSendCapField, string]> = [
    ['inboxDailySends', 'EMAIL_SEND_CAP_INBOX_DAILY'],
    ['inboxBurstSends', 'EMAIL_SEND_CAP_INBOX_PER_MINUTE'],
    ['inboxBurstRecipients', 'EMAIL_SEND_CAP_INBOX_RECIPIENTS_PER_5_MINUTES'],
    ['recipientsPerMessage', 'EMAIL_SEND_CAP_RECIPIENTS_PER_MESSAGE'],
    ['workspaceDailySends', 'EMAIL_SEND_CAP_WORKSPACE_DAILY'],
    ['workspaceMonthlySends', 'EMAIL_SEND_CAP_WORKSPACE_MONTHLY'],
];

/** AW-05 — one send-ceiling env var: a non-negative integer, `0` = no ceiling. */
function emailCapEnv(raw: string | undefined, fallback: number): number {
    if (typeof raw !== 'string' || raw.trim() === '') return fallback;
    const parsed = Number(raw.trim());
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > EMAIL_SEND_CAP_MAX_CONFIGURABLE) {
        return fallback;
    }
    return parsed;
}

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

/* -------------------------------------------------------------------------- *
 * APW-06 T19 — the apps-domain and cluster-allowlist helpers (plan §8.3, §6.1)
 * -------------------------------------------------------------------------- */

/**
 * APW-06 T19 / plan §8.3 — the environment variable whose parse result
 * `config.everWorks.apps.getClusterPrivateAllowlist()` answers.
 *
 * Spelled once, here, and interpolated into the warning so an operator who typos
 * the name reads the name the platform actually reads. The `k8s` plugin has its
 * own copy of the same literal (`app-kubeconfig.guard.ts:48`) on purpose: the
 * plugin never imports this module (plan §6.1:929-930), so the two strings are
 * the contract rather than a shared constant.
 */
const APPS_CLUSTER_PRIVATE_ALLOWLIST_ENV = 'EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST';

/**
 * The apex the platform's own managed subdomains live under when
 * `EVER_WORKS_DOMAIN` is unset — the documented default of
 * `managed-subdomain.service.ts:298`, `cloudflare-dns.provider.ts:430` and
 * `subdomain-allocator.service.ts:192`, restated so this module cannot disagree
 * with them about where the platform's addresses are.
 */
const PLATFORM_MANAGED_DOMAIN_DEFAULT = 'ever.works';

/**
 * The logger the two APW-06 accessors of this module report through.
 *
 * A module-level Nest `Logger`, not `console`: the same reasoning
 * `git.facade.ts:347-349` records for its own logger — log output travels through
 * the standard pipeline and log-level controls apply to it. Nothing logged here
 * ever carries a secret: the messages name the *variable* and the offending apex
 * or allow-list entry, never the DNS API token beside them.
 */
const appsDomainLogger = new Logger('AppWorksConfig');

/**
 * Whether the shared-default branch has been recorded in this process (plan
 * §8.3: "the equality check is satisfied by definition and **recorded as such**").
 *
 * Recorded once rather than on every read: the getter is called per request, and
 * a line per call would turn a configuration decision into log noise — which is
 * exactly how a real warning gets ignored later.
 */
let appsDomainSharedDefaultRecorded = false;

/**
 * The platform's own apex: `EVER_WORKS_DOMAIN`, defaulting to the documented
 * `ever.works` when unset — and `null` when it is set to something that is not a
 * plain dotted DNS name.
 *
 * The distinction matters: an **unset** variable is the documented default and is
 * answered with it, while a **malformed** one is a misconfiguration that must not
 * be silently repaired into a domain the operator never wrote. `getDomain()`
 * reports the latter as its own refusal.
 */
function platformManagedDomain(): string | null {
    const raw = process.env.EVER_WORKS_DOMAIN;
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text.length === 0) return PLATFORM_MANAGED_DOMAIN_DEFAULT;
    return normalizeApexDomain(text);
}

/**
 * Every host the platform itself is served from, for the §8.3 relation check:
 * its apex plus the hosts of the two URLs this tree already reads for the
 * platform's own API and web app (`PLATFORM_API_URL`, read by
 * `deploy.service.ts:895`; `NEXT_PUBLIC_APP_URL`, read at
 * `deploy.service.ts:1344`).
 *
 * A URL that is malformed, unset or relative contributes no host — it is not a
 * platform host to guard against, and inventing one would refuse a legitimate
 * apex. Deduped, because the API and the web app usually share the apex.
 */
function platformManagedDomainHosts(): string[] {
    const hosts = new Set<string>();

    const platform = platformManagedDomain();
    if (platform) hosts.add(platform);

    for (const value of [process.env.PLATFORM_API_URL, process.env.NEXT_PUBLIC_APP_URL]) {
        const host = hostOfUrl(value);
        if (host) hosts.add(host);
    }

    return [...hosts];
}

/** The apex a configured URL is served from, or `null` when it is not a usable absolute URL. */
function hostOfUrl(raw: string | undefined): string | null {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text.length === 0) return null;

    try {
        return normalizeApexDomain(new URL(text).hostname);
    } catch {
        return null;
    }
}

/**
 * A configured apex, normalized (lowercased, root dot stripped), or `null` when
 * it is not a plain dotted DNS name.
 *
 * Refused shapes, each one a way a person could describe an apex that is not one:
 * a scheme or a path (`https://apps.example.com/x`), a port
 * (`apps.example.com:8443`), a wildcard (`*.example.com`), an underscore (not a
 * hostname, though DNS will carry it), an IP literal (a literal cannot take a
 * subdomain), a single label (`localhost`, and every internal name — a managed
 * address must be publicly resolvable), an empty label (`a..b`) and a label over
 * 63 characters (`apps.example.com` itself is capped at 253).
 *
 * Rejecting here rather than trimming to fit is deliberate: a "repaired" apex
 * would publish app addresses under a host the operator never configured, and the
 * plan's answer for an unusable apex is to disable the managed subdomain only
 * (plan §8.3:1138-1140).
 */
function normalizeApexDomain(raw: string | undefined): string | null {
    const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (text.length === 0) return null;

    const apex = text.endsWith('.') ? text.slice(0, -1) : text;
    if (apex.length === 0 || apex.length > 253) return null;
    if (!/^[a-z0-9.-]+$/.test(apex)) return null;
    if (isIP(apex) !== 0) return null;

    const labels = apex.split('.');
    if (labels.length < 2) return null;

    for (const label of labels) {
        if (label.length === 0 || label.length > 63) return null;
        if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return null;
    }

    return apex;
}

/**
 * Which forbidden relation an explicitly configured apex has to the platform's own
 * domains — `null` when it has none and the apex is therefore usable (plan
 * §8.3:1133-1135).
 *
 * The three relations are the plan's own list, and each is a cookie boundary being
 * crossed: an apex **equal to** the platform domain is not dedicated at all; one
 * **under** it can set a cookie for a domain the platform's session uses; one that
 * is a **parent** of it can do the same from above. A managed address under
 * *another Ever product's* domain (`ever.team`, `gauzy.co`) is forbidden too, but
 * that is a product rule rather than a relation to this installation's domain —
 * it is enforced where the address is built, from this getter's answer plus the
 * operator's own configuration.
 */
function appsDomainClash(apex: string): string | null {
    for (const platformHost of platformManagedDomainHosts()) {
        if (apex === platformHost) return 'equal to';
        if (apex.endsWith(`.${platformHost}`)) return 'under';
        if (platformHost.endsWith(`.${apex}`)) return 'a parent of';
    }

    return null;
}

/**
 * Record the shared-default branch once per process (plan §8.3:1135-1138).
 *
 * This is the branch that makes `<slug>.ever.works` work out of the box, and the
 * line says so — plus which safeguards carry the isolation the dedicated-apex
 * branch would have provided structurally, so an operator reading logs knows what
 * they have rather than only what they do not.
 */
function recordAppsDomainSharedDefault(platform: string): void {
    if (appsDomainSharedDefaultRecorded) return;
    appsDomainSharedDefaultRecorded = true;

    appsDomainLogger.log(
        `EVER_WORKS_APPS_DOMAIN is unset, so the shared default applies: an App Work's managed ` +
            `subdomain is served as <slug>.${platform} (plan §8.3, Resolution R-16). Cookie ` +
            `isolation is carried by the platform-domain safeguards — host-only __Host- Secure ` +
            `cookies on platform routes, no platform session cookie on app hosts — rather than by ` +
            `a dedicated apex.`,
    );
}

/** The parse result of the cluster private allow-list: what survives, and what did not. */
interface ClusterPrivateAllowlistParse {
    /** The entries that parse, **verbatim** — exactly the strings the operator typed. */
    cidrs: string[];
    /** The entries that do not, so the caller can warn about each one before dropping it. */
    invalid: string[];
}

/**
 * APW-06 T19 / plan §6.1:922-934 — parse `EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST`.
 *
 * The semantics are copied from the `k8s` plugin's `parsePrivateAllowlist`
 * (`app-kubeconfig.guard.ts:184-201`) on purpose, down to "the entry is returned
 * verbatim": one environment value must mean one list on both sides of the worker
 * boundary, and the plugin's copy is the one the guard actually classifies
 * addresses with. Comma- or whitespace-separated, a bare address reading as `/32`
 * or `/128`, blank tokens skipped, everything else reported as `invalid` and
 * dropped (it never widens the policy).
 *
 * ⚠️ Provisional: the plugin SDK's `parsePrivateAllowlist` (APW06-G20,
 * `@ever-works/plugin/helpers/cluster-address-policy`) does not exist on this
 * branch, so this is the narrowest local seam; the swap is one import and one
 * delegation, and nothing here is removed when it lands.
 */
function parseClusterPrivateAllowlist(
    raw: string | undefined | null,
): ClusterPrivateAllowlistParse {
    const cidrs: string[] = [];
    const invalid: string[] = [];

    for (const token of String(raw ?? '').split(/[\s,]+/)) {
        const entry = token.trim();
        if (entry.length === 0) continue;

        if (isCidrEntry(entry)) {
            cidrs.push(entry);
        } else {
            invalid.push(entry);
        }
    }

    return { cidrs, invalid };
}

/** Whether one allow-list entry is an IP address or an address/prefix pair of a sane width. */
function isCidrEntry(entry: string): boolean {
    const slash = entry.lastIndexOf('/');
    const addressPart = stripBrackets(slash === -1 ? entry : entry.slice(0, slash));
    const prefixPart = slash === -1 ? null : entry.slice(slash + 1).trim();

    const family = isIP(addressPart);
    if (family !== 4 && family !== 6) return false;

    if (prefixPart === null) return true;
    if (!/^\d+$/.test(prefixPart)) return false;

    const prefix = Number(prefixPart);
    return Number.isSafeInteger(prefix) && prefix >= 0 && prefix <= (family === 4 ? 32 : 128);
}

/** `[::1]` → `::1`; anything else unchanged. Bracketed IPv6 is what a URL spells, not a CIDR. */
function stripBrackets(value: string): string {
    const text = value.trim();
    return text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
}
