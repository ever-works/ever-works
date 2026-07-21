import { Injectable, Logger } from '@nestjs/common';
import { WorkRepository } from '@src/database/repositories/work.repository';
import { ZeroFrictionFunnelService } from './zero-friction-funnel.service';
import { ZERO_FRICTION_FUNNEL_EVENTS } from '@ever-works/contracts/telemetry';

export interface DeployReadyPollerSummary {
    scanned: number;
    ready: number;
    stillPending: number;
    failed: number;
}

const READY_STATE = 'READY';

/**
 * Health endpoint probed on each tenant site.
 *
 * **Must stay in sync with the deployed website template.** Both
 * `apps/web` and the directory website template expose `/api/health`
 * (200 + `{"status":"ok",...}`, and a HEAD handler). There is no
 * `/api/healthz` route anywhere in this repo — probing it returns 404,
 * which the poller reads as "not ready yet", so every work would sit in
 * its pending state forever. See spec `038-k8s-deploy-probes`.
 */
const HEALTH_PATH = '/api/health';

/** Placeholder substituted in `EVER_WORKS_DEPLOY_INGRESS_HOST_TEMPLATE`. */
const SLUG_PLACEHOLDER = /\{slug\}/g;

/**
 * Pending-style states the poller probes for readiness. Mirrors the
 * states the DeploymentVerifierService transitions through.
 *
 * **Mixed case is intentional.** `'pending'` is the legacy internal
 * state value; `'INITIALIZING' | 'QUEUED' | 'BUILDING'` are Vercel's
 * own deployment state names stored verbatim. Postgres string
 * matching is case-sensitive, so each row appears exactly once in
 * one canonical case. Normalising would require a one-shot
 * migration of historical rows — leave as-is until that's planned.
 */
const PENDING_STATES: readonly string[] = ['pending', 'INITIALIZING', 'QUEUED', 'BUILDING'];

/**
 * EW-617 G8 — emits the funnel `deploy_ready` event when a freshly
 * deployed Work's slug-based URL starts responding 200. Backed by a
 * Trigger.dev schedule (every 2 minutes); see
 * `packages/tasks/src/tasks/trigger/deploy-ready-poller.task.ts`.
 *
 * Strictly best-effort:
 *  - works without a persisted `lastDeployCorrelationId` get their state
 *    flipped to READY but no funnel event is emitted (we have nothing to
 *    correlate with).
 *  - health-check failures (network errors, non-200 responses) leave the
 *    row in its current state for the next poll tick.
 *
 * **Implementation notes worth flagging:**
 *
 *   - **Probes are sequential**, not parallel. With a default
 *     `healthTimeoutMs` of 5s, N pending works can take up to N×5s
 *     per tick in the worst case. Trigger.dev's schedule is every
 *     2 minutes, so this is fine up to ~20 pending works; past
 *     that, ticks start backing up. If pending volumes grow,
 *     parallelise with `Promise.allSettled` (bound concurrency to
 *     avoid hammering DNS).
 *
 *   - **`probeUrl` collapses every failure mode** (DNS error,
 *     network timeout, non-200, abort) into a single `false`.
 *     The summary counts these as `stillPending`, NOT `failed`.
 *     `summary.failed` only counts thrown errors AROUND the
 *     probe — DB update failures, funnel emit errors, etc. Keep
 *     this in mind when alerting on the summary.
 *
 *   - **`elapsedMs` defaults to `0`** when `deploymentStartedAt` is
 *     missing — funnel events for legacy works (pre-timestamp)
 *     will show elapsed=0, which skews any "time to ready"
 *     analytics. Filter out elapsedMs=0 in the PostHog query, or
 *     bake a `hasElapsed` discriminator into the payload here.
 *
 *   - **Host resolution** is `options.hostTemplate` →
 *     `EVER_WORKS_DEPLOY_INGRESS_HOST_TEMPLATE` env →
 *     `{slug}.<options.domain ?? EVER_WORKS_DOMAIN>` → THROW.
 *
 *     The template is the SAME value the deployer uses to build each
 *     tenant Ingress, so the poller probes exactly the host that was
 *     provisioned. This matters because the envs do not share a
 *     hostname shape: prod is `{slug}.ever.works` but dev is
 *     `{slug}-dev.ever.works`. The old domain-only form could only
 *     ever produce `{slug}.<domain>`, so there was no value of
 *     `EVER_WORKS_DOMAIN` that let dev probe its own sites — setting
 *     it to `ever.works` in dev would have made dev probe PRODUCTION
 *     hostnames and flip dev rows to READY off a prod site's health.
 *
 *     We still deliberately do NOT fall through to a hardcoded
 *     `'ever.works'`: with neither template nor domain configured we
 *     throw, so a misconfig surfaces as an error instead of silently
 *     probing the production hostname pattern.
 */
