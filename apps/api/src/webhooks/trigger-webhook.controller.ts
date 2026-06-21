import {
    BadRequestException,
    Controller,
    Headers,
    HttpCode,
    HttpStatus,
    Inject,
    Logger,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Post,
    Req,
    UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac, timingSafeEqual } from 'crypto';
import { Repository } from 'typeorm';
import { TenantJobRuntimeConfig } from '@ever-works/agent/entities';
import { SECRET_STORE_RESOLVER, type SecretStoreResolver } from '@ever-works/agent/tasks';
import { Public } from '../auth/decorators/public.decorator';
import { TriggerWebhookEventRouterService } from './trigger-webhook-event-router.service';

/**
 * EW-743 — Trigger.dev webhook receiver.
 *
 * Inbound deliveries from a tenant's Trigger.dev project land at
 * `POST /api/webhooks/trigger/:tenantId`. The receiver:
 *
 *   1. Loads the tenant's `TenantJobRuntimeConfig` overlay row (EW-742
 *      P1) — 404 if no row exists.
 *   2. Resolves `credentialsSecretRef` via the bundled
 *      {@link SecretStoreResolver} and reads `credentials.webhookSecret`
 *      — 401 if the bag is missing the field (fail-closed; no
 *      auto-pass).
 *   3. HMAC-SHA256 verifies the raw request body against the per-tenant
 *      secret using `crypto.timingSafeEqual` on equal-length buffers
 *      so the compare doesn't short-circuit on partial matches.
 *   4. Parses the body as JSON for typed access AFTER signature check
 *      and logs `{ tenantId, eventId, eventType }`.
 *
 * Today's scope is receiver-only: a valid signature returns 200 and
 * logs. Downstream fan-out (turning Trigger.dev run-finished events
 * into platform events) is a follow-up PR — T25 in the EW-743 plan
 * is blocked on Trigger.dev's REST API not supporting programmatic
 * project creation, so operators will provision per-tenant projects
 * + populate `credentials.webhookSecret` manually for now.
 *
 * # Header convention
 *
 * `X-Trigger-Signature: sha256=<hex>` — chosen as a sensible default
 * matching the GitHub / Composio convention. Trigger.dev's actual
 * webhook signature header is not pinned in their public v4 docs
 * (https://trigger.dev/docs/v4-upgrade); once operators wire the
 * upstream signing config, this name may need to track whatever
 * Trigger.dev settles on. See TODO below.
 *
 * Replay protection (timestamp window) is deliberately OPTIONAL on
 * this PR — Trigger.dev's payload schema is not pinned either, so we
 * can't reliably read a `X-Trigger-Timestamp` header today. Leaving
 * the hook in place via a TODO so the operator runbook can switch it
 * on without a refactor.
 */
@ApiTags('Webhooks')
@Controller('api/webhooks/trigger')
export class TriggerWebhookController {
    private readonly logger = new Logger(TriggerWebhookController.name);

    // Per the class header — keep the constant addressable so a future
    // PR can flip the header name once the upstream contract pins.
    //
    // TODO(EW-743 follow-up): replace with Trigger.dev's documented
    // webhook signature header once they publish it. Mirror the
    // composio-triggers receiver's `webhook-signature` convention if
    // they adopt the Standard Webhooks spec.
    private static readonly SIGNATURE_HEADER = 'x-trigger-signature';
    private static readonly SIGNATURE_PREFIX = 'sha256=';

    constructor(
        @InjectRepository(TenantJobRuntimeConfig)
        private readonly tenantRuntimeRepo: Repository<TenantJobRuntimeConfig>,
        @Inject(SECRET_STORE_RESOLVER)
        private readonly secretStore: SecretStoreResolver,
        // EW-743 Phase 2 — fan out verified deliveries to platform
        // internal events via EventEmitter2. See router service for
        // mapping and failure semantics.
        private readonly eventRouter: TriggerWebhookEventRouterService,
    ) {}

