import {
    Injectable,
    Logger,
    BadRequestException,
    NotFoundException,
    ForbiddenException,
} from '@nestjs/common';
import { WebhookSubscriptionRepository } from '@ever-works/agent/database';
import type { WebhookSubscription } from '@ever-works/agent/entities';
// Security: reuse the canonical lexical SSRF guard shared with the delivery
// path (packages/agent/src/utils/ssrf-guard.ts) instead of a weaker inline
// hostname check. It strips IPv6 brackets, and covers IPv4-mapped IPv6,
// ULA (fc00::/7), link-local, CGNAT (100.64/10), 0.0.0.0/8 and cloud-metadata
// hosts — closing the [::1] / ::ffff:127.0.0.1 / IPv6-range bypasses.
import { isSafeWebhookUrl } from '@ever-works/agent/utils';
// Security (EW-711 #14): work-scoped subscriptions must be authorized against
// the caller's access to that Work — see the ownership gate in `create()`.
import { WorkOwnershipService } from '@ever-works/agent/services';
import { WebhookSecretService } from './webhook-secret.service';

export interface WebhookSubscriptionView {
    id: string;
    accountId: string;
    workId: string | null;
    url: string;
    status: 'active' | 'paused' | 'failed';
    consecutiveFailures: number;
    lastDeliveryAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

const MAX_PER_ACCOUNT = 25;

@Injectable()
export class WebhooksService {
    private readonly logger = new Logger(WebhooksService.name);

    constructor(
        private readonly repo: WebhookSubscriptionRepository,
        private readonly secrets: WebhookSecretService,
        private readonly workOwnership: WorkOwnershipService,
    ) {}

    async listForAccount(accountId: string): Promise<WebhookSubscriptionView[]> {
        const rows = await this.repo.listActiveForAccount(accountId);
        return rows.map((row) => this.toView(row));
    }

    /**
     * Create a subscription for the caller. Returns the canonical
     * view plus the RAW signing secret. The raw secret appears ONLY
     * in this response — it is never readable again. Callers that
     * lose it must rotate via `rotateSecret()`.
     *
     * Security gates:
     *  - URL must be http: or https: (no `file:`, no `javascript:`)
     *  - URL must not target a loopback / link-local / private range
     *    when running in production (SSRF defense)
     *  - At most MAX_PER_ACCOUNT (25) active subscriptions per user
     */
    async create(
        accountId: string,
        input: { url: string; workId?: string | null },
    ): Promise<{ subscription: WebhookSubscriptionView; signingSecret: string }> {
        this.assertValidUrl(input.url);

        // Security (EW-711 #14): a subscription bound to a Work receives that
        // Work's lifecycle events (names, deployment URLs, error details), so
        // the caller must be allowed to view the Work they bind to. Nothing
        // validated `input.workId` before — any authenticated user could
        // subscribe to a foreign workId and exfiltrate its event stream.
        // `ensureCanView` passes for the creator and any work member, so
        // legitimate callers keep working. A Forbidden (work exists, not
        // yours) is masked as 404 to match this service's enumeration
        // defense (see `findOwn`) — callers must not learn that a foreign
        // workId exists.
        if (input.workId) {
            try {
                await this.workOwnership.ensureCanView(input.workId, accountId);
            } catch (error) {
                if (error instanceof ForbiddenException) {
                    throw new NotFoundException(`Work with id '${input.workId}' not found`);
                }
                throw error;
            }
        }

        const existing = await this.repo.listActiveForAccount(accountId);
        if (existing.length >= MAX_PER_ACCOUNT) {
            throw new BadRequestException(
                `Account is already at the per-account limit of ${MAX_PER_ACCOUNT} active subscriptions`,
            );
        }

        const { raw, encrypted } = this.secrets.generateSecret();
        const row = await this.repo.createForAccount({
            accountId,
            workId: input.workId ?? null,
            url: input.url,
            secretEncrypted: encrypted,
        });

        return {
            subscription: this.toView(row),
            signingSecret: raw,
        };
    }

