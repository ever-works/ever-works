import { Injectable, Logger, Optional } from '@nestjs/common';
import { MODEL_ROUTING_LIMITS, effectiveModelAccountHealth } from '@ever-works/contracts';
import type { ModelAccountHealth } from '@ever-works/contracts';
import type { PluginSettings } from '@ever-works/plugin';
import { ModelAccountRepository } from '../database/repositories/model-account.repository';
import type { ModelAccount } from '../entities/model-account.entity';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import {
    ModelProviderCatalogService,
    type ModelProviderDescriptor,
} from './model-provider-catalog.service';
import { isCredentialRejection } from './model-routing.signals';

/** The answer to "does this credential work with this provider right now?". */
export interface ModelCredentialCheck {
    ok: boolean;
    /** True only when the provider refused the credential (as opposed to the check not running). */
    rejected: boolean;
    expiresAt: Date | null;
}

export interface ModelAccountHealthSweep {
    scanned: number;
    checked: number;
    health: Partial<Record<ModelAccountHealth, number>>;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Model accounts (AW-16) — whether an account's credential works.
 *
 * One path answers it, before a credential is saved and on the periodic
 * check: the provider plugin's own `checkCredential` when it declares one,
 * otherwise its `isAvailable` (the same connection test the plugin settings
 * page runs).
 *
 * The distinction that matters: a check that could not run leaves an account
 * `unknown`; only a provider REJECTION marks it `invalid`. A check never
 * changes an account's position, never fails a Run and never blocks a page.
 */
@Injectable()
export class ModelAccountHealthService {
    private readonly logger = new Logger(ModelAccountHealthService.name);

    constructor(
        private readonly accounts: ModelAccountRepository,
        private readonly providers: ModelProviderCatalogService,
        @Optional() private readonly settingsService?: PluginSettingsService,
    ) {}

    /**
     * Check candidate credentials without saving anything. `userId` scopes
     * the non-secret provider settings (e.g. an operator-configured endpoint)
     * the check runs against; every secret field is taken from `credentials`
     * alone, so a key configured elsewhere can never make a bad one pass.
     */
    async checkCredentials(
        provider: ModelProviderDescriptor,
        credentials: Record<string, string>,
        userId: string,
    ): Promise<ModelCredentialCheck> {
        const settings = await this.settingsFor(provider, credentials, userId);
        try {
            if (typeof provider.plugin.checkCredential === 'function') {
                const result = await provider.plugin.checkCredential(settings);
                return {
                    ok: !!result.ok,
                    rejected: !result.ok && result.rejected !== false,
                    expiresAt: result.expiresAt ?? null,
                };
            }
            const available = await provider.plugin.isAvailable(settings);
            return { ok: available, rejected: !available, expiresAt: null };
        } catch (error) {
            return { ok: false, rejected: isCredentialRejection(error), expiresAt: null };
        }
    }

    /** Check one stored account now and write the outcome. */
    async probe(account: ModelAccount, now: Date = new Date()): Promise<ModelAccountHealth> {
        const provider = await this.providers.getProvider(account.providerPluginId);
        if (!provider || !account.credentials) {
            await this.accounts.updateHealth(account.id, { health: 'unknown', lastCheckedAt: now });
            return 'unknown';
        }
        let check: ModelCredentialCheck;
        try {
            check = await this.checkCredentials(provider, account.credentials, account.userId);
        } catch (error) {
            this.logger.warn(
                `Health check for model account ${account.id} could not run: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            check = { ok: false, rejected: false, expiresAt: null };
        }
        // A check that could not run proves nothing either way: it leaves a
        // known rejection standing and otherwise reads as unknown.
        const stored: ModelAccountHealth = check.ok
            ? 'working'
            : check.rejected || account.health === 'invalid'
              ? 'invalid'
              : 'unknown';
        const expiresAt = check.expiresAt ?? account.credentialExpiresAt ?? null;
        const health = effectiveModelAccountHealth(
            { health: stored, enabled: true, credentialExpiresAt: expiresAt },
            now,
        );
        await this.accounts.updateHealth(account.id, {
            health,
            lastCheckedAt: now,
            credentialExpiresAt: expiresAt,
        });
        return health;
    }

    /**
     * The periodic check: every enabled account not checked for six hours.
     * Each account is claimed atomically before it is probed, so overlapping
     * ticks cannot double-check, and one failure never stops the sweep.
     */
    async probeDueAccounts(
        options: { limit?: number; now?: Date } = {},
    ): Promise<ModelAccountHealthSweep> {
        const now = options.now ?? new Date();
        const cutoff = new Date(now.getTime() - MODEL_ROUTING_LIMITS.probeIntervalHours * HOUR_MS);
        const due = await this.accounts.listDueForCheck(cutoff, options.limit ?? 200);
        const sweep: ModelAccountHealthSweep = { scanned: due.length, checked: 0, health: {} };
        for (const account of due) {
            try {
                if (!(await this.accounts.claimForCheck(account.id, now, cutoff))) continue;
                const health = await this.probe(account, now);
                sweep.checked += 1;
                sweep.health[health] = (sweep.health[health] ?? 0) + 1;
            } catch (error) {
                this.logger.warn(
                    `Health sweep skipped model account ${account.id}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
        return sweep;
    }

    /**
     * A live call saw the provider refuse this account's credential: mark it
     * `invalid` immediately rather than waiting for the next check.
     */
    async applyLiveRejection(accountId: string, now: Date = new Date()): Promise<void> {
        await this.accounts.updateHealth(accountId, { health: 'invalid', lastCheckedAt: now });
    }

    private async settingsFor(
        provider: ModelProviderDescriptor,
        credentials: Record<string, string>,
        userId: string,
    ): Promise<PluginSettings> {
        let base: PluginSettings = {};
        if (this.settingsService) {
            try {
                base = await this.settingsService.getSettings(provider.providerPluginId, {
                    userId,
                    includeSecrets: false,
                });
            } catch {
                base = {};
            }
        }
        const settings: Record<string, unknown> = { ...base };
        for (const field of provider.credentialFields) {
            settings[field.key] = credentials[field.key];
        }
        return settings;
    }
}
