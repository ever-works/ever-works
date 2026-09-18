import {
    BACKUP_EXCLUSIONS,
    type BackupExclusion,
    type BackupExclusionCode,
} from '@ever-works/contracts';

/**
 * Workspace backup (AW-22) — the one place that decides what never reaches an
 * archive.
 *
 * Spec FR-18 lists nine categories that must not appear in any form, at any
 * option setting. This module implements them as three rule families, applied
 * by every collector to every row, so a domain can never opt out:
 *
 *  1. **Drop the row entirely.** Tables whose whole purpose is a credential,
 *     a session, a derived cache or a delivery outbox never produce a line.
 *  2. **Replace the value with `{ wasSet: true }`.** A stored credential's
 *     PRESENCE is useful — it tells the owner which connections will need a
 *     credential re-entered after a restore — while the value is exactly what
 *     may not travel. So the field NAME survives and the value does not.
 *  3. **Delete the column.** A few columns carry nothing a reader should
 *     have even as a presence flag: password material, the
 *     platform-administrator flag, payment-provider identifiers.
 *
 * ## Why this is not the existing export's masking
 *
 * `maskSecretSettings` in `../types.ts` replaces a secret's value with a
 * masked marker so the legacy import can detect it and ask for a
 * replacement — it is a round-trip shape for a round-trip payload, and it
 * still ships unchanged for that payload. An archive is not round-tripped
 * field by field; it is read by a person. `{ wasSet: true }` says the one
 * thing a reader needs without inventing a value that looks like data.
 *
 * ## The guard that keeps this honest
 *
 * `redaction.spec.ts` reflects over `AGENT_ENTITY_NAMES` and every entity
 * source file, and fails when a column whose name matches
 * `/secret|password|token|hash|credential/i` is neither redacted, nor
 * dropped, nor listed in {@link BACKUP_BENIGN_COLUMNS} with a reason. A new
 * secret column therefore cannot silently start being exported: it either
 * gets a rule or it gets an explicit, reviewed "this is not a secret".
 */

/**
 * What a redacted secret looks like in the archive. Only presence survives.
 */
export interface RedactedSecret {
    readonly wasSet: boolean;
}

/**
 * Re-exported so the manifest builder and the coverage drawer render the
 * same nine categories the collectors enforce. The list itself lives in
 * `@ever-works/contracts` because `apps/web` reads it too.
 */
export { BACKUP_EXCLUSIONS };
export type { BackupExclusion, BackupExclusionCode };

/**
 * Entities whose rows never appear in an archive at all (spec FR-18.1, .2,
 * .8, .9). Listed by entity class name, which is what the collectors carry.
 */
export const BACKUP_DROPPED_ENTITIES: readonly string[] = Object.freeze([
    // Sessions and third-party auth tokens.
    'AuthSession',
    'AuthAccount',
    'RefreshToken',
    // Encrypted runtime credentials and their per-version snapshots.
    'TenantCredentialSnapshot',
    // Derived and regenerated on demand — an archive of them would be
    // stale bytes a reader cannot use.
    'WorkKnowledgeChunk',
    'WorkKnowledgeChunkCoordinate',
    // Internal caches and metering plumbing.
    'CacheEntry',
    'CreditMeterEvent',
]);

const DROPPED_ENTITY_SET = new Set(BACKUP_DROPPED_ENTITIES);

/**
 * Column-name patterns redacted to `{ wasSet }` on EVERY entity. Matching by
 * shape rather than by a list is deliberate: a new `*SecretEncrypted` column
 * on a new entity is redacted the day it lands, before anyone remembers this
 * file exists.
 */
const SECRET_COLUMN_PATTERNS: readonly RegExp[] = Object.freeze([
    /secretencrypted$/i,
    /credentialsencrypted$/i,
    /^secretsettings$/i,
    /^authheaders$/i,
    /^credentialref$/i,
    /^credentialssecretref$/i,
    /^webhooksecret$/i,
    /^signingsecret$/i,
]);

/** Extra per-entity columns redacted to `{ wasSet }` where the shape rule cannot see them. */
const ENTITY_SECRET_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    FleetNode: Object.freeze(['previousCredentialHash']),
    RepoConnection: Object.freeze(['credentialRef']),
    // AW-16 Model accounts. `credentials` is the provider's own secret
    // settings bag, encrypted at rest. It is a named bag rather than one
    // opaque value, so `redactRow` keeps the NAMES of the fields that were
    // set and none of their values — which is what spec FR-18.4 promises and
    // what makes the archive useful for "which keys do I have to re-enter?".
    ModelAccount: Object.freeze(['credentials']),
});

