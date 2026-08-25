import { Injectable, Logger } from '@nestjs/common';
import { createHash, createHmac } from 'crypto';
import { WorkRepository } from '@ever-works/agent/database';
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
 */

/** Bound on how long we wait for a directory before telling Stripe to retry. */
const FORWARD_TIMEOUT_MS = 10_000;

export type StripeRelayOutcome =
    /** Delivered to the owning directory. Answer Stripe 200. */
    | { status: 'forwarded'; eventId: string; workId: string; siteStatus: number }
    /**
     * Verified, but we can never route it (no `work_id`, unknown Work, Work has
     * no deployed site, or the site rejected it as belonging to someone else).
     * Answer Stripe 200 — a retry would deliver the same unroutable event.
     */
    | { status: 'unroutable'; eventId: string; reason: string }
    /**
     * Transient: the directory is down, timed out, or rejected our signature.
     * Answer Stripe 5xx so Stripe RETRIES (it does so for up to 3 days, which
     * covers a site outage or a secret re-sync).
     */
    | { status: 'retry'; eventId: string; reason: string };

export class StripeRelayNotConfiguredError extends Error {}
export class StripeRelaySignatureError extends Error {}

@Injectable()
export class StripeRelayService {
    private readonly logger = new Logger(StripeRelayService.name);

    constructor(
        private readonly workRepository: WorkRepository,
        private readonly secretService: PlatformSyncSecretService,
    ) {}

    /** Off by default — the relay ships dark and is switched on per environment. */
    isEnabled(): boolean {
        return process.env.STRIPE_RELAY_ENABLED === 'true';
    }

    /**
     * Verify Stripe's signature, resolve the owning directory, and forward.
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

        let event: { id: string; type: string; data?: { object?: unknown } };
        try {
            event = constructStripeEvent(rawBody, signature, webhookSecret);
        } catch {
            // The SDK message can quote header content — never echo it.
            throw new StripeRelaySignatureError('Webhook signature verification failed');
        }

        const workId = extractWorkId(event);
        if (!workId) {
            // Not an error: platform-owned events (and Stripe's own test pings)
            // legitimately carry no directory routing key.
            this.logger.warn(`relay: event ${event.id} (${event.type}) carries no work_id`);
            return { status: 'unroutable', eventId: event.id, reason: 'no_work_id' };
        }

        const work = await this.workRepository.findById(workId);
        if (!work) {
            this.logger.warn(`relay: event ${event.id} names unknown work ${workId}`);
            return { status: 'unroutable', eventId: event.id, reason: 'unknown_work' };
        }
        if (!work.website) {
            this.logger.warn(`relay: work ${workId} has no deployed website`);
            return { status: 'unroutable', eventId: event.id, reason: 'not_deployed' };
        }

        let secret: string | null;
        try {
            secret = this.secretService.decryptForWork(work);
        } catch (err) {
            this.logger.warn(
                `relay: decryptForWork failed for work ${workId}: ${(err as Error).message}`,
            );
            return { status: 'unroutable', eventId: event.id, reason: 'secret_undecryptable' };
        }
        if (!secret) {
            // The site was never provisioned with PLATFORM_SYNC_SECRET, so it
            // would answer 503. Retrying cannot fix that without a redeploy.
            return { status: 'unroutable', eventId: event.id, reason: 'not_provisioned' };
        }

        return this.forward(work.id, work.website, secret, rawBody, event.id);
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
    ): Promise<StripeRelayOutcome> {
        const url = `${stripTrailingSlash(website)}/api/stripe/platform-webhook`;

        // Security (SSRF + signed-bearer leak) — identical reasoning to
        // DirectoryWebsiteClient: `work.website` is attacker-influenceable (a
        // tenant's verified custom domain is promoted into it), and the request
        // below carries an HMAC Bearer header bound to the per-Work secret. Refuse
        // BEFORE signing so the secret never leaves the process for an unsafe
        // target. Local dev/test may legitimately point a Work at http://localhost.
        const env = process.env.NODE_ENV;
        const isLocalEnv =
            env === 'development' || env === 'test' || env === undefined || env === '';
        if (!isLocalEnv && !isSafeWebhookUrl(url)) {
            this.logger.warn(
                `relay: forward blocked by SSRF guard for work ${workId} (host resolves to a private / loopback / link-local / metadata target)`,
            );
            return { status: 'unroutable', eventId, reason: 'ssrf_blocked' };
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
            return { status: 'retry', eventId, reason: 'network' };
        }

        if (response.status === 409) {
            // The directory says this event's work_id names a DIFFERENT
            // directory. That is a routing bug on our side; retrying repeats it.
            this.logger.error(
                `relay: work ${workId} rejected event ${eventId} as belonging to another directory`,
            );
            return { status: 'unroutable', eventId, reason: 'work_mismatch' };
        }
        if (response.status === 503) {
            // Site is up but platform sync was never injected — needs a redeploy.
            return { status: 'unroutable', eventId, reason: 'site_not_provisioned' };
        }
        if (response.status === 401) {
            // Stale/rotated secret. Retry: a re-sync may fix it within Stripe's
            // retry window, and silently dropping a paid event is worse.
            this.logger.error(`relay: work ${workId} rejected our signature for event ${eventId}`);
            return { status: 'retry', eventId, reason: 'unauthorized' };
        }
        if (response.status >= 500) {
            return { status: 'retry', eventId, reason: `site_${response.status}` };
        }
        if (response.status >= 400) {
            // A malformed body is not fixable by retrying.
            return { status: 'unroutable', eventId, reason: `site_${response.status}` };
        }

        this.logger.log(`relay: event ${eventId} -> work ${workId} (site ${response.status})`);
        return { status: 'forwarded', eventId, workId, siteStatus: response.status };
    }
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

    // invoice.* — `subscription_details.metadata` carries the subscription's
    // metadata, and line items carry their own copy.
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
