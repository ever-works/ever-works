import { Logger } from '@nestjs/common';

/**
 * APW-12 (Ever ID) delegated read — which apps a delegated token may have been
 * minted for.
 *
 * FR-45 accepts any token whose signature, issuer, audience, scope and lifetime
 * verify, whichever client asked the provider for it. An installation that knows
 * exactly which apps read for its people (the hosts of the App Launcher in other
 * Ever products) can narrow that: `EVER_ID_TRUSTED_CLIENT_IDS` lists those client
 * ids, and a delegated token whose authorised party (`azp`) is not one of them is
 * refused like any other invalid credential (`401`, FR-46). The rule is the
 * plugin's own `allowedAuthorizedParties` check (refusal code
 * `badAuthorizedParty`), the one the terminal exchange already uses (FR-40).
 *
 * Unset or empty keeps today's behaviour: no `azp` rule. Empty matters because
 * the deploy manifests render an unset variable as an empty string.
 */

/** The environment variable that carries the list. */
export const EVER_ID_TRUSTED_CLIENT_IDS_ENV = 'EVER_ID_TRUSTED_CLIENT_IDS';

/** At most five entries: the same ceiling the plugin sets for terminal clients (`localClients`). */
export const EVER_ID_TRUSTED_CLIENT_IDS_MAX = 5;

/**
 * A client id as a provider issues it: 1..255 printable characters, no space and
 * no comma (the comma separates entries). Deliberately broad: providers spell
 * ids differently (numeric, `name@project`, a UUID), and this list only ever
 * narrows what a valid token may be.
 */
const CLIENT_ID_PATTERN = /^[\x21-\x2B\x2D-\x7E]{1,255}$/;

export interface TrustedClientIdsParse {
    /** Valid entries in the order written, de-duplicated. */
    clientIds: string[];
    /** Entries that are not client ids, verbatim, for the boot message. */
    invalid: string[];
    /** `true` when there are more than {@link EVER_ID_TRUSTED_CLIENT_IDS_MAX} valid entries. */
    tooMany: boolean;
}

/** Splits, trims and classifies the raw value. Pure: the caller decides what to do about it. */
export function parseTrustedClientIds(raw: string | undefined | null): TrustedClientIdsParse {
    const entries = (raw ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);

    const clientIds: string[] = [];
    const invalid: string[] = [];
    for (const entry of entries) {
        if (!CLIENT_ID_PATTERN.test(entry)) {
            invalid.push(entry);
        } else if (!clientIds.includes(entry)) {
            // Client ids are compared exactly (the provider's `azp` is exact), so
            // only an identical spelling is a duplicate.
            clientIds.push(entry);
        }
    }
    return {
        clientIds,
        invalid,
        tooMany: clientIds.length > EVER_ID_TRUSTED_CLIENT_IDS_MAX,
    };
}

const bootLogger = new Logger('EverIdTrustedClients');

/**
 * The list the delegated read enforces, validated at boot.
 *
 * - Unset, empty or only separators: `undefined`, which means "no `azp` rule".
 * - Production: an invalid entry, or more than {@link EVER_ID_TRUSTED_CLIENT_IDS_MAX},
 *   throws, so a misconfigured deploy does not come up with a rule other than
 *   the one written (the posture of `ALLOWED_ORIGINS` and
 *   `EVER_WORKS_APP_LAUNCHER_ORIGINS`).
 * - Elsewhere: invalid entries are dropped and the list is truncated, each with a
 *   warning. A value that was set but holds no valid entry gives `[]`, which
 *   refuses every delegated token: a typo must never turn the rule off.
 */
export function resolveTrustedClientIds(
    env: NodeJS.ProcessEnv = process.env,
): readonly string[] | undefined {
    const raw = env[EVER_ID_TRUSTED_CLIENT_IDS_ENV];
    const { clientIds, invalid, tooMany } = parseTrustedClientIds(raw);
    if (clientIds.length === 0 && invalid.length === 0) {
        return undefined;
    }

    const production = env.NODE_ENV === 'production';
    if (invalid.length > 0) {
        const message =
            `${EVER_ID_TRUSTED_CLIENT_IDS_ENV} carries ${invalid.length} entry/entries that are not ` +
            `client ids (1-255 printable characters, no spaces): ${invalid.join(', ')}.`;
        if (production) {
            throw new Error(message);
        }
        bootLogger.warn(`${message} Ignored outside production.`);
    }

    if (tooMany) {
        const message =
            `${EVER_ID_TRUSTED_CLIENT_IDS_ENV} carries ${clientIds.length} client ids; the maximum is ` +
            `${EVER_ID_TRUSTED_CLIENT_IDS_MAX}.`;
        if (production) {
            throw new Error(message);
        }
        bootLogger.warn(`${message} Truncated outside production.`);
        return Object.freeze(clientIds.slice(0, EVER_ID_TRUSTED_CLIENT_IDS_MAX));
    }

    return Object.freeze(clientIds);
}
