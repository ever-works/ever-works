import { Injectable, Logger } from '@nestjs/common';
import { isCredentialKey } from '@ever-works/contracts';

/**
 * `{{cred.key}}` resolution (audit item G14) — the PORT.
 *
 * Where a credential actually LIVES is deployment-specific (operator env,
 * the tenant secret store, a plugin's `x-secret` setting). The tool loop
 * must not care, so it consumes this narrow interface and the runtime
 * binds whichever implementation it has.
 *
 * The contract is deliberately batch-shaped (`resolve(ctx, keys)`) rather
 * than one-key-at-a-time: a store-backed implementation gets to make one
 * round trip per tool call instead of N, and the loop never has a reason
 * to hold a credential longer than the single call it was resolved for.
 */

export interface CredentialContext {
    /** Owner whose credentials may be read. Never optional. */
    userId: string;
    agentId?: string | null;
    workId?: string | null;
    organizationId?: string | null;
    tenantId?: string | null;
}

export interface CredentialResolver {
    /**
     * Resolve the given keys for this context. MUST omit keys it cannot
     * supply rather than returning an empty string — the caller
     * distinguishes "missing" from "empty" and fails the call on missing.
     *
     * MUST NOT log the values it returns.
     */
    resolve(ctx: CredentialContext, keys: readonly string[]): Promise<Map<string, string>>;
}

export const CREDENTIAL_RESOLVER = 'CREDENTIAL_RESOLVER' as const;

/**
 * Default, self-hosting-friendly implementation: operator environment.
 *
 * `{{cred.stripe_key}}` reads `EVERWORKS_CRED_STRIPE_KEY`. The prefix is
 * mandatory and non-negotiable — without it a tool argument could name
 * `DATABASE_URL`, `PLATFORM_ENCRYPTION_KEY` or `AWS_SECRET_ACCESS_KEY`
 * and the tool loop would happily hand the model's outbound call the
 * platform's own crown jewels. With it, only variables an operator
 * DELIBERATELY published under that namespace are reachable.
 *
 * This resolver is tenant-blind (env is process-wide), which is correct
 * for single-tenant / self-hosted installs and explicitly NOT correct for
 * multi-tenant SaaS — that deployment binds a store-backed resolver
 * instead. Named in the class so nobody has to guess.
 */
export const ENV_CREDENTIAL_PREFIX = 'EVERWORKS_CRED_';

export function envVarNameForCredential(key: string): string {
    return `${ENV_CREDENTIAL_PREFIX}${key.replace(/[.-]/g, '_').toUpperCase()}`;
}

@Injectable()
export class EnvCredentialResolver implements CredentialResolver {
    private readonly logger = new Logger(EnvCredentialResolver.name);

    async resolve(_ctx: CredentialContext, keys: readonly string[]): Promise<Map<string, string>> {
        const out = new Map<string, string>();
        for (const key of keys) {
            if (!isCredentialKey(key)) {
                // Key names are safe to log; values never are.
                this.logger.warn(`Ignoring malformed credential key '${key}'.`);
                continue;
            }
            const value = process.env[envVarNameForCredential(key)];
            if (typeof value === 'string' && value.length > 0) {
                out.set(key, value);
            }
        }
        return out;
    }
}
