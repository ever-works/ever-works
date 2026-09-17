import { effectiveModelAccountHealth } from '@ever-works/contracts';
import type { ModelAccountView } from '@ever-works/contracts';
import type { ModelAccount } from '../entities/model-account.entity';

function iso(value: Date | null | undefined): string | null {
    return value ? new Date(value).toISOString() : null;
}

/**
 * Model accounts (AW-16) — the ONLY way an account leaves the server.
 *
 * Built field by field, never by spreading the entity, so a column added to
 * `model_accounts` later cannot reach a response by accident. There is no
 * credential field of any kind in the result — not the value, not a mask,
 * not a hash, not the credential version.
 */
export function toModelAccountView(
    account: ModelAccount,
    providerName: string,
    now: Date = new Date(),
): ModelAccountView {
    return {
        id: account.id,
        providerPluginId: account.providerPluginId,
        providerName,
        label: account.label,
        position: account.position,
        health: effectiveModelAccountHealth(
            {
                health: account.health,
                enabled: account.enabled,
                credentialExpiresAt: account.credentialExpiresAt ?? null,
            },
            now,
        ),
        enabled: account.enabled,
        credentialExpiresAt: iso(account.credentialExpiresAt),
        lastUsedAt: iso(account.lastUsedAt),
        lastCheckedAt: iso(account.lastCheckedAt),
        cooldownUntil: iso(account.cooldownUntil),
        createdAt: iso(account.createdAt) ?? new Date(0).toISOString(),
        updatedAt: iso(account.updatedAt) ?? new Date(0).toISOString(),
    };
}
