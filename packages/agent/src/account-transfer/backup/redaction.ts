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
    // ── EW-818, family 5: free-form bags nothing else could see ──────────
    //
    // `providerSettings` is the column EW-818 was opened for. Plain
    // `simple-json`, ordinary name, and its own docstring says
    // "from-name, routing-tag, WEBHOOK SECRET, etc.". Both writers store the
    // caller's object verbatim (`email.service.ts` createAddress and
    // updateAddress), and the DTO is `@IsObject()` on a
    // `Record<string, unknown>` — container-only validation, so the caller
    // owns every key. The fixtures say what really goes in:
    // `{ apiKey: 'secret' }` in the unit spec, `{ apiKey: 'ci-fake-key' }`
    // rotated to `{ apiKey: 'rotated-key', region: 'eu' }` in the e2e.
    TenantEmailAddress: Object.freeze(['verificationToken', 'providerSettings']),
    // `config` is "passthrough to Composio", declared `@IsObject()` with no
    // shape, and stored verbatim as `body.config ?? null`. Nothing constrains
    // the key set at the DTO, in the service, or upstream, so "today it is
    // filters and a polling cadence" is a convenience rather than a
    // constraint. Note the read surface: `toDto` does NOT return `config`, so
    // the archive was the only place it appeared in the clear. The sibling
    // `webhookSecret` on the same row was already covered by family 1 — which
    // is exactly the shape of this bug: the column NAMED as a secret was
    // guarded and the bag beside it that can hold one was not.
    ComposioTriggerSubscription: Object.freeze(['config']),
    // `result` is written by a MACHINE, not by us: `POST /api/fleet/jobs/:id/
    // complete` is `@Public()`, authenticated only by the node secret, and its
    // DTO declares `@IsOptional() @IsObject() result?: Record<string, unknown>`
    // with no shape at all. `normalizePayload` checks "non-array object" and a
    // 256 KB cap and explicitly does not schema-check or truncate. Even from a
    // well-behaved node the contents are log text — `outputTail`, "last bytes
    // of combined stdout/stderr" — which is where a build step echoing its
    // environment, a `git remote -v` carrying an embedded token, or a provider
    // 401 body ends up.
    //
    // `payload` is ours by key, but not by value: `execution.instructions` is
    // the composed prompt, up to 160 KB of owner-authored prose. An owner who
    // answers a paused run with "use this key: sk-…", or writes one into a
    // Task body, has it copied verbatim into `data/fleet/jobs.jsonl`.
    FleetJob: Object.freeze(['payload', 'result']),
    // Every key in `payload` is ours (the dispatcher builds fixed literals and
    // no DTO accepts one from a caller) — but the `error` value on
    // `deployment.failed` is a deploy provider's verbatim error body, which is
    // where a signed URL, an echoed Authorization header or a token-bearing
    // remote lands. The entity's own docstring calls the column
    // "x-secret-adjacent" and says the deliveries endpoint redacts it before
    // returning it, and it does — `WebhookDeliveryView` omits `payload`
    // entirely. The archive was publishing what the product refuses to show.
    WebhookDelivery: Object.freeze(['payload']),
    // `details` is the ingest envelope copied byte-for-byte: on a
    // `github.push`/`commit`/`merge` event the service writes
    // `details: event.payload`, and the edge DTO validates a 32 KB byte cap
    // and NOTHING else. One caller picks both the `kind` that triggers the
    // copy and every key in the bag, so a remote URL of the
    // `https://x-access-token:ghs_…@github.com/o/r.git` shape lands in
    // `data/activity/activity-log.jsonl` verbatim.
    //
    // `metadata` comes from a `@Public()` ingest endpoint that every deployed
    // directory site can reach with the shared platform token. Its DTO is
    // `@IsObject()` plus an 8 KB cap, and the service does
    // `{ ...rawMetadata, occurredAt }` with no key inspection — the DTO's own
    // documentation calls it "free-form metadata (actor name, target id,
    // admin URL, etc.)". A template that puts a webhook secret or an admin
    // session URL in an event leaks it into the owner's archive with no code
    // change here.
    ActivityLog: Object.freeze(['details', 'metadata']),
    // `metadata` carries `argsPreview` and `resultPreview` — the MODEL's raw
    // tool arguments and the TOOL RESULT, up to 4 KB each. They do pass
    // through `redactSecrets`, but that is an ALLOW-LIST: fifteen
    // prefix-anchored patterns (`sk-`, `ghp_`, `AKIA`, `Bearer …`). A DB
    // connection string with an inline password, a `.env` fragment, or a
    // vendor key with no recognised prefix goes straight through it. A filter
    // that catches the shapes we thought of is not a guarantee, and the
    // archive is where the ones we did not think of accumulate.
    AgentRunLog: Object.freeze(['metadata']),
    // Nothing sets `metadata` to a non-null value today — stated plainly
    // because it is the finding, not a gap in the search: every persist path
    // writes `null` or omits the key, and no caller populates
    // `input.metadata`. It is redacted anyway, because the first writer of a
    // free-form bag on a message row will be provider tags or third-party
    // webhook JSON, and the sibling `TenantEmailAddress.providerSettings`
    // — same domain, same file directory — is what that looks like when it
    // ships.
    EmailMessage: Object.freeze(['metadata']),
    // `parameters` is a verbatim deep copy of the whole generation DTO
    // (`JSON.parse(JSON.stringify(dto))`), taken AFTER `prepareProviders` has
    // written the resolved `pluginConfig` into it. Four shipped pipeline
    // plugins declare a `repo_access_token` field of `type: 'password'` in
    // their generator form, placeholder `ghp_…`, described as "read-only
    // access token for the data repository". That value is in the DTO, so it
    // is in the row, so it was in `data/works/generation-history.jsonl`.
    WorkGenerationHistory: Object.freeze(['parameters']),
    // The plaintext twin of the column beside it. `settings` is a plain
    // `simple-json` column sitting next to the envelope-encrypted
    // `secretSettings`, and its DTO is `@IsObject()` with a transform that
    // only strips `__proto__`/`constructor`/`prototype` and caps depth — so
    // the caller owns every key. `plugin-operations.service.ts` merges it
    // verbatim with no `x-secret` filter, and `metadata` is not even passed
    // to `validateSettingsOrThrow`, so it gets less checking than `settings`
    // does. A Composio `apiKey`, a BYOK provider key, or an OAuth token a
    // plugin wrote back through `ctx.updateSettings` without marking it
    // `x-secret` all land in the clear.
    //
    // Redacted rather than dropped so the KEY NAMES survive: which plugins a
    // restore has to re-credential is exactly what an owner needs, and it is
    // what `secretSettings` beside it already answers.
    UserPluginEntity: Object.freeze(['settings', 'metadata']),
    // The Work-scoped twin, reachable by a WIDER set of principals: the
    // controller calls `ensureCanEdit`, so any Work collaborator can PATCH an
    // arbitrary object into either column, not just the owner.
    WorkPluginEntity: Object.freeze(['settings', 'metadata']),
    // The three below were first classified BENIGN and overturned by the
    // challenge pass. Each has exactly one writer today putting one known
    // thing in — which is the argument for an exemption, and also the reason
    // an exemption would be wrong: the setter's signature is an unvalidated
    // bag, and an exemption is permanent while a writer is not.
    //
    // `Conversation.metadata` has one setter, `ConversationRepository
    // .updateTitle`, and one caller passing a value: the literal
    // `{ aiTitle: true }`. No DTO declares the field, and two e2e specs
    // already assert a 400 for a caller that tries. But `updateTitle` takes
    // `metadata?: Record<string, unknown>` and is exported from
    // `@ever-works/agent/database`, so the second writer needs no review at
    // all — and the owner loses nothing here, because a one-key bag says the
    // same thing as `{ wasSet: true }`.
    Conversation: Object.freeze(['metadata']),
    // `GoalEvent.metadata` is written only by the orchestrator's private
    // `recordEvent`, across fifteen call sites that all build literals. The
    // free value is `plannerModelHint`/`workerModelHint` inside a `control`
    // event's `{ before, after }` snapshot — a field the entity itself
    // documents as a "free-string model hint (no allow-list by design)".
    // 120 characters a user can put anything into, riding inside a bag whose
    // other keys are decision inputs and spend numbers.
    GoalEvent: Object.freeze(['metadata']),
    // `Notification.metadata` has no create route at all — the controller is
    // read-and-mark-only — and every in-service producer builds a literal.
    // The exception is `metadata.markdown` on a digest row: up to 8000
    // characters of rendered digest body, which the code itself notes is
    // "composed from repository rows (titles/summaries are user content)".
    // The notifications file is trimmed by ROW AGE (180 days), not by column,
    // so those digest rows ship with the bag in full.
    Notification: Object.freeze(['metadata']),
    // `envFiles` is the seed `.env` bodies keyed by repository path, an
    // `@EncryptedJsonColumn` the entity itself records as MASKED in API
    // responses ("paths + sizes only; full content is returned only by the
    // explicit owner-gated env-files endpoint"). `page()` reads rows with
    // `getRawMany()`, which bypasses the decrypt transformer, so what the
    // archive would have carried is the stored text: the `enc::v1::`
    // envelope on a keyed install, and the literal `.env` contents wherever
    // `PLUGIN_SECRET_ENCRYPTION_KEY` is unset or the row predates the
    // column being encrypted. Redacted — but to `{ wasSet: true }`, NOT to a
    // bag keyed by path as this comment first claimed: the same `getRawMany()`
    // that bypasses the decrypt transformer also means the value arrives as
    // TEXT, so `redactRow` takes its opaque branch and the paths go with the
    // contents. Less than the masked answer the API gives, and less than an
    // owner wants (they learn a repo had seed files, not which). Pinned in
    // `redaction.spec.ts` — "gives a raw JSON string the opaque shape". It
    // fails closed, so it is a fidelity limit to fix deliberately, not a hole.
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
    // EW-818. `rawPayload` is a third party's object stored verbatim — the
    // `GET /app/installations/:id` response, or the `installation` object
    // lifted straight out of an inbound GitHub webhook body. GitHub chooses
    // the keys and the set can change without any change here, so there is
    // nothing to enumerate and no redaction rule that could keep up.
    //
    // Dropped rather than redacted because the platform already treats the
    // column as not-for-reading: `github-app-sync.service.ts` destructures
    // `rawPayload` out of every API response, pinned by the EW-722 info-leak
    // specs whose fixtures literally use `rawPayload: { secret: 'do-not-leak' }`.
    // An owner loses nothing they could otherwise see.
    GitHubAppInstallation: Object.freeze(['rawPayload']),
    // EW-818. Every key in `metadata` is ours — the facades write fixed
    // literals (`operation`, token counts, `resultCount`, `metricId`) — but
    // two rows carry a caller-supplied URL verbatim: `metadata.url` on the
    // screenshot and content-extractor events. A pre-signed URL, or one with
    // `?api_key=…` or userinfo credentials, IS the capability, and an agent
    // asked to screenshot such a link puts it in the archive in the clear.
    //
    // Dropped rather than redacted because the rest of the bag is counters an
    // owner can already read off the usage rows themselves; keeping the key
    // names buys nothing here.
    PluginUsageEvent: Object.freeze(['metadata']),
    // Also first classified benign, and overturned to a DROP rather than a
    // redaction. The table has exactly one access path and one writer, which
    // emits five derived values — two SHA-256 digests, a storage object key,
    // a MIME type and a timestamp. None of it is secret and none of it is
    // useful to an owner reading their own archive: the digests describe a
    // file the archive already carries, and the storage key addresses an
    // object a restore re-creates. The entity's docstring ("EXIF for images,
    // duration for video, page count for PDF") describes a feature nobody has
    // written yet, so keeping the key names preserves nothing either.
    WorkKnowledgeUpload: Object.freeze(['metadata']),
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
    // APW-09 T43 (FR-43, XC-18) — `WorkUpstreamState.credentialMemberUserId`. The
    // guard fired on it the moment that column landed (commit `8eced931d`), which is
    // exactly its job: a new `*credential*`-shaped column has to be decided, not
    // inherited. The reason below is read off the column's own docstring
    // (`work-upstream-state.entity.ts:307-322`), not inferred from the name.
    credentialMemberUserId:
        'A USER ID, not a credential: the member whose connection is the credential of record for this App Work’s background jobs once a handover has been recorded (NULL = no handover, and the creator `Work.userId` is used instead). It addresses a member the archive already carries in full; the connection it points at is stored elsewhere and is dropped or redacted there by its own rule.',
});