/**
 * Columns deleted outright, leaving no key at all. Reserved for material
 * whose very presence is not information a reader needs, and for the
 * payment-provider identifiers of spec FR-18.6 — an id that addresses a
 * live billing object is a capability, not a record.
 */
const ENTITY_DROPPED_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    User: Object.freeze([
        'password',
        'passwordResetToken',
        'passwordResetExpires',
        'emailVerificationToken',
        'magicLinkToken',
        'isPlatformAdmin',
    ]),
    ApiKey: Object.freeze(['hashedKey']),
    FleetNode: Object.freeze(['enrollmentTokenHash']),
    AuthSession: Object.freeze(['token', 'tokenHash']),
    // AW-18 Shared view. The share-link token is a read capability over the
    // published projection: anyone holding it can open the view without
    // signing in. So all three forms go — the plaintext, the `sha256(token)`
    // the public path looks up, and the encrypted envelope. The row itself
    // still exports (what was shared, which sections, whether crawlers may
    // index it), which is the part a reader needs; a restore mints a fresh
    // link rather than resurrecting an old one.
    SharedView: Object.freeze(['token', 'tokenHash', 'tokenEncrypted']),
    OrganizationInvitation: Object.freeze(['tokenHash']),
    WorkInvitation: Object.freeze(['tokenHash']),
    TenantEmailAddress: Object.freeze(['verificationToken']),
    AgentRun: Object.freeze(['resumeClaimToken']),
    GitHubAppUserLink: Object.freeze(['accessToken', 'refreshToken']),
    OnboardingRequest: Object.freeze(['githubIdentityHash']),
    TermsAcceptance: Object.freeze(['ipHash']),
    BillingProfile: Object.freeze([
        'providerCustomerId',
        'providerSubscriptionId',
        'defaultPaymentMethodRef',
    ]),
    Invoice: Object.freeze(['providerInvoiceId', 'providerCustomerId']),
    LicencePurchase: Object.freeze(['providerPaymentId']),
    CreditLedgerEntry: Object.freeze(['providerEventId']),
    UsageLedgerEntry: Object.freeze(['providerMeterId', 'providerEventId']),
});

/**
 * Columns whose NAME matches the secret-shaped pattern but which carry no
 * secret, each with the reason it is safe. The guard reads this map, so
 * adding an entry is a reviewed decision rather than a silent exception.
 */