    @Public()
    @Post(':tenantId')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Trigger.dev webhook receiver',
        description:
            'Receives signed webhook deliveries from a tenant-scoped Trigger.dev project. Verifies HMAC-SHA256 against the per-tenant secret stored under `TenantJobRuntimeConfig.credentials.webhookSecret`. Returns 200 on accept; 401 on bad / missing signature; 404 on unknown tenant; 400 on missing header / malformed body. Downstream event fan-out lands in a follow-up PR.',
    })
    @ApiParam({ name: 'tenantId', description: 'Tenant id (UUID)' })
    @ApiResponse({ status: 200, description: 'Accepted' })
    @ApiResponse({ status: 400, description: 'Missing signature header or malformed JSON body' })
    @ApiResponse({ status: 401, description: 'Invalid signature or no webhook secret configured' })
    @ApiResponse({ status: 404, description: 'Unknown tenant' })
    async receive(
        @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
        @Req() req: { rawBody?: string },
        @Headers() headers: Record<string, string>,
    ): Promise<{ ok: true }> {
        const signatureHeader = headers[TriggerWebhookController.SIGNATURE_HEADER];
        if (!signatureHeader || typeof signatureHeader !== 'string') {
            throw new BadRequestException(
                `Missing ${TriggerWebhookController.SIGNATURE_HEADER} header`,
            );
        }
        if (!req.rawBody) {
            throw new BadRequestException('Missing raw webhook payload');
        }

        // 404 BEFORE any other check so unknown-tenant probes don't get
        // a signature-malformed reply that would leak existence.
        const row = await this.tenantRuntimeRepo.findOne({ where: { tenantId } });
        if (!row) {
            throw new NotFoundException();
        }

        const webhookSecret = await this.loadWebhookSecret(row);
        if (!webhookSecret) {
            // Fail-closed: a tenant overlay row exists but the secret
            // bag has no `webhookSecret` field. Don't auto-pass — that
            // would let any caller deliver to a half-provisioned tenant.
            throw new UnauthorizedException();
        }

        if (!this.verifySignature(signatureHeader, req.rawBody, webhookSecret)) {
            throw new UnauthorizedException();
        }

        // Parse AFTER signature check — pre-parse would let an attacker
        // burn JSON.parse cycles on unauthenticated payloads.
        let payload: TriggerWebhookPayload;
        try {
            payload = JSON.parse(req.rawBody) as TriggerWebhookPayload;
        } catch {
            throw new BadRequestException('Webhook body is not valid JSON');
        }

        // TODO(EW-743 follow-up): once Trigger.dev's payload schema is
        // pinned, read `X-Trigger-Timestamp` and reject signatures more
        // than 5 minutes old (replay protection). Skipped today because
        // the upstream header name is not documented.

        this.logger.log(
            `Trigger.dev webhook received: tenantId=${tenantId} eventId=${
                payload?.id ?? '?'
            } eventType=${payload?.type ?? '?'}`,
        );

        // EW-743 Phase 2 — fan out to platform-internal events. The
        // router never throws (malformed / unmapped payloads are
        // logged + dropped), so the receiver still returns 200 — a
        // payload Trigger.dev cannot retry into success would
        // otherwise cause an infinite redelivery storm.
        this.eventRouter.route(tenantId, payload);

        return { ok: true };
    }

    /**
     * Constant-time HMAC compare. The supplied header is expected as
     * `sha256=<hex>`; we strip the scheme prefix, decode to a Buffer,
     * and compare against the freshly-computed HMAC. Length-mismatch
     * exits BEFORE `timingSafeEqual` because that function throws on
     * unequal buffer lengths (which is itself a side-channel signal,
     * but worse: it crashes the request). Returning `false` on length
     * mismatch is the documented Node.js pattern.
     */
    private verifySignature(headerValue: string, rawBody: string, secret: string): boolean {
        if (!headerValue.startsWith(TriggerWebhookController.SIGNATURE_PREFIX)) {
            return false;
        }
        const providedHex = headerValue.slice(TriggerWebhookController.SIGNATURE_PREFIX.length);
        if (!/^[0-9a-f]+$/i.test(providedHex)) {
            return false;
        }
        const expectedHex = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
        if (providedHex.length !== expectedHex.length) {
            return false;
        }
        const providedBuf = Buffer.from(providedHex, 'hex');
        const expectedBuf = Buffer.from(expectedHex, 'hex');
        // Both buffers are the same length by construction (hex → bytes
        // halves the length deterministically), but double-check before
        // the constant-time compare to satisfy the API contract.
        if (providedBuf.length !== expectedBuf.length) {
            return false;
        }
        return timingSafeEqual(providedBuf, expectedBuf);
    }

    /**
     * Resolve the tenant's `credentials.webhookSecret` via the bound
     * {@link SecretStoreResolver}. Returns `null` when:
     *   - the overlay row has no `credentialsSecretRef` (mode=inherit);
     *   - the resolver fails to decode the pointer (unknown scheme,
     *     bad payload, etc.) — the resolver contract returns `null`
     *     rather than throwing;
     *   - the resolved bag has no `webhookSecret` field or the field
     *     isn't a non-empty string.
     */
    private async loadWebhookSecret(row: TenantJobRuntimeConfig): Promise<string | null> {
        if (!row.credentialsSecretRef) {
            return null;
        }
        const bag = await this.secretStore.resolve(row.credentialsSecretRef);
        if (!bag) {
            return null;
        }
        const secret = bag['webhookSecret'];
        if (typeof secret !== 'string' || secret.length === 0) {
            return null;
        }
        return secret;
    }
}

/**
 * Minimal shape we need from a Trigger.dev webhook payload for logging.
 * Kept intentionally tiny — the official Trigger.dev event schema isn't
 * pinned in their public v4 docs, so we treat the body as opaque
 * beyond the two fields we surface in logs.
 */
interface TriggerWebhookPayload {
    id?: string;
    type?: string;
    [key: string]: unknown;
}
