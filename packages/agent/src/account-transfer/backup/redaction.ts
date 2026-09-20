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
 * `redaction.spec.ts` reflects over every entity source file and fails when a
 * column that LOOKS like it carries a secret has no rule and no reviewed
 * exemption. Three independent families are reflected, because the first one
 * alone shipped four leaks:
 *
 *  1. **Name-shaped.** A column matching
 *     `/secret|password|token|hash|credential/i`.
 *  2. **Encrypted-at-rest by name.** A column whose name ends in
 *     `Encrypted`. `Work.deployDatabaseUrlEncrypted` (the per-Work Postgres
 *     connection string) and `Work.deployRuntimeEnvEncrypted` (the
 *     allow-listed runtime env bag) match neither family 1 nor any pattern
 *     below, and were exported verbatim until this family existed.
 *  3. **Encrypted-at-rest by decorator.** A column declared with
 *     `@EncryptedJsonColumn`. Those names say nothing about their contents —
 *     `RepoConnection.envFiles` is seed `.env` file bodies and
 *     `NotificationChannel.targetConfig` is a live bot token / webhook URL —
 *     so only the decorator identifies them.
 *
 * A fourth, narrower pass covers every entity the `billing` domain exports:
 * the archive publishes a `payment_identifiers` exclusion, so every
 * `provider*`/`payg*` identifier column on any of them needs a rule or a
 * reviewed exemption too. The entity set is read from the domain table, not
 * copied, so a billing entity added to the archive later is covered the day
 * it is added.
 *
 * The per-entity column tables below are checked in the other direction as
 * well: every column they name has to be declared on its entity. A rule on a
 * column that does not exist deletes nothing, so an identifier whose column
 * is renamed would otherwise lose its protection without any test noticing.
 *
 * A new secret column therefore cannot silently start being exported: it
 * either gets a rule or it gets an explicit, reviewed "this is not a secret"
 * in {@link BACKUP_BENIGN_COLUMNS}.
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
    // Anything the platform bothered to envelope-encrypt at rest is material
    // the archive may not carry, whatever the rest of the name says. The two
    // narrower patterns above are subsumed by this one and kept so a reader
    // can still see which shapes were named deliberately.
    //
    // This is the rule that would have stopped `deployDatabaseUrlEncrypted`
    // (a Postgres connection string, user and password included) and
    // `deployRuntimeEnvEncrypted` (an allow-listed payment-key bag) from
    // shipping in `data/works/works.jsonl` while the four sibling
    // `deploy*SecretEncrypted` columns on the same row were redacted.
    /encrypted$/i,
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
    // `envFiles` is the seed `.env` bodies keyed by repository path, an
    // `@EncryptedJsonColumn` the entity itself records as MASKED in API
    // responses ("paths + sizes only; full content is returned only by the
    // explicit owner-gated env-files endpoint"). `page()` reads rows with
    // `getRawMany()`, which bypasses the decrypt transformer, so what the
    // archive would have carried is the stored text: the `enc::v1::`
    // envelope on a keyed install, and the literal `.env` contents wherever
    // `PLUGIN_SECRET_ENCRYPTION_KEY` is unset or the row predates the
    // column being encrypted. Redacted to a bag of `{ wasSet }` keyed by
    // path, which is exactly the masked answer the API already gives — it
    // still tells the owner which repositories need their `.env` re-seeded.
    RepoConnection: Object.freeze(['credentialRef', 'envFiles']),
    // `targetConfig` is the per-plugin channel endpoint bag, and the entity
    // documents what is inside it: a Telegram `botToken`, a WhatsApp
    // `accessToken`, a Novu `apiKey`, a Slack/Discord `webhookUrl`. Another
    // `@EncryptedJsonColumn`, so the same `getRawMany()` caveat applies —
    // and `domain-specs.ts` already claims of this very file that "channel
    // endpoints are redacted", which until now they were not. The bag keeps
    // its field NAMES and none of their values, so the archive answers
    // "which channels do I have to re-credential?".
    NotificationChannel: Object.freeze(['targetConfig']),
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
        // The metered (pay-as-you-go) pair, dropped for the same reason as
        // their siblings above: `paygSubscriptionId` addresses a live
        // subscription at the payment provider and `paygSubscriptionItemId`
        // is the item that "threshold / price updates address", so both are
        // capabilities rather than records. The archive's own
        // `payment_identifiers` exclusion promises that provider
        // subscription and METER identifiers are absent; these two were the
        // only ones still present.
        'paygSubscriptionId',
        'paygSubscriptionItemId',
    ]),
    // The plan subscription row (`data/billing/subscription.jsonl`). Spec
    // FR-18.6 names subscription identifiers outright, and both of these
    // address a live object at the payment provider: `providerSubscriptionId`
    // is what a later subscription lifecycle delivery uses to update or
    // revoke exactly this row, and `providerSeatItemId` is the per-seat
    // subscription item a seat-quantity change creates or updates. The rest
    // of the row — plan, status, seats, billing provider, period end,
    // cancel-at-period-end — is the record, and still exports.
    //
    // `paymentMethodMeta` is a free-form bag documented as provider-specific
    // payment-method data — the payment-method category FR-18.6 excludes.
    // Nothing writes it today, so this drops nothing yet; it is here so that
    // the first writer cannot put payment-method data into an archive
    // without anyone deciding to.
    UserSubscription: Object.freeze([
        'providerSubscriptionId',
        'providerSeatItemId',
        'paymentMethodMeta',
    ]),
    // `providerCustomerId` is not a column of `Invoice` (the customer id
    // lives on `BillingProfile`, dropped above). Kept pending review; see
    // `KNOWN_STALE_COLUMN_RULES` in `redaction.spec.ts`.
    //
    // Reviewed and deliberately KEPT: `hostedUrl` and `pdfUrl`. They are
    // payment-provider links to this owner's own invoices, and the owner
    // downloading their own archive is the audience that wants them working.
    // Not an oversight — do not add them here without revisiting that call.
    Invoice: Object.freeze(['providerInvoiceId', 'providerCustomerId']),
    LicencePurchase: Object.freeze(['providerPaymentId']),
    // The ledger has no `providerEventId` column, which is why this rule
    // used to delete nothing: the provider EVENT id is written into
    // `idempotencyKey`, as `{provider}:evt:{eventId}` on a credit purchase or
    // refund reversal and `revoke:plan:{provider}:evt:{eventId}` on a plan
    // allowance clawback. Every other key in that column (`run:{runId}`,
    // `daily:{userId}:{date}`, `grant:plan:…`) is a writer's replay guard,
    // not something a reader of the ledger needs, so the whole column goes.
    //
    // Reviewed and deliberately KEPT: `refId`. On `refType: 'billing-payment'`
    // rows it carries the provider's payment id, but on every other row it is
    // the link from a ledger entry to the run or subscription that caused it,
    // and FR-18.6 does not name payment ids. Keeping the whole column keeps
    // that record intact. Not an oversight — revisit before adding it here.
    CreditLedgerEntry: Object.freeze(['idempotencyKey']),
    // Neither column exists on `UsageLedgerEntry`: nothing forwards a usage
    // row to the payment provider, so no provider handle is ever stored on
    // it. Kept pending review; see `KNOWN_STALE_COLUMN_RULES` in
    // `redaction.spec.ts`.
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