@Injectable()
export class DeployReadyPollerService {
    private readonly logger = new Logger(DeployReadyPollerService.name);

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly funnel: ZeroFrictionFunnelService,
    ) {}

    async pollOnce(
        options: {
            fetch?: typeof fetch;
            now?: () => Date;
            healthTimeoutMs?: number;
            domain?: string;
            hostTemplate?: string;
        } = {},
    ): Promise<DeployReadyPollerSummary> {
        const httpFetch = options.fetch ?? fetch;
        const now = options.now ?? (() => new Date());
        const timeoutMs = options.healthTimeoutMs ?? 5000;
        // Prefer the ingress host template — it is the same value the
        // deployer used to create each tenant Ingress, so we probe exactly
        // the host that exists. Falls back to the legacy `{slug}.<domain>`
        // form when unset. No hardcoded fallback in either case: a
        // misconfigured env probing the production hostname pattern would
        // report false-positive READY states for any slug that happens to
        // match a live production site (greptile P2 on PR #1031).
        const hostTemplate =
            options.hostTemplate?.trim() ||
            process.env.EVER_WORKS_DEPLOY_INGRESS_HOST_TEMPLATE?.trim();
        const domain = options.domain?.trim() || process.env.EVER_WORKS_DOMAIN?.trim();
        if (!hostTemplate && !domain) {
            throw new Error(
                'deploy-ready-poller: host not configured — set EVER_WORKS_DEPLOY_INGRESS_HOST_TEMPLATE ' +
                    '(preferred) or EVER_WORKS_DOMAIN env, or pass options.hostTemplate / options.domain',
            );
        }

        const pendingWorks = await this.workRepository.findByDeploymentStates([...PENDING_STATES]);
        const summary: DeployReadyPollerSummary = {
            scanned: pendingWorks.length,
            ready: 0,
            stillPending: 0,
            failed: 0,
        };

        for (const work of pendingWorks) {
            try {
                // Security (SSRF): the slug is validated as DNS-safe on creation
                // (DTO `@Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)`) but is re-read
                // from the DB here with no guarantee it still matches (direct DB
                // writes, migration gaps, legacy rows). Re-validate before
                // interpolating it into the probe/website URL so a malformed slug
                // (e.g. containing `@`, `/`, `#`, `?`, null bytes, or empty) can't
                // redirect the fetch to an attacker-controlled or internal host.
                // Mirrors `CloudflareDnsProvider.assertSlug`. Routed through the
                // existing catch → counted as `failed` and logged.
                if (!this.isValidSlug(work.slug)) {
                    throw new Error(
                        `refusing to probe work with malformed slug: ${JSON.stringify(work.slug)}`,
                    );
                }
                const host = this.resolveHost(work.slug, hostTemplate, domain);
                const websiteUrl = `https://${host}`;
                const ok = await this.probeUrl(httpFetch, `${websiteUrl}${HEALTH_PATH}`, timeoutMs);
                if (!ok) {
                    summary.stillPending += 1;
                    continue;
                }

                const startedAt = work.deploymentStartedAt
                    ? new Date(work.deploymentStartedAt).getTime()
                    : undefined;
                const elapsedMs = startedAt ? now().getTime() - startedAt : 0;

                await this.workRepository.update(work.id, { deploymentState: READY_STATE });
                summary.ready += 1;

                if (work.lastDeployCorrelationId) {
                    this.funnel.emit({
                        event: ZERO_FRICTION_FUNNEL_EVENTS.DEPLOY_READY,
                        funnelStep: 7,
                        timestamp: now().toISOString(),
                        correlationId: work.lastDeployCorrelationId,
                        workId: work.id,
                        websiteUrl,
                        elapsedMs,
                    });
                }
            } catch (cause) {
                summary.failed += 1;
                const message = cause instanceof Error ? cause.message : String(cause);
                this.logger.warn(`deploy-ready-poller failed for work ${work.id}: ${message}`);
            }
        }

        return summary;
    }

    // Security (SSRF): canonical DNS-safe slug shape shared across the
    // codebase (Work DTO `@Matches`, CloudflareDnsProvider.assertSlug).
    // Re-checked here because the slug is read back from the DB and cannot
    // be trusted to still satisfy the creation-time constraint.
    private isValidSlug(slug: string): boolean {
        return typeof slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
    }

    /**
     * Build the tenant hostname for a slug.
     *
     * Prefers the ingress host template (`{slug}` placeholder, e.g.
     * `{slug}-dev.ever.works`) so the probe targets the host the deployer
     * actually provisioned; falls back to the legacy `{slug}.<domain>`.
     *
     * Security (SSRF): the slug is already re-validated by `isValidSlug`,
     * but the TEMPLATE is operator-supplied and could be malformed (a stray
     * `/`, `@`, `:` or a missing placeholder would otherwise let the probe
     * URL point at an unintended host — e.g. a template of `evil.com/{slug}`
     * would make `https://evil.com/x/api/health` the probe target). So we
     * validate the FINAL substituted host label-by-label, mirroring
     * `CloudflareDnsProvider.normalizeHost`. Throws → counted as `failed`.
     */
    private resolveHost(slug: string, hostTemplate?: string, domain?: string): string {
        const raw = hostTemplate
            ? hostTemplate.replace(SLUG_PLACEHOLDER, slug)
            : `${slug}.${domain}`;

        const host = raw.trim().toLowerCase();
        if (host.length === 0 || host.length > 253) {
            throw new Error(`refusing to probe invalid host: ${JSON.stringify(raw)}`);
        }
        const labelRe = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
        for (const label of host.split('.')) {
            if (!labelRe.test(label) || label.length > 63) {
                throw new Error(`refusing to probe invalid host: ${JSON.stringify(raw)}`);
            }
        }
        return host;
    }

    private async probeUrl(
        httpFetch: typeof fetch,
        url: string,
        timeoutMs: number,
    ): Promise<boolean> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await httpFetch(url, { method: 'GET', signal: controller.signal });
            return res.status === 200;
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }
}