/**
 * Per-ENTITY reviewed exemptions, for columns whose name is too ordinary to
 * exempt globally.
 *
 * {@link BACKUP_BENIGN_COLUMNS} is keyed by column NAME alone, which is right
 * for the names family 1 matches: `tokenExpiresAt` is a timestamp on whatever
 * entity carries it. It is wrong for family 5. `metadata` is declared on ten
 * exported entities, and one blanket entry would exempt every one of them —
 * the blunt exemption that hides the next leak rather than recording a
 * decision about it. So a free-form bag is exempted here, per entity, or not
 * at all.
 *
 * `redaction.spec.ts` checks in BOTH directions: every column named here has
 * to be declared on the entity it is filed under (a rule on a column that was
 * renamed protects nothing), and every free-form bag on an exported entity
 * has to appear in one of the tables above or in this one.
 */
export const BACKUP_BENIGN_ENTITY_COLUMNS: Readonly<
    Record<string, Readonly<Record<string, string>>>
> = Object.freeze({
    // Every entry here survived a challenge pass whose default was to
    // overturn it. Four of the seven proposed exemptions did not.
    WorkAgentRunLog: Object.freeze({
        metadata:
            'The work-agent plan row\u2019s snapshot of `{ dryRun, guardrails }`. `mergeGuardrails` REBUILDS all seven guardrail keys rather than spreading \u2014 four integers through `clampInt` and three booleans through `??` \u2014 and the override that feeds it copies from a hard-coded key array, so a caller key that is not one of the seven is dropped on the way in. The widest value is an integer the owner chose, already clamped.',
    }),
    UsageLedgerEntry: Object.freeze({
        metadata:
            'One writer, one key: `UsageLedgerService.recordUsage` sets `{ cadence }` (a schedule cadence enum) and nothing else, and `RecordUsageOptions` has no metadata field for a caller to widen. Named by file on purpose \u2014 the exemption is per ENTITY, not per writer, so the guard will not re-ask when a second writer appears, and this reason is what the next reader has to check it against.',
    }),
    WorkKnowledgeDocument: Object.freeze({
        metadata:
            'Not an extension dict despite its docstring: this column IS the knowledge document\u2019s body, plus `archivedFrom*`/`transcribed*` stamps our own code writes. No DTO declares the field and the global pipe runs `forbidNonWhitelisted`, so no HTTP caller can name a key. Redacting it would delete the document text from the archive \u2014 text the owner already has mirrored in plaintext in their own data repo. A credential an owner types INTO a runbook body ships with it; that is the residual, and it is the same one the body itself carries.',
    }),
    // APW-06 T16 \u2014 the three `simple-json` columns added to `work_deployments`
    // on 2026-09-22. All three are written ONLY by the App deploy orchestrator on
    // the isolated cluster worker; no DTO declares any of them, and the global
    // pipe runs `forbidNonWhitelisted`, so no HTTP caller can widen one.
    WorkDeployment: Object.freeze({
        componentStatuses:
            'One writer, one shape: the orchestrator maps Kubernetes\u2019 own pod status onto `{ name, role, desired, ready, restarts, lastTerminationReason?, oomKilledAt? }` at the terminal state. Every value is ours or the cluster\u2019s \u2014 a component name from the App spec, three integers, a timestamp, and `lastTerminationReason`, which is the kubelet\u2019s closed reason enum (`OOMKilled`, `Error`, `Completed`) and never the container\u2019s own output. Nothing here is authored by the member\u2019s application.',
        smokeResult:
            'The \u00a75.5 check results: `{ inCluster: CheckResult[], public: CheckResult[], hairpin?, classification?, observedAt }`. `CheckResult` has seven fields and six of them are ours, the App spec\u2019s or the transport\u2019s \u2014 a check name and a `failedExpectation` that both come from the spec the member wrote, a pass/fail/skip enum, an HTTP status, a latency, and a closed classification enum. **The residual is `found`**: it is a substring of the member\u2019s OWN application\u2019s HTTP response, capped at 200 characters and secret-scrubbed by the plugin that produced it (`app-deployment.types.ts:427`). The cap and the scrub are the guarantee, and the scrub is best-effort code we do not run ourselves \u2014 an application that prints an env value into an error page could put 200 characters of it here. Reviewed and accepted 2026-09-22 on the basis that the member owns both the application and the archive; re-challenge this entry if `found` ever grows past 200 characters or a plugin outside this repo starts producing it.',
        appRender:
            'The render facts: `{ phase, namespace, specCommitSha, envChecksum, jobResults[], warnings[], preconditions[], rollback?, cancelledBy?, supersededBy? }`. Plan \u00a77.1 states the rule at the column \u2014 *\u201cNever values or log text\u201d* \u2014 and every member is a platform-authored fact rather than an app-authored one: a phase enum, a namespace we compute, a commit sha, a checksum OF the env rather than the env, our own refusal codes, and row ids. `jobResults[]` carries a job\u2019s name, status and timestamps; the job\u2019s OUTPUT is deliberately not in it, which is the same line \u00a74.9\u2019s failure excerpts draw.',
    }),
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
 * Is this column reviewed as carrying no secret ON THIS ENTITY? The narrower
 * form of {@link isBenignColumn}, for names that are too ordinary to exempt
 * everywhere they appear.
 */
export function isBenignEntityColumn(entityName: string, column: string): boolean {
    const forEntity = BACKUP_BENIGN_ENTITY_COLUMNS[entityName];
    return forEntity ? Object.prototype.hasOwnProperty.call(forEntity, column) : false;
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
            //
            // Which of the two a bag COLUMN gets is decided upstream, not
            // here: `BackupRowSource.page` reads with `getRawMany()` and
            // nothing parses JSON on the way, so a `simple-json` column
            // arrives as the stored TEXT and takes the opaque branch, while a
            // Postgres `json`/`jsonb` column is parsed by the driver and takes
            // the named one. Pinned in `redaction.spec.ts` ("gives a raw JSON
            // string the opaque shape"). It fails closed either way — the
            // opaque shape publishes strictly less — so this is a fidelity
            // limit, not a hole: on sqlite the owner learns that a bag was
            // set without learning which fields to re-credential.
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
