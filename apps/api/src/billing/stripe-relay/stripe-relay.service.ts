import { Injectable, Logger } from '@nestjs/common';
import { createHash, createHmac } from 'crypto';
import { StripeRelayDeadLetterRepository, WorkRepository } from '@ever-works/agent/database';
import {
    StripeRelayDeadLetterResolution,
    StripeRelayDeadLetterStatus,
} from '@ever-works/agent/entities';
import { PlatformSyncSecretService } from '@ever-works/agent/services';
import { constructStripeEvent } from '@ever-works/agent/subscriptions';
import { isSafeWebhookUrl } from '@ever-works/agent/utils';

/**
 * The shared Stripe **webhook relay** (relay phase 3).
 *
 * WHY THIS EXISTS
 *
 * Stripe caps an account at **16 live webhook endpoints**. Ever Works runs 15
 * directory sites on ONE shared Stripe account, alongside four platform
 * endpoints — so per-site endpoints cannot scale, and today three directories
 * have no slot at all and run fail-closed (they cannot charge).
 *
 * The platform therefore owns a SINGLE Stripe endpoint. It verifies Stripe's
 * signature once, resolves which directory owns the event from
 * `metadata.work_id`, and forwards the event to that directory's
 * `/api/stripe/platform-webhook` over the platform to site HMAC channel already
 * shipped for the activity feed.
 *
 * Spec: `knowledge/runbooks/EVER_WORKS_STRIPE_WEBHOOK_RELAY.md` in
 * `ever-works/workspace`.
 *
 * Posture mirrors `DirectoryWebsiteClient` (the other outbound platform to site
 * caller): SSRF guard BEFORE signing, per-Work secret, work id inside the
 * signed payload, no redirects, bounded timeout, and never logs a payload.
 *
 * DEAD LETTERS (audit CC05-06)
 *
 * Every event that names a `work_id` and is NOT confirmed delivered is written
 * to `stripe_relay_dead_letters` with its verbatim payload, so nothing a
 * directory was owed can vanish with a log line. A later delivery of the same
 * event (a Stripe retry, or an operator replay through the admin routes)
 * resolves the row. If the dead letter itself cannot be written, the relay
 * answers Stripe 503 rather than acknowledging an event it could neither
 * deliver nor record.
 */

/** Bound on how long we wait for a directory before telling Stripe to retry. */
const FORWARD_TIMEOUT_MS = 10_000;

/** The site's success body is a few dozen bytes; never parse an unbounded one. */
const MAX_SITE_BODY_CHARS = 64 * 1024;

/**
 * Default grace before an open dead letter turns the health probe red. Stripe
 * retries a failed delivery a few times in the first hour, and a short site
 * restart resolves itself through those retries without anyone acting.
 */
const DEFAULT_ALERT_AFTER_MINUTES = 60;

export type StripeRelayOutcome =
    /**
     * Delivered, and the directory CONFIRMED it ran the handler
     * (`dispatched: true`) or had already processed the event
     * (`duplicate: true`). Answer Stripe 200.
     */
    | { status: 'forwarded'; eventId: string; workId: string; siteStatus: number }
    /**
     * Verified, but a retry cannot deliver it: no `work_id` (a platform-owned
     * event, the normal case for most traffic), an unknown Work, the SSRF
     * guard, a 409 ownership mismatch or a 400 malformed body. Answer Stripe
     * 200. Everything except `no_work_id` is dead-lettered for an operator.
     */
    | { status: 'unroutable'; eventId: string; reason: string }
    /**
     * Fixable without code: the directory is down or timed out, rejected our
     * signature, answered an unexpected 4xx (a missing ingress or tunnel rule
     * 404s, a WAF challenge 403s) or a redirect, did not confirm it
     * dispatched, or the Work is not deployed / provisioned yet. Answer
     * Stripe 503 so Stripe RETRIES (for about three days), and dead-letter it.
     */
    | { status: 'retry'; eventId: string; reason: string };

