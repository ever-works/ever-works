import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type ResolvedTwentyCrmConfig = {
    apiUrl?: string;
    apiKey?: string;
    workspaceId?: string;
    timeout: number;
    retryAttempts: number;
    retryDelay: number;
};

type TwentyCrmTenantOverride = {
    apiUrl?: string;
    apiKey?: string;
    workspaceId?: string;
};

@Injectable()
export class CrmConfigService {
    private readonly logger = new Logger(CrmConfigService.name);

    constructor(private configService: ConfigService) {}

    get twentyCrmConfig(): ResolvedTwentyCrmConfig {
        return {
            apiUrl: this.configService.get<string>('TWENTY_CRM_BASE_URL'),
            apiKey: this.configService.get<string>('TWENTY_CRM_API_KEY'),
            workspaceId: this.configService.get<string>('TWENTY_CRM_WORKSPACE_ID'),
            timeout: this.configService.get<number>('TWENTY_CRM_TIMEOUT_MS', 30000),
            retryAttempts: this.configService.get<number>('TWENTY_CRM_MAX_RETRIES', 3),
            retryDelay: this.configService.get<number>('TWENTY_CRM_RETRY_DELAY_MS', 1000),
        };
    }

    /**
     * Per-tenant Twenty workspace credentials. Isolation model (cross-tenant
     * IDOR fix — "one Twenty workspace + API key per tenant"): each tenant's
     * requests use that tenant's OWN workspace API key, which Twenty scopes to
     * a single workspace — so a caller can only ever read/write rows in their
     * own workspace. Parsed once from the optional `TWENTY_CRM_TENANTS` JSON
     * env var: `{ "<tenantId>": { "apiKey": "...", "workspaceId": "...",
     * "apiUrl"?: "..." } }`. Returns `{}` when unset (single-tenant / dev).
     */
    private get tenantOverrides(): Record<string, TwentyCrmTenantOverride> {
        const raw = this.configService.get<string>('TWENTY_CRM_TENANTS');
        if (!raw) return {};
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            this.logger.error(
                'TWENTY_CRM_TENANTS is not valid JSON — ignoring per-tenant CRM credentials',
            );
            return {};
        }
    }

    /**
     * Resolve the Twenty workspace credentials for a specific tenant.
     *
     * FAIL-CLOSED: a tenant-scoped call (non-empty `tenantId`) is served ONLY if
     * that tenant has its own entry — with an API key — in `TWENTY_CRM_TENANTS`.
     * Otherwise this returns `null` and the caller MUST refuse the request. We
     * deliberately do NOT fall back to the shared `TWENTY_CRM_API_KEY` for
     * tenant-scoped calls: doing so would route every unconfigured tenant into
     * the same default workspace, re-opening the cross-tenant IDOR this change
     * closes (a partially-populated map or a still-set legacy default would be
     * enough to leak). The API key — not the `apiUrl`/`workspaceId`, which may
     * inherit the shared base — is what actually grants workspace access, so it
     * must come from the per-tenant entry.
     *
     * Internal/system callers (sync, metadata) pass no `tenantId` and use the
     * default config (they are not per-caller and not tenant-scoped).
     */
    configForTenant(tenantId?: string): ResolvedTwentyCrmConfig | null {
        const base = this.twentyCrmConfig;
        if (!tenantId) return base;
        const override = this.tenantOverrides[tenantId];
        if (!override || !override.apiKey) return null;
        return {
            ...base,
            apiUrl: override.apiUrl ?? base.apiUrl,
            apiKey: override.apiKey,
            workspaceId: override.workspaceId ?? base.workspaceId,
        };
    }

    get isEnabled() {
        return !!(
            this.twentyCrmConfig.apiUrl &&
            this.twentyCrmConfig.apiKey &&
            this.twentyCrmConfig.workspaceId
        );
    }

    validateConfig() {
        const config = this.twentyCrmConfig;
        const missing = [];

        if (!config.apiUrl) missing.push('TWENTY_CRM_BASE_URL');
        if (!config.apiKey) missing.push('TWENTY_CRM_API_KEY');
        if (!config.workspaceId) missing.push('TWENTY_CRM_WORKSPACE_ID');

        if (missing.length > 0) {
            throw new Error(`Missing required Twenty CRM configuration: ${missing.join(', ')}`);
        }

        return true;
    }
}
