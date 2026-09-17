import { Injectable, Logger, Optional } from '@nestjs/common';
import { isFleetModelPluginId } from '@ever-works/contracts';
import type { ResolvedSettings } from '@ever-works/plugin';
import { UsagePayer } from '@src/entities/_types';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { usagePayerFromSettingSource } from './usage-meter-classifier';

/**
 * AW-17 — resolves who paid the provider for a call, at the moment the usage
 * row is written. A port so the resolution can be replaced (a deployment
 * whose credentials live elsewhere binds its own) and so the write path can
 * be tested without the settings graph.
 */
export const USAGE_PAYER_RESOLVER = 'USAGE_PAYER_RESOLVER' as const;

export interface UsagePayerLookup {
    pluginId: string;
    userId: string;
    workId?: string | null;
}

export interface UsagePayerResolver {
    /** Never rejects; an unresolvable payer is `unconfirmed`. */
    resolve(lookup: UsagePayerLookup): Promise<UsagePayer>;
}

/** Setting keys that carry a credential, most specific first. */
const CREDENTIAL_KEY_PATTERN = /(api[-_]?key|access[-_]?key|secret|token)$/i;

/**
 * Who paid, from the resolved settings of the Plugin that served the call.
 *
 * `apiKey` decides when present — the same provenance the run settlement has
 * always read. A Plugin with no `apiKey` setting is decided by the first
 * other credential-shaped setting that holds a value (`accessKey`, `token`,
 * …). A Plugin with no credential at all ran on the platform's own
 * configuration.
 */
export function payerFromResolvedSettings(
    resolved: ResolvedSettings | null | undefined,
): UsagePayer {
    if (!resolved || typeof resolved !== 'object') {
        return UsagePayer.UNCONFIRMED;
    }
    const apiKey = resolved['apiKey'];
    if (apiKey) {
        return usagePayerFromSettingSource(apiKey.source);
    }
    const credential = Object.values(resolved).find(
        (setting) =>
            !!setting &&
            CREDENTIAL_KEY_PATTERN.test(setting.key ?? '') &&
            setting.value !== undefined &&
            setting.value !== null &&
            setting.value !== '',
    );
    if (credential) {
        return usagePayerFromSettingSource(credential.source);
    }
    return UsagePayer.PLATFORM;
}

/**
 * The default resolver: reads `PluginSettingsService.getResolvedSettings`
 * (the Work > User > Admin > Env > Default hierarchy the facade itself used
 * to configure the call).
 *
 * A short per-(plugin, user, work) memo keeps a run's burst of calls from
 * repeating the same settings read for every one of them. Only confirmed
 * answers are memoised; a failure is retried on the next call. The memo
 * window is deliberately short: a credential changed mid-window classifies
 * with the previous provenance for at most {@link MEMO_TTL_MS}.
 */
@Injectable()
export class SettingsUsagePayerResolver implements UsagePayerResolver {
    private readonly logger = new Logger(SettingsUsagePayerResolver.name);
    private readonly memo = new Map<string, { payer: UsagePayer; expiresAt: number }>();

    static readonly MEMO_TTL_MS = 60_000;
    static readonly MEMO_MAX_ENTRIES = 500;

    constructor(@Optional() private readonly settingsService?: PluginSettingsService) {}

    async resolve(lookup: UsagePayerLookup): Promise<UsagePayer> {
        if (isFleetModelPluginId(lookup.pluginId)) {
            return UsagePayer.WORKSPACE;
        }
        if (!this.settingsService || !lookup.pluginId || !lookup.userId) {
            return UsagePayer.UNCONFIRMED;
        }

        const key = `${lookup.pluginId}\0${lookup.userId}\0${lookup.workId ?? ''}`;
        const cached = this.memo.get(key);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.payer;
        }

        try {
            const resolved = await this.settingsService.getResolvedSettings(lookup.pluginId, {
                userId: lookup.userId,
                workId: lookup.workId ?? undefined,
                includeSecrets: true,
            });
            const payer = payerFromResolvedSettings(resolved);
            if (payer !== UsagePayer.UNCONFIRMED) {
                this.remember(key, payer);
            }
            return payer;
        } catch (error) {
            this.logger.debug(
                `Payer unresolved for plugin ${lookup.pluginId} (classified unconfirmed): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return UsagePayer.UNCONFIRMED;
        }
    }

    private remember(key: string, payer: UsagePayer): void {
        if (this.memo.size >= SettingsUsagePayerResolver.MEMO_MAX_ENTRIES) {
            // Oldest insertion first — Map iteration order is insertion order.
            const oldest = this.memo.keys().next().value;
            if (oldest !== undefined) {
                this.memo.delete(oldest);
            }
        }
        this.memo.set(key, {
            payer,
            expiresAt: Date.now() + SettingsUsagePayerResolver.MEMO_TTL_MS,
        });
    }
}