    async pause(accountId: string, id: string): Promise<WebhookSubscriptionView> {
        const row = await this.findOwn(accountId, id);
        await this.repo.pause(row.id);
        const updated = await this.repo.findById(row.id);
        return this.toView(updated ?? row);
    }

    async rotateSecret(
        accountId: string,
        id: string,
    ): Promise<{ subscription: WebhookSubscriptionView; signingSecret: string }> {
        const row = await this.findOwn(accountId, id);
        const { raw, encrypted } = this.secrets.generateSecret();
        await this.repo.updateSecret(row.id, encrypted);
        const updated = await this.repo.findById(row.id);
        return {
            subscription: this.toView(updated ?? row),
            signingSecret: raw,
        };
    }

    async remove(accountId: string, id: string): Promise<void> {
        const row = await this.findOwn(accountId, id);
        await this.repo.delete(row.id);
    }

    /**
     * Internal helper used by {@link import('./webhooks-deliveries.service.ts').WebhooksDeliveriesService}
     * and the test-fire endpoint. Returns the raw entity (NOT the view) so
     * the caller can decrypt the secret. Cross-account access is masked
     * as 404 — same enumeration-defense as `findOwn`.
     */
    async findOwnEntity(accountId: string, id: string): Promise<WebhookSubscription> {
        return this.findOwn(accountId, id);
    }

    private async findOwn(accountId: string, id: string): Promise<WebhookSubscription> {
        const row = await this.repo.findById(id);
        if (!row) {
            throw new NotFoundException('Webhook subscription not found');
        }
        if (row.accountId !== accountId) {
            // Don't 403 vs 404 — that leaks "subscription with this id
            // exists, but isn't yours". Pretend it doesn't exist.
            throw new NotFoundException('Webhook subscription not found');
        }
        return row;
    }

    private toView(row: WebhookSubscription): WebhookSubscriptionView {
        return {
            id: row.id,
            accountId: row.accountId,
            workId: row.workId,
            url: row.url,
            status: row.status,
            consecutiveFailures: row.consecutiveFailures,
            lastDeliveryAt: row.lastDeliveryAt,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }

    private assertValidUrl(url: string): void {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw new BadRequestException('url must be an absolute http(s) URL');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new BadRequestException(
                `url scheme ${parsed.protocol} is not allowed; use http(s)`,
            );
        }
        // SSRF defense — refuse local / private / link-local / metadata
        // targets. We intentionally allow them in local dev/test so a
        // developer can point at https://webhook.site or a local tunnel,
        // but staging shares network access to cloud metadata / internal
        // tooling, so the guard MUST run there too. Skip only in the
        // explicit local dev/test envs.
        // Security: gate now covers every non-local env (was production-only),
        // and uses isSafeWebhookUrl (handles bracketed IPv6, IPv4-mapped IPv6,
        // ULA/CGNAT/metadata) which `localhost` also fails since it is not a
        // literal IP — but we keep an explicit `localhost` reject for clarity.
        const env = process.env.NODE_ENV;
        const isLocalEnv =
            env === 'development' || env === 'test' || env === undefined || env === '';
        if (!isLocalEnv) {
            const lowerHost = parsed.hostname.toLowerCase();
            const bareHost =
                lowerHost.startsWith('[') && lowerHost.endsWith(']')
                    ? lowerHost.slice(1, -1)
                    : lowerHost;
            if (bareHost === 'localhost' || !isSafeWebhookUrl(url)) {
                throw new ForbiddenException(
                    `url ${parsed.hostname} resolves to a private / loopback / link-local address`,
                );
            }
            // HMAC-signed webhook payloads must not traverse plaintext http
            // in non-local envs (the signature/secret would be exposed on the
            // wire). Local dev/test still allows http above so tunnels work.
            // Checked after the SSRF guard so private/loopback hosts keep their
            // existing 403 surface regardless of scheme.
            if (parsed.protocol !== 'https:') {
                throw new BadRequestException(
                    'webhook url must use https in non-local environments',
                );
            }
        }
    }
}