export const BACKUP_BENIGN_COLUMNS: Readonly<Record<string, string>> = Object.freeze({
    totalTokens: 'A model token count — how much a run cost, not a credential.',
    tokensUsed: 'A model token count.',
    tokenCount: 'A model token count on a knowledge chunk or document.',
    total_tokens_used: 'A model token count on a generation history row.',
    maxSkillContextTokens: 'A configured ceiling on context size.',
    tokenType: 'The OAuth token TYPE (e.g. "bearer"), never the token.',
    contentHash: 'A content digest used to detect drift in a file we wrote.',
    credentialMode: 'Which KIND of credential a repo connection uses — never a credential.',
    credentialVersion: 'A monotonic version number for credential rotation.',
    credentialIssuedAt: 'A timestamp.',
    previousCredentialExpiresAt: 'A timestamp.',
    tokenExpiresAt: 'A timestamp.',
    accessTokenExpiresAt: 'A timestamp.',
    refreshTokenExpiresAt: 'A timestamp.',
    passwordChangedAt: 'A timestamp.',
    verificationTokenExpiresAt: 'A timestamp.',
    tokenRotatedAt: 'A timestamp — when a share link was last regenerated.',
    credentialExpiresAt: 'A timestamp — when a model account’s credential stops working.',
    normalizedContentHash:
        'A digest of a knowledge document’s whitespace-normalized body, used to tell a substantive edit from a reformat. Derived from content the archive already carries in full.',
    includeSecrets:
        'A boolean toggle on the legacy config-repo sync — whether that path was asked to carry masked secrets. Not itself a secret.',
    // APW-03 T9 — the App spec state table's three digests. The guard fired on
    // them the moment `WorkAppSpecState` landed (2026-09-18), which is exactly
    // what it is for: a new `*Hash` column has to be decided, not inherited.
    headSpecHash:
        'A sha256 of the App spec at the repository head, used to tell one evaluation from the next. The spec is a file in the member’s own repository, which the archive does not carry — the digest gives nothing away that the repository does not already publish to anyone who can read it.',
    effectiveSpecHash:
        'A sha256 of the spec the Work is actually running under (head, or a pinned earlier commit). A content digest for change detection, not a credential.',
    licenseRegistryHash:
        'A sha256 of the license registry the App spec resolved against, used to notice a registry change between evaluations. The registry is public template metadata.',
    // APW-04 T7 / APW-05 T4 — the provisioning and build tables. The guard fired on
    // these the moment those entities landed (2026-09-18, caught by APW-09 T43's
    // full-suite run rather than by the slice that added them), which is precisely
    // its job: a new secret-shaped column has to be *decided*, not inherited. Each
    // reason below is read off the column's own docstring and the contract it holds,
    // not inferred from the name.
    tokenCap:
        'A numeric CEILING on how many model tokens a provisioning run may spend (default 3,000,000). A budget, not a credential — the sibling `tokensUsed` is already benign for the same reason.',
    appSpecHash:
        'A digest of the App spec the Build ran under, for change detection. The spec is a file in the member’s own repository, which the archive does not carry.',
    buildInputsHash:
        'sha256 over (name, fingerprint) of the build values a preparation synced (plan §4.7) — a digest of NAMES and fingerprints, never of a value.',
    secretsSyncedAt:
        'A timestamp — when the secret sync finished. The deployable verdict’s freshness clock (§5.1).',
    buildSecretNames:
        'The `EW_` secret NAMES a preparation wrote (≤ 50). The entity docstring is explicit: "Names only, never values" — the values are sealed in the platform’s secret store and never reach this table.',
    verifySecretNames:
        'The names of the per-run prompted values a verification created (§4.10), kept so the cleanup can find and remove them. Names only; the values live in the secret store and are removed at the end of the run.',
    secretCheck:
        'The closed three-value verdict `passed | failed | not_needed` (`APP_BUILD_SECRET_CHECK_RESULTS`). The name matched the guard’s pattern; the value is an enum, not a secret.',
});

/** Does this entity produce no lines in an archive at all? */
export function shouldDropEntirely(entityName: string): boolean {
    return DROPPED_ENTITY_SET.has(entityName);
}

/** Is this column's VALUE replaced by `{ wasSet }`? */
export function isRedactedColumn(entityName: string, column: string): boolean {
    if (ENTITY_SECRET_COLUMNS[entityName]?.includes(column)) {
        return true;
    }
    return SECRET_COLUMN_PATTERNS.some((pattern) => pattern.test(column));
}

/** Is this column removed outright, key and all? */
export function isDroppedColumn(entityName: string, column: string): boolean {
    return ENTITY_DROPPED_COLUMNS[entityName]?.includes(column) ?? false;
}

/** Is this secret-shaped column name explicitly reviewed as carrying no secret? */
export function isBenignColumn(column: string): boolean {
    return Object.prototype.hasOwnProperty.call(BACKUP_BENIGN_COLUMNS, column);
}

/**
 * Turn a settings bag whose VALUES are secrets into a bag of presence flags.
 * The keys are the names of the fields that were set — which is exactly what
 * spec FR-18.4 permits, and exactly what a restore needs to tell the owner
 * which connections to re-credential.
 */
export function redactSecretBag(value: unknown): Record<string, RedactedSecret> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    const out: Record<string, RedactedSecret> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
        out[key] = { wasSet: (value as Record<string, unknown>)[key] != null };
    }
    return out;
}

/**
 * Apply every rule to one row.
 *
 * Returns `null` when the whole row is dropped, so a collector can simply
 * skip it. Otherwise returns a NEW object — the input is never mutated,
 * because the same entity instance may still be in TypeORM's identity map.
 */
export function redactRow(
    entityName: string,
    row: Record<string, unknown>,
): Record<string, unknown> | null {
    if (shouldDropEntirely(entityName)) {
        return null;
    }

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
        if (isDroppedColumn(entityName, key)) {
            continue;
        }
        if (isRedactedColumn(entityName, key)) {
            // A bag of named secret fields keeps its names; a single opaque
            // secret column keeps only the fact that it was set.
            out[key] =
                value && typeof value === 'object' && !Array.isArray(value)
                    ? redactSecretBag(value)
                    : { wasSet: value != null && value !== '' };
            continue;
        }
        out[key] = value;
    }
    return out;
}