export type StripeRelayReplayResult =
    | { status: 'already-resolved'; eventId: string }
    | { status: 'forwarded'; eventId: string; workId: string; siteStatus: number }
    | { status: 'failed'; eventId: string; disposition: 'retry' | 'unroutable'; reason: string };

export class StripeRelayNotConfiguredError extends Error {}
export class StripeRelaySignatureError extends Error {}
export class StripeRelayDeadLetterNotFoundError extends Error {
    constructor(eventId: string) {
        super(`No dead letter for event ${eventId}`);
        this.name = 'StripeRelayDeadLetterNotFoundError';
    }
}

interface RelayEvent {
    id: string;
    type: string;
    livemode?: boolean;
    data?: { object?: unknown };
}

/** Why the relay did not deliver: carried alongside the outcome for the dead letter. */
interface RouteResult {
    outcome: StripeRelayOutcome;
    workId: string | null;
    siteStatus: number | null;
}

@Injectable()
export class StripeRelayService {
    private readonly logger = new Logger(StripeRelayService.name);

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly secretService: PlatformSyncSecretService,
        private readonly deadLetters: StripeRelayDeadLetterRepository,
    ) {}

    /** Off by default — the relay ships dark and is switched on per environment. */
    isEnabled(): boolean {
        return process.env.STRIPE_RELAY_ENABLED === 'true';
    }

    /**
     * Verify Stripe's signature, resolve the owning directory, forward, and
     * dead-letter anything that names a directory but did not reach it.
     *
     * @throws StripeRelayNotConfiguredError when no relay signing secret is set
     *         (FAIL CLOSED — an unconfigured receiver rejects rather than trusts).
     * @throws StripeRelaySignatureError when verification fails.
     */
    async handle(rawBody: string, signature: string | undefined): Promise<StripeRelayOutcome> {
        const webhookSecret = process.env.STRIPE_RELAY_WEBHOOK_SECRET;
        if (!webhookSecret) {
            throw new StripeRelayNotConfiguredError('Relay receiver is not configured');
        }
        if (!signature) {
            throw new StripeRelaySignatureError('Missing webhook signature header');
        }

        let event: RelayEvent;
        try {
            event = constructStripeEvent(rawBody, signature, webhookSecret);
        } catch {
            // The SDK message can quote header content — never echo it.
            throw new StripeRelaySignatureError('Webhook signature verification failed');
        }

        const routed = await this.route(event, rawBody);
        return this.settle(event, rawBody, routed, StripeRelayDeadLetterResolution.STRIPE_RETRY);
    }

    /**
     * Operator replay of a dead letter: route the STORED payload again, exactly
     * as the original delivery would have been routed.
     *
     * Stripe's signature is deliberately not re-checked: it was verified when
     * the payload was stored, the row is server-side data, and Stripe's
     * timestamp tolerance (five minutes) would reject any replay anyway.
     */
    async replay(eventId: string): Promise<StripeRelayReplayResult> {
        const row = await this.deadLetters.findByEventId(eventId);
        if (!row) {
            throw new StripeRelayDeadLetterNotFoundError(eventId);
        }
        if (row.status !== StripeRelayDeadLetterStatus.OPEN) {
            return { status: 'already-resolved', eventId };
        }

        let event: RelayEvent;
        try {
            event = JSON.parse(row.payload) as RelayEvent;
        } catch {
            return {
                status: 'failed',
                eventId,
                disposition: 'unroutable',
                reason: 'payload_unreadable',
            };
        }
        if (!event || event.id !== eventId) {
            return {
                status: 'failed',
                eventId,
                disposition: 'unroutable',
                reason: 'payload_mismatch',
            };
        }

        const routed = await this.route(event, row.payload);
        const outcome = await this.settle(
            event,
            row.payload,
            routed,
            StripeRelayDeadLetterResolution.REPLAYED,
        );
        if (outcome.status === 'forwarded') {
            return outcome;
        }
        return { status: 'failed', eventId, disposition: outcome.status, reason: outcome.reason };
    }

    /** Close a dead letter by hand (for example after fulfilling it manually). */
    async dismiss(eventId: string): Promise<boolean> {
        const row = await this.deadLetters.findByEventId(eventId);
        if (!row) {
            throw new StripeRelayDeadLetterNotFoundError(eventId);
        }
        return this.deadLetters.markResolved(eventId, StripeRelayDeadLetterResolution.DISMISSED);
    }

    /**
     * The public health probe's verdict: healthy while no dead letter has been
     * open longer than the grace period. Returns the count only to the caller
     * that decides the HTTP status; the probe body carries no detail.
     */
    async openDeadLetterCount(now: Date = new Date()): Promise<number> {
        // An empty or blank value means "not configured" (Number('') is 0,
        // which would silently drop the grace period to nothing).
        const raw = process.env.STRIPE_RELAY_DEAD_LETTER_ALERT_AFTER_MINUTES?.trim();
        const minutes = raw ? Number(raw) : Number.NaN;
        const graceMinutes =
            Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_ALERT_AFTER_MINUTES;
        return this.deadLetters.countOpen(new Date(now.getTime() - graceMinutes * 60_000));
    }

    /**
     * Resolve the owning directory and forward. Pure routing: no persistence.
     */
    private async route(event: RelayEvent, rawBody: string): Promise<RouteResult> {
        const workId = extractWorkId(event);
        if (!workId) {
            // Not an error: platform-owned events (and Stripe's own test pings)
            // legitimately carry no directory routing key.
            this.logger.warn(`relay: event ${event.id} (${event.type}) carries no work_id`);
            return {
                outcome: { status: 'unroutable', eventId: event.id, reason: 'no_work_id' },
                workId: null,
                siteStatus: null,
            };
        }

        const unroutable = (reason: string): RouteResult => ({
            outcome: { status: 'unroutable', eventId: event.id, reason },
            workId,
            siteStatus: null,
        });
        const retry = (reason: string): RouteResult => ({
            outcome: { status: 'retry', eventId: event.id, reason },
            workId,
            siteStatus: null,
        });

        const work = await this.workRepository.findById(workId);
        if (!work) {
            this.logger.warn(`relay: event ${event.id} names unknown work ${workId}`);
            return unroutable('unknown_work');
        }
        const website = resolveDirectoryWebsite(work);
        if (!website) {
            // A Work that has not been deployed YET is fixable by deploying it
            // inside Stripe's retry window, so keep the event alive.
            this.logger.warn(`relay: work ${workId} has no deployed website`);
            return retry('not_deployed');
        }

        let secret: string | null;
        try {
            secret = this.secretService.decryptForWork(work);
        } catch (err) {
            this.logger.warn(
                `relay: decryptForWork failed for work ${workId}: ${(err as Error).message}`,
            );
            return retry('secret_undecryptable');
        }
        if (!secret) {
            // The site was never provisioned with PLATFORM_SYNC_SECRET, so it
            // would answer 503. A re-provision inside Stripe's retry window
            // fixes it; acknowledging would drop the event for good.
            return retry('not_provisioned');
        }

        return this.forward(work.id, website, secret, rawBody, event.id);
    }

    /**
     * Record the routing decision: resolve an open dead letter on delivery,
     * dead-letter anything that named a directory and did not reach it.
     */
    private async settle(
        event: RelayEvent,
        rawBody: string,
        routed: RouteResult,
        resolution: StripeRelayDeadLetterResolution,
    ): Promise<StripeRelayOutcome> {
        const { outcome } = routed;

        if (outcome.status === 'forwarded') {
            try {
                if (await this.deadLetters.markResolved(event.id, resolution)) {
                    this.logger.log(`relay: dead letter ${event.id} resolved (${resolution})`);
                }
            } catch (err) {
                // The event WAS delivered; a stale open row is a false alarm,
                // not a lost payment. Never turn a delivery into a retry.
                this.logger.warn(
                    `relay: could not resolve dead letter ${event.id}: ${(err as Error).message}`,
                );
            }
            return outcome;
        }

        if (outcome.status === 'unroutable' && outcome.reason === 'no_work_id') {
            return outcome;
        }

        try {
            await this.deadLetters.recordFailure({
                eventId: event.id,
                eventType: String(event.type ?? 'unknown').slice(0, 100),
                workId: routed.workId ? routed.workId.slice(0, 128) : null,
                livemode: event.livemode === true,
                disposition: outcome.status,
                reason: outcome.reason.slice(0, 64),
                siteStatus: routed.siteStatus,
                payload: rawBody,
                at: new Date(),
            });
            this.logger.error(
                `relay: DEAD LETTER event ${event.id} (${event.type}) work ${routed.workId}: ${outcome.status} ${outcome.reason}`,
            );
            return outcome;
        } catch (err) {
            this.logger.error(
                `relay: could not record dead letter for event ${event.id} (${outcome.status} ${outcome.reason}): ${(err as Error).message}`,
            );
            // Neither delivered nor recorded: make Stripe keep it.
            return { status: 'retry', eventId: event.id, reason: 'dead_letter_unavailable' };
        }
    }

    /**
     * POST the VERBATIM raw body to the directory, signed with the per-Work
     * secret. The body must not be re-serialised: the signature covers a digest
     * of these exact bytes, and the site recomputes it byte-for-byte.
     */
    private async forward(
        workId: string,
        website: string,
        secret: string,
        rawBody: string,
        eventId: string,
    ): Promise<RouteResult> {
        const url = `${stripTrailingSlash(website)}/api/stripe/platform-webhook`;
        const result = (outcome: StripeRelayOutcome, siteStatus: number | null): RouteResult => ({
            outcome,
            workId,
            siteStatus,
        });

        // Security (SSRF + signed-bearer leak) — identical reasoning to
        // DirectoryWebsiteClient: the resolved website is attacker-influenceable
        // (a tenant's verified custom domain may be promoted into it), and the request
        // below carries an HMAC Bearer header bound to the per-Work secret. Refuse
        // BEFORE signing so the secret never leaves the process for an unsafe
        // target. Local dev/test may legitimately point a Work at http://localhost.
        const env = process.env.NODE_ENV;
        const isLocalEnv = env === 'development' || env === 'test';
        if (!isLocalEnv && !isSafeWebhookUrl(url)) {
            this.logger.warn(
                `relay: forward blocked by SSRF guard for work ${workId} (host resolves to a private / loopback / link-local / metadata target)`,
            );
            return result({ status: 'unroutable', eventId, reason: 'ssrf_blocked' }, null);
        }

        const timestamp = new Date().toISOString();
        const bodyDigest = createHash('sha256').update(rawBody, 'utf8').digest('hex');
        // Same formula the activity feed uses, with the body digest in the slot
        // the feed fills with its canonical query — so the directory verifies it
        // with `verifyPlatformSignature` unchanged. The work id is inside the
        // signed payload, so a signature leaked from one directory cannot be
        // replayed against another.
        const hmac = createHmac('sha256', secret)
            .update(`${timestamp}:${bodyDigest}:${workId}`)
            .digest('hex');

        let response: Response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${hmac}`,
                    'x-platform-ts': timestamp,
                    'User-Agent': 'ever-works-platform/stripe-relay',
                },
                body: rawBody,
                redirect: 'manual',
                signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
            });
        } catch (err) {
            // Raw messages embed internal IPs/hostnames — keep them server-side.
            this.logger.warn(`relay: forward to work ${workId} failed: ${(err as Error).message}`);
            return result({ status: 'retry', eventId, reason: 'network' }, null);
        }

        const siteStatus = response.status;
        if (siteStatus < 200 || siteStatus >= 300) {
            // We never read an error body; release the connection instead of
            // leaving it to the garbage collector.
            discardBody(response);
        }

        if (siteStatus >= 200 && siteStatus < 300) {
            // 🛑 A 2xx proves only that SOMETHING answered. On 2026-08-27, 13 of
            // 15 directories ran a bundle whose receiver verified the HMAC and
            // returned 200 without fulfilling anything. Only the site's own
            // confirmation counts as delivered.
            const verdict = await readSiteVerdict(response);
            if (verdict === 'confirmed') {
                this.logger.log(`relay: event ${eventId} -> work ${workId} (site ${siteStatus})`);
                return result({ status: 'forwarded', eventId, workId, siteStatus }, siteStatus);
            }
            this.logger.error(
                `relay: work ${workId} answered ${siteStatus} for event ${eventId} without confirming dispatch`,
            );
            return result({ status: 'retry', eventId, reason: 'site_unconfirmed' }, siteStatus);
        }

        if (siteStatus === 409) {
            // The directory says this event's work_id names a DIFFERENT
            // directory. That is a routing bug on our side; retrying repeats it.
            this.logger.error(
                `relay: work ${workId} rejected event ${eventId} as belonging to another directory`,
            );
            return result({ status: 'unroutable', eventId, reason: 'work_mismatch' }, siteStatus);
        }
        if (siteStatus === 400) {
            // The directory could not parse the event. Retrying sends the same
            // bytes, so it cannot help; the dead letter keeps it for a replay
            // once the site is fixed.
            return result({ status: 'unroutable', eventId, reason: 'site_400' }, siteStatus);
        }
        if (siteStatus === 401) {
            // Stale/rotated secret. Retry: a re-sync may fix it within Stripe's
            // retry window, and silently dropping a paid event is worse.
            this.logger.error(`relay: work ${workId} rejected our signature for event ${eventId}`);
            return result({ status: 'retry', eventId, reason: 'unauthorized' }, siteStatus);
        }

        // Everything else is fixable by configuration inside Stripe's retry
        // window: 5xx (site down), 404 (missing ingress or tunnel rule — the
        // 2026-08-23 rust-tools failure), 403 (a WAF challenge), 3xx (a
        // redirect we refuse to follow), 413 (an ingress body limit), 429.
        this.logger.warn(`relay: work ${workId} answered ${siteStatus} for event ${eventId}`);
        return result({ status: 'retry', eventId, reason: `site_${siteStatus}` }, siteStatus);
    }
}

/**
 * Did the directory confirm it handled the event?
 *
 * The directory's `/api/stripe/platform-webhook` answers
 * `{ received: true, type, dispatched: true }` after running the payment
 * handler, and `{ received: true, duplicate: true }` for an event it already
 * processed. Anything else, including an unreadable body, is unconfirmed.
 */
async function readSiteVerdict(response: Response): Promise<'confirmed' | 'unconfirmed'> {
    try {
        const text = await readBounded(response, MAX_SITE_BODY_CHARS);
        if (!text) return 'unconfirmed';
        const body = JSON.parse(text) as { dispatched?: unknown; duplicate?: unknown };
        return body?.dispatched === true || body?.duplicate === true ? 'confirmed' : 'unconfirmed';
    } catch {
        return 'unconfirmed';
    }
}

/**
 * Read at most `limit` characters of the body, cancelling the stream as soon
 * as it runs over, so a misbehaving directory cannot make the API buffer an
 * unbounded body. Returns null for an oversized, absent or unreadable body.
 */
async function readBounded(response: Response, limit: number): Promise<string | null> {
    const reader = response.body?.getReader();
    if (!reader) return null;
    const decoder = new TextDecoder();
    let text = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
            if (text.length > limit) {
                void reader.cancel().catch(() => undefined);
                return null;
            }
        }
        text += decoder.decode();
        return text;
    } catch {
        void reader.cancel().catch(() => undefined);
        return null;
    }
}

function discardBody(response: Response): void {
    try {
        void response.body?.cancel().catch(() => undefined);
    } catch {
        // Nothing to release.
    }
}

/**
 * Resolve the directory's public base URL without requiring a data migration.
 *
 * Older managed k8s Works predate `managedSubdomain` and several have a null
 * `website` even though their canonical `${slug}.ever.works` deployment is
 * live. The deploy pipeline deliberately preserves that legacy derivation and
 * ignores stale `*.vercel.app` placeholders for managed k8s Works; the relay
 * must do the same or it will classify paid events as permanently unroutable.
 * Real explicit website URLs still win, and unmanaged providers never get a
 * guessed destination.
 */
function resolveDirectoryWebsite(work: {
    website?: string | null;
    deployProvider?: string | null;
    managedSubdomain?: string | null;
    slug?: string | null;
}): string | null {
    const isManagedProvider = work.deployProvider === 'k8s' || work.deployProvider === 'ever-works';
    const explicit = work.website?.trim();
    if (explicit) {
        let isVercelPlaceholder = false;
        try {
            const parsed = new URL(explicit.includes('://') ? explicit : `https://${explicit}`);
            isVercelPlaceholder = parsed.hostname.toLowerCase().endsWith('.vercel.app');
        } catch {
            // Preserve the existing explicit-target behavior; the forwarder's
            // SSRF/URL checks remain the authority for malformed values.
        }
        if (!isManagedProvider || !isVercelPlaceholder) return explicit;
    }

    if (!isManagedProvider) {
        return null;
    }

    const isDnsLabel = (value: string) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
    const subdomainCandidates = [work.managedSubdomain, work.slug]
        .map((value) => value?.trim().toLowerCase() ?? '')
        .filter((value) => isDnsLabel(value));
    const subdomain = subdomainCandidates[0];
    if (!subdomain) return null;

    const rootDomain = process.env.EVER_WORKS_DOMAIN?.trim().toLowerCase() || 'ever.works';
    if (!rootDomain.split('.').every((label) => isDnsLabel(label))) {
        return null;
    }
    return `https://${subdomain}.${rootDomain}`;
}

