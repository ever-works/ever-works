import {
    Injectable,
    Logger,
    BadGatewayException,
    BadRequestException,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import { Composio } from '@composio/core';
import { PluginSettingsService } from '@ever-works/agent/plugins';
// Security: lexical SSRF guard (private/loopback/link-local/IPv4-mapped-IPv6 +
// cloud-metadata hosts, http(s)-only) reused from the canonical helper so a
// user-controlled `baseUrl` cannot point the Composio SDK at internal targets.
import { isSafeWebhookUrl } from '@ever-works/agent/utils';
import type {
    ComposioToolkitDto,
    ComposioConnectedAccountDto,
    InitiateConnectionRequestDto,
    InitiateConnectionResponseDto,
} from './dto/composio.dto';

const COMPOSIO_PLUGIN_ID = 'composio';

/**
 * Minimal subset of the official `@composio/core` SDK we use. Mirrors the
 * shape declared in `packages/plugins/composio/src/utils/composio-client.ts`
 * so the same mock pattern works in tests across both modules.
 */
export interface ComposioSdkLike {
    toolkits: {
        get(query?: { limit?: number }): Promise<{ items: ComposioToolkitDto[] }>;
    };
    connectedAccounts: {
        list(query?: { userIds?: string[]; toolkitSlugs?: string[]; limit?: number }): Promise<{
            items: Array<{
                id: string;
                status: string;
                toolkit?: { slug?: string };
                user_id?: string;
                userId?: string;
            }>;
        }>;
        initiate(
            userId: string,
            authConfigId: string,
            options?: { callbackUrl?: string },
        ): Promise<{
            id?: string;
            connectionRequest?: { redirectUrl?: string };
            redirectUrl?: string;
        }>;
    };
    triggers: {
        create(
            userId: string,
            slug: string,
            body?: { triggerConfig?: Record<string, unknown>; connectedAccountId?: string },
        ): Promise<{ triggerId: string }>;
        delete(triggerId: string): Promise<{ triggerId: string }>;
        verifyWebhook(params: {
            id: string;
            payload: string;
            signature: string;
            timestamp: string;
            secret: string;
        }): Promise<{ version: string; payload: unknown; rawPayload: string }>;
    };
}

/**
 * Backend service that fronts Composio's catalog + Connected-Accounts APIs
 * for the Ever Works web UI (PR-B of EW-684).
 *
 * Responsibility split:
 *  - The Composio **plugin** (packages/plugins/composio) drives Composio
 *    during pipeline execution — its handle on the SDK is per-pipeline-run
 *    and uses the plugin's resolved settings.
 *  - This API service drives Composio during **settings UX** — listing
 *    toolkits, listing the caller's connected accounts, and initiating new
 *    OAuth connections from the settings page. The two are intentionally
 *    not shared: the plugin code runs in worker contexts where the NestJS
 *    DI tree isn't available, and this controller needs request-scoped
 *    SDK clients built from each caller's stored API key.
 */
@Injectable()
export class ComposioService {
    private readonly logger = new Logger(ComposioService.name);

    constructor(private readonly settingsService: PluginSettingsService) {}

    /**
     * Builds a per-request `Composio` SDK client from the caller's stored
     * `composio` plugin settings. Throws if the plugin is not enabled or
     * the user hasn't set an API key. Tests stub via `jest.spyOn(svc, 'getSdk')`.
     */
    private async getSdk(userId: string): Promise<ComposioSdkLike> {
        const resolved = await this.settingsService
            .getResolvedSettings(COMPOSIO_PLUGIN_ID, { userId, includeSecrets: true })
            .catch(() => null);
        const settings = (resolved?.settings ?? null) as Record<string, unknown> | null;
        const apiKey = readString(settings, 'apiKey');
        if (!apiKey) {
            throw new BadRequestException(
                `The Composio plugin is not configured. Set your Composio API key under Settings → Plugins → Composio.`,
            );
        }
        const baseUrl = readString(settings, 'baseUrl') || undefined;
        // Security (SSRF): `baseUrl` is a user-scoped setting, so an attacker
        // could set it to `http://169.254.169.254/...` or an internal host and
        // have the SDK issue requests there (with responses surfacing in error
        // messages). Reject non-http(s) / private / loopback / link-local /
        // cloud-metadata targets via the canonical lexical guard. Local dev/test
        // is exempted (same carve-out as webhooks.service) so an operator can
        // point at a Composio mock on localhost; staging/prod always enforce it.
        if (baseUrl) {
            const env = process.env.NODE_ENV;
            const isLocalEnv =
                env === 'development' || env === 'test' || env === undefined || env === '';
            if (!isLocalEnv && !isSafeWebhookUrl(baseUrl)) {
                throw new BadRequestException(
                    'The Composio API base URL is invalid. Use an absolute https URL to a public Composio endpoint.',
                );
            }
        }
        return new Composio({
            apiKey,
            ...(baseUrl ? { baseURL: baseUrl } : {}),
        }) as unknown as ComposioSdkLike;
    }

    /**
     * Lists the Composio toolkit catalog the caller's API key has access to.
     * Used to populate the Connect dropdown / search in the settings UI.
     */
    async listToolkits(userId: string, limit = 100): Promise<ComposioToolkitDto[]> {
        const sdk = await this.getSdk(userId);
        try {
            const response = await sdk.toolkits.get({ limit: Math.max(1, Math.min(limit, 200)) });
            return response.items ?? [];
        } catch (error) {
            throw this.wrapComposioError(error, 'list toolkits');
        }
    }

    /**
     * Lists the caller's connected accounts on Composio. Optionally filtered
     * by toolkit slug to show "is GMAIL connected?" for a single chip.
     *
     * The Composio user_id filter is hard-pinned to the JWT user id so a
     * shared workspace API key cannot be used to enumerate another user's
     * connected accounts.
     */
    async listConnectedAccounts(
        userId: string,
        options: { toolkitSlug?: string } = {},
    ): Promise<ComposioConnectedAccountDto[]> {
        const sdk = await this.getSdk(userId);
        try {
            const query: { userIds: string[]; toolkitSlugs?: string[] } = {
                userIds: [userId],
            };
            if (options.toolkitSlug) query.toolkitSlugs = [options.toolkitSlug.toUpperCase()];
            const response = await sdk.connectedAccounts.list(query);
            return (response.items ?? []).map((raw) => ({
                id: raw.id,
                status: raw.status,
                toolkitSlug: raw.toolkit?.slug,
                userId: raw.userId ?? raw.user_id,
            }));
        } catch (error) {
            throw this.wrapComposioError(error, 'list connected accounts');
        }
    }

    /**
     * Initiates an OAuth connection for the caller against a toolkit. Returns
     * the redirect URL the frontend should open in a popup. The user completes
     * the OAuth dance on Composio, which redirects to `callbackUrl` (defaults
     * to the platform's settings page) when done; the frontend then polls
     * `listConnectedAccounts` until the new account is ACTIVE.
     *
     * `authConfigId` is the Composio auth-config nanoid (e.g. `ac_*`). Each
     * toolkit has a default auth config registered when the Composio
     * organization is set up; for custom OAuth credentials the operator
     * creates a separate auth config via Composio dashboard and passes the
     * id here.
     */
    async initiateConnection(
        userId: string,
        body: InitiateConnectionRequestDto,
    ): Promise<InitiateConnectionResponseDto> {
        if (!body.toolkitSlug) {
            throw new BadRequestException('toolkitSlug is required');
        }
        if (!body.authConfigId) {
            throw new BadRequestException(
                'authConfigId is required. Create an auth config for this toolkit in the Composio dashboard or via the auth-configs API and pass its id here.',
            );
        }
        const sdk = await this.getSdk(userId);
        try {
            const result = await sdk.connectedAccounts.initiate(userId, body.authConfigId, {
                ...(body.callbackUrl ? { callbackUrl: body.callbackUrl } : {}),
            });
            const redirectUrl = result.connectionRequest?.redirectUrl ?? result.redirectUrl;
            if (!redirectUrl) {
                throw new Error('Composio did not return a redirect URL for the new connection.');
            }
            return {
                redirectUrl,
                ...(result.id ? { connectedAccountId: result.id } : {}),
            };
        } catch (error) {
            throw this.wrapComposioError(error, `initiate connection to ${body.toolkitSlug}`);
        }
    }

    /**
     * Enable a trigger upstream on Composio for the caller and return the
     * Composio-assigned `tg_*` id. When `connectedAccountId` is omitted,
     * Composio uses the user's first connected account for the toolkit.
     */
    async createTrigger(
        userId: string,
        params: {
            triggerSlug: string;
            connectedAccountId?: string;
            config?: Record<string, unknown>;
        },
    ): Promise<{ triggerId: string }> {
        const sdk = await this.getSdk(userId);
        try {
            const body: { triggerConfig?: Record<string, unknown>; connectedAccountId?: string } =
                {};
            if (params.config) body.triggerConfig = params.config;
            if (params.connectedAccountId) body.connectedAccountId = params.connectedAccountId;
            const result = await sdk.triggers.create(userId, params.triggerSlug, body);
            if (!result?.triggerId) {
                throw new Error('Composio did not return a trigger id for the new trigger.');
            }
            return { triggerId: result.triggerId };
        } catch (error) {
            throw this.wrapComposioError(error, `enable trigger ${params.triggerSlug}`);
        }
    }

    /**
     * Disable/remove a trigger upstream on Composio. Best-effort — callers
     * still remove the local row even when the upstream delete fails (the
     * trigger may already be gone). Returns whether the upstream call
     * succeeded so the caller can log.
     */
    async deleteTrigger(userId: string, composioTriggerId: string): Promise<boolean> {
        try {
            const sdk = await this.getSdk(userId);
            await sdk.triggers.delete(composioTriggerId);
            return true;
        } catch (error) {
            this.logger.warn(
                `Composio upstream trigger delete failed for ${composioTriggerId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return false;
        }
    }

    /**
     * Resolve the caller's project-level Composio webhook secret
     * (`COMPOSIO_WEBHOOK_SECRET`, set under Composio dashboard → Project
     * Settings → Webhook, mirrored into the plugin's `webhookSecret`
     * setting). Returns undefined when not configured.
     */
    async getWebhookSecret(userId: string): Promise<string | undefined> {
        const resolved = await this.settingsService
            .getResolvedSettings(COMPOSIO_PLUGIN_ID, { userId, includeSecrets: true })
            .catch(() => null);
        const settings = (resolved?.settings ?? null) as Record<string, unknown> | null;
        const fromSettings = readString(settings, 'webhookSecret');
        if (fromSettings) return fromSettings;
        const fromEnv = process.env.COMPOSIO_WEBHOOK_SECRET;
        return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
    }

    /**
     * Verify a Composio webhook delivery for `userId` using the official
     * SDK verifier (HMAC-SHA256 of `{webhook-id}.{webhook-timestamp}.{body}`
     * against the project webhook secret, base64 `v1,<sig>` form). Throws
     * `UnauthorizedException` when the secret isn't configured or the
     * signature/timestamp is invalid. Returns the parsed payload + version.
     */
    async verifyWebhook(
        userId: string,
        delivery: { id: string; rawBody: string; signature: string; timestamp: string },
    ): Promise<{ version: string; payload: unknown }> {
        const secret = await this.getWebhookSecret(userId);
        if (!secret) {
            // Fail CLOSED: a delivery for a known trigger with no secret
            // configured cannot be trusted — never accept-all.
            throw new UnauthorizedException(
                'Composio webhook secret is not configured. Set it under Settings → Plugins → Composio (from Composio dashboard → Project Settings → Webhook).',
            );
        }
        const sdk = await this.getSdk(userId);
        try {
            const result = await sdk.triggers.verifyWebhook({
                id: delivery.id,
                payload: delivery.rawBody,
                signature: delivery.signature,
                timestamp: delivery.timestamp,
                secret,
            });
            return { version: result.version, payload: result.payload };
        } catch (error) {
            throw new UnauthorizedException(
                `Composio webhook signature verification failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * Translates SDK-thrown errors into NestJS HTTP exceptions so the
     * controller can pass them through verbatim. Mirrors the friendly
     * messages in the plugin's `ComposioClient.wrapError` — keep them in
     * sync; CodeRabbit / Greptile have flagged divergence in the past.
     */
    private wrapComposioError(error: unknown, context: string): Error {
        // Security: `context` embeds user-supplied values (e.g. toolkitSlug /
        // triggerSlug). Sanitize before reflecting it into any client-visible
        // message so a hostile slug cannot inject control characters or pad the
        // response with an unbounded string.
        const safeContext = sanitizeContext(context);
        if (!(error instanceof Error))
            return new Error(`Unexpected error during ${safeContext}.`);
        const status = readNumberProp(error, 'status') ?? readNumberProp(error, 'statusCode');
        const message = error.message || String(error);
        if (status === 401 || status === 403) {
            return new UnauthorizedException(
                `Composio rejected the API key (HTTP ${status}) during ${safeContext}. Verify it under Settings → Plugins → Composio.`,
            );
        }
        if (status === 404) {
            return new NotFoundException(
                `Composio returned 404 during ${safeContext}. Likely causes: the toolkit / tool slug does not exist, or the user has no connected account.`,
            );
        }
        if (status === 429) {
            return new BadRequestException('Composio rate limit exceeded. Wait and retry.');
        }
        if (status !== undefined && status >= 500) {
            // Security: log the raw upstream message server-side but do NOT echo
            // it to the caller — SDK/HTTP-client 5xx messages can carry internal
            // hostnames, URLs with tokens, or stack traces.
            this.logger.warn(`Composio SDK ${status} during ${safeContext}: ${message}`);
            return new BadGatewayException(
                `Composio is returning HTTP ${status} during ${safeContext}. Check https://status.composio.dev.`,
            );
        }
        // Security: the raw SDK message is logged for operators but kept out of
        // the client response to avoid leaking upstream/internal error detail.
        this.logger.warn(`Composio SDK error during ${safeContext}: ${message}`);
        return new BadRequestException(
            `Composio integration error during ${safeContext}. See server logs for details.`,
        );
    }
}

function readString(source: Record<string, unknown> | null, key: string): string | undefined {
    if (!source) return undefined;
    const value = source[key];
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}

function readNumberProp(target: object, prop: string): number | undefined {
    const value = (target as Record<string, unknown>)[prop];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Security: the error `context` string embeds user-supplied slugs. Replace
 * control characters and cap the length before it is reflected into any
 * client-visible HTTP exception message.
 */
function sanitizeContext(context: string): string {
    // Replace C0 control chars (code < 0x20) and DEL (0x7f) with spaces so an
    // injected CR/LF in a slug cannot break the reflected message onto a new
    // line, then bound the length. Done by char code to avoid embedding raw
    // control characters in a regex literal.
    const cleaned = Array.from(context, (ch) => {
        const code = ch.charCodeAt(0);
        return code < 0x20 || code === 0x7f ? ' ' : ch;
    }).join('');
    return cleaned.length > 80 ? `${cleaned.slice(0, 80)}…` : cleaned;
}