/**
 * Resolve the owning directory from the event.
 *
 * 🛑 Stripe does NOT copy a Checkout Session's metadata onto the Subscription or
 * PaymentIntent it creates, which is why the template stamps
 * `subscription_data.metadata` / `payment_intent_data.metadata` explicitly
 * (relay phase 1). The fallbacks below cover invoice shapes, where the routing
 * key rides on the subscription details or the line items rather than the
 * invoice itself.
 */
export function extractWorkId(event: { data?: { object?: unknown } }): string | null {
    const obj = (event.data?.object ?? {}) as Record<string, unknown>;

    const read = (bag: unknown): string | null => {
        const value = (bag as { work_id?: unknown } | undefined)?.work_id;
        return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
    };

    const direct = read((obj as { metadata?: unknown }).metadata);
    if (direct) return direct;

    // Stripe v18 invoice.* — the subscription's metadata is nested below
    // `parent.subscription_details`; older event shapes used the top level.
    const parentDetails = read(
        (obj as { parent?: { subscription_details?: { metadata?: unknown } } }).parent
            ?.subscription_details?.metadata,
    );
    if (parentDetails) return parentDetails;

    const details = read(
        (obj as { subscription_details?: { metadata?: unknown } }).subscription_details?.metadata,
    );
    if (details) return details;

    const lines = (obj as { lines?: { data?: Array<{ metadata?: unknown }> } }).lines?.data;
    if (Array.isArray(lines)) {
        for (const line of lines) {
            const fromLine = read(line?.metadata);
            if (fromLine) return fromLine;
        }
    }
    return null;
}

function stripTrailingSlash(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}
