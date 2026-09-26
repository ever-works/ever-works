import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { BACKUP_DOMAIN_SPECS } from './collectors/domain-specs';
import {
    BACKUP_BENIGN_COLUMNS,
    BACKUP_BENIGN_ENTITY_COLUMNS,
    BACKUP_DROPPED_ENTITIES,
    BACKUP_EXCLUSIONS,
    isBenignColumn,
    isBenignEntityColumn,
    isDroppedColumn,
    isRedactedColumn,
    redactRow,
    redactSecretBag,
    shouldDropEntirely,
} from './redaction';

/**
 * Two halves, both of which have to hold for spec FR-18 to be true of a real
 * archive rather than true of the rows we happened to think of:
 *
 *  1. Fixture rows for every entity that carries a secret column, asserting
 *     no secret VALUE survives and — where it is useful — the field NAME
 *     does.
 *  2. Reflection passes over the entity sources that fail when a column that
 *     looks like it carries a secret has no rule and no reviewed exemption.
 *
 * Half 2 is the one that matters in a year: it is what makes a new
 * `fooSecretEncrypted` column on a new entity a failing test rather than a
 * quiet leak into everybody's downloaded backup.
 *
 * It used to reflect on ONE family — the name shape
 * `/secret|password|token|hash|credential/i` — and four leaks walked
 * straight through it, because a column name is not where "this is a
 * credential" is written:
 *
 *  - `Work.deployDatabaseUrlEncrypted` — a Postgres connection string.
 *  - `Work.deployRuntimeEnvEncrypted` — an allow-listed payment-key bag.
 *  - `RepoConnection.envFiles` — seed `.env` file bodies.
 *  - `NotificationChannel.targetConfig` — a live bot token / webhook URL.
 *
 * So there are now four families: the original name shape, a name ending in
 * `Encrypted`, an `@EncryptedJsonColumn` decorator, and the payment-provider
 * identifier columns of every entity the archive's `billing` domain exports.
 * That last entity set is read from `BACKUP_DOMAIN_SPECS` rather than listed
 * here, so a billing entity added to the archive later is covered without
 * anyone remembering this file — and the family asserts that every entity
 * the domain names resolves to a reflected source, so a moved or renamed
 * entity file fails instead of quietly shrinking coverage. It was
 * `BillingProfile`-only until `UserSubscription.providerSubscriptionId` and
 * `providerSeatItemId` turned out to ship in `subscription.jsonl`.
 *
 * The per-entity column rules are also checked in the other direction: each
 * one has to name a column its entity actually declares. A rule on a missing
 * column deletes nothing and nothing else notices, which is how the credit
 * ledger's provider event id (stored in `idempotencyKey`) shipped under a
 * rule naming a `providerEventId` column that never existed.
 */
describe('workspace backup redaction', () => {
    describe('rows that never appear at all', () => {
        it.each([...BACKUP_DROPPED_ENTITIES])('drops every %s row', (entityName) => {
            expect(shouldDropEntirely(entityName)).toBe(true);
            expect(redactRow(entityName, { id: 'x', token: 'super-secret' })).toBeNull();
        });

        it('covers sessions, third-party auth, credential snapshots, embeddings and caches', () => {
            for (const entityName of [
                'AuthSession',
                'AuthAccount',
                'RefreshToken',
                'TenantCredentialSnapshot',
                'WorkKnowledgeChunk',
                'WorkKnowledgeChunkCoordinate',
                'CacheEntry',
                'CreditMeterEvent',
            ]) {
                expect(BACKUP_DROPPED_ENTITIES).toContain(entityName);
            }
        });

        it('keeps every other entity exportable', () => {
            expect(shouldDropEntirely('Work')).toBe(false);
            expect(redactRow('Work', { id: 'w1', name: 'Acme' })).toEqual({
                id: 'w1',
                name: 'Acme',
            });
        });
    });

    describe('fixture rows for every secret-bearing entity', () => {
        const secretLiteral = 'sk-live-do-not-export-me';

        it('keeps a Work exportable while every deployment secret becomes a presence flag', () => {
            const row = redactRow('Work', {
                id: 'w1',
                name: 'Acme',
                webhookSecretEncrypted: secretLiteral,
                deployAuthSecretEncrypted: secretLiteral,
                deployCookieSecretEncrypted: secretLiteral,
                platformSyncSecretEncrypted: null,
            });

            expect(row).toEqual({
                id: 'w1',
                name: 'Acme',
                webhookSecretEncrypted: { wasSet: true },
                deployAuthSecretEncrypted: { wasSet: true },
                deployCookieSecretEncrypted: { wasSet: true },
                platformSyncSecretEncrypted: { wasSet: false },
            });
            expect(JSON.stringify(row)).not.toContain(secretLiteral);
        });

        it('exports a deployed Work without its database URL or its runtime env bag', () => {
            // The archive is the only surface in the product that emits this
            // material at all: the API masks the runtime env, and the
            // database URL is never echoed back. Both are AES envelopes, so
            // what leaked was ciphertext — which the archive's own
            // `stored_credentials` exclusion covers explicitly ("in
            // plaintext or ciphertext").
            const databaseUrl = 'enc::v1::postgres-url-envelope-do-not-export-me';
            const runtimeEnv = 'enc::v1::runtime-env-envelope-do-not-export-me';
            const row = redactRow('Work', {
                id: 'w1',
                slug: 'acme-tools',
                deployDatabaseMode: 'shared',
                deployDatabaseUrlEncrypted: databaseUrl,
                deployRuntimeEnvEncrypted: runtimeEnv,
            });

            expect(row).toEqual({
                id: 'w1',
                slug: 'acme-tools',
                // Which database backs the site is a record, not a capability.
                deployDatabaseMode: 'shared',
                deployDatabaseUrlEncrypted: { wasSet: true },
                deployRuntimeEnvEncrypted: { wasSet: true },
            });
            expect(JSON.stringify(row)).not.toContain(databaseUrl);
            expect(JSON.stringify(row)).not.toContain(runtimeEnv);
        });

        it('exports a repo connection’s env-file PATHS and none of their contents', () => {
            // `page()` reads rows with `getRawMany()`, which bypasses the
            // decrypt transformer — so on an install with no
            // PLUGIN_SECRET_ENCRYPTION_KEY, and for any row written before
            // the column was encrypted, the stored value IS the `.env` text.
            // Both shapes are covered: the decrypted object and the raw string.
            const envBody = 'STRIPE_SECRET_KEY=sk-live-do-not-export-me';
            const decrypted = redactRow('RepoConnection', {
                id: 'rc1',
                provider: 'a-code-host',
                credentialMode: 'app',
                credentialRef: 'ref-123',
                envFiles: { '.env': envBody, 'apps/web/.env.local': envBody },
            });

            expect(decrypted).toEqual({
                id: 'rc1',
                provider: 'a-code-host',
                credentialMode: 'app',
                credentialRef: { wasSet: true },
                // The paths survive, which is what tells the owner which
                // repositories need their `.env` re-seeded — the same answer
                // the masked API response already gives.
                envFiles: { '.env': { wasSet: true }, 'apps/web/.env.local': { wasSet: true } },
            });
            expect(JSON.stringify(decrypted)).not.toContain(envBody);

            const raw = redactRow('RepoConnection', { id: 'rc2', envFiles: envBody });
            expect(raw).toEqual({ id: 'rc2', envFiles: { wasSet: true } });
            expect(JSON.stringify(raw)).not.toContain(envBody);
        });

        it('exports a notification channel’s endpoint field names and no credential', () => {
            // `domain-specs.ts` already tells the reader of this file that
            // "channel endpoints are redacted". This is the test that makes
            // that sentence true.
            const botToken = '123456:AAH-do-not-export-me';
            const row = redactRow('NotificationChannel', {
                id: 'nc1',
                pluginId: 'a-chat-channel',
                verified: true,
                targetConfig: { botToken, chatId: '-100123', webhookUrl: null },
            });

            expect(row).toEqual({
                id: 'nc1',
                pluginId: 'a-chat-channel',
                verified: true,
                targetConfig: {
                    botToken: { wasSet: true },
                    chatId: { wasSet: true },
                    webhookUrl: { wasSet: false },
                },
            });
            expect(JSON.stringify(row)).not.toContain(botToken);
        });

        /**
         * EW-818 CHANGED THIS TEST, and the change has a cost worth stating.
         *
         * `settings` used to export in full — it is the non-secret half of the
         * pair by design, with `secretSettings` beside it for the rest. But
         * the design is a convention, not a constraint: the DTO is
         * `@IsObject()` on a `Record<string, unknown>` whose transform only
         * strips `__proto__`-style keys, `plugin-operations.service.ts` merges
         * the caller's object verbatim with no `x-secret` filter, and a plugin
         * can write an OAuth token back through `ctx.updateSettings` without
         * marking it secret. A credential CAN be in there.
         *
         * So it is redacted, and the price is real: an owner reading their own
         * archive no longer sees `model: 'default'`, only that a `model` key
         * was set. That is a deliberate fail-closed call on a column whose
         * contents are usually harmless, and it is the one judgement in
         * EW-818 a reviewer should push back on if they disagree — reversing
         * it means deleting `'settings'` from the two plugin entries in
         * `ENTITY_SECRET_COLUMNS` and restoring the old expectation here.
         */
        it('keeps the NAMES of a plugin’s settings and secret settings, and no values', () => {
            const row = redactRow('UserPluginEntity', {
                id: 'up1',
                pluginId: 'some-provider',
                settings: { model: 'default' },
                secretSettings: { apiKey: secretLiteral, organizationKey: secretLiteral },
            });

            expect(row).toEqual({
                id: 'up1',
                pluginId: 'some-provider',
                // The names are exactly what tells an owner which connections
                // will need a credential re-entered after a restore — now for
                // both halves of the pair.
                settings: { model: { wasSet: true } },
                secretSettings: { apiKey: { wasSet: true }, organizationKey: { wasSet: true } },
            });
            expect(JSON.stringify(row)).not.toContain(secretLiteral);
        });

        it('turns an MCP connection’s auth headers into names only', () => {
            const row = redactRow('McpServerConnection', {
                id: 'mcp1',
                url: 'https://example.invalid/mcp',
                authHeaders: { Authorization: `Bearer ${secretLiteral}` },
            });

            expect(row?.authHeaders).toEqual({ Authorization: { wasSet: true } });
            expect(JSON.stringify(row)).not.toContain(secretLiteral);
        });

        it('exports a trigger without either of its signing secrets', () => {
            const row = redactRow('InboundTrigger', {
                id: 't1',
                slug: 'deploy-hook',
                secretEncrypted: secretLiteral,
                previousSecretEncrypted: secretLiteral,
            });

            expect(row).toEqual({
                id: 't1',
                slug: 'deploy-hook',
                secretEncrypted: { wasSet: true },
                previousSecretEncrypted: { wasSet: true },
            });
        });

        it('exports a webhook subscription without its signing secret', () => {
            const row = redactRow('WebhookSubscription', {
                id: 'wh1',
                url: 'https://example.invalid/hook',
                secretEncrypted: secretLiteral,
            });
            expect(row?.secretEncrypted).toEqual({ wasSet: true });
        });

        it('exports a node’s identity but never anything it enrols with', () => {
            const row = redactRow('FleetNode', {
                id: 'n1',
                name: 'studio-imac',
                platform: 'darwin',
                enrollmentTokenHash: secretLiteral,
                previousCredentialHash: secretLiteral,
                credentialIssuedAt: '2026-09-01T00:00:00.000Z',
            });

            expect(row).toEqual({
                id: 'n1',
                name: 'studio-imac',
                platform: 'darwin',
                previousCredentialHash: { wasSet: true },
                credentialIssuedAt: '2026-09-01T00:00:00.000Z',
            });
            expect(row).not.toHaveProperty('enrollmentTokenHash');
        });

        it('exports a user without password material or the platform-admin flag', () => {
            const row = redactRow('User', {
                id: 'u1',
                email: 'owner@example.invalid',
                name: 'Owner',
                password: secretLiteral,
                passwordResetToken: secretLiteral,
                passwordResetExpires: '2026-09-01T00:00:00.000Z',
                emailVerificationToken: secretLiteral,
                magicLinkToken: secretLiteral,
                isPlatformAdmin: true,
            });

            expect(row).toEqual({ id: 'u1', email: 'owner@example.invalid', name: 'Owner' });
        });

        it('exports an API key as name and prefix, never as key material', () => {
            const row = redactRow('ApiKey', {
                id: 'k1',
                name: 'CI',
                prefix: 'ew_live_ab',
                isActive: true,
                hashedKey: secretLiteral,
            });

            expect(row).toEqual({ id: 'k1', name: 'CI', prefix: 'ew_live_ab', isActive: true });
        });

        it('exports a billing profile as a record without any provider identifier', () => {
            const row = redactRow('BillingProfile', {
                id: 'b1',
                provider: 'a-payment-provider',
                providerCustomerId: 'cus_123',
                providerSubscriptionId: 'sub_123',
                defaultPaymentMethodRef: 'pm_123',
                status: 'active',
                // The metered pair. `paygEnabled` and `paygStatus` are
                // record — whether the owner opted in, and how it is doing —
                // while the two ids address live billing objects, which the
                // published `payment_identifiers` exclusion covers.
                paygEnabled: true,
                paygStatus: 'active',
                paygSubscriptionId: 'sub_metered_123',
                paygSubscriptionItemId: 'si_metered_123',
            });

            expect(row).toEqual({
                id: 'b1',
                provider: 'a-payment-provider',
                status: 'active',
                paygEnabled: true,
                paygStatus: 'active',
            });
            expect(row).not.toHaveProperty('paygSubscriptionId');
            expect(row).not.toHaveProperty('paygSubscriptionItemId');
        });

        it('exports a plan subscription as a record without its provider subscription, seat item or payment-method bag', () => {
            // `data/billing/subscription.jsonl`. Spec FR-18.6 names
            // subscription identifiers outright, and both ids address a live
            // object at the payment provider — the subscription a later
            // lifecycle delivery updates or revokes, and the per-seat item a
            // seat change creates or updates. `paymentMethodMeta` is
            // provider-specific payment-method data (FR-18.6's payment-method
            // category); nothing writes it today, so the fixture sets it to
            // prove a future writer's data cannot reach an archive.
            // Everything else is the record.
            const subscriptionId = 'sub_plan_do_not_export_123';
            const seatItemId = 'si_seat_do_not_export_123';
            const row = redactRow('UserSubscription', {
                id: 'us1',
                userId: 'u1',
                planCode: 'standard',
                planId: 'plan-standard',
                status: 'active',
                billingProvider: 'a-payment-provider',
                providerSubscriptionId: subscriptionId,
                seats: 3,
                providerSeatItemId: seatItemId,
                currentPeriodEnd: '2026-10-01T00:00:00.000Z',
                cancelAtPeriodEnd: true,
                paymentMethodMeta: {
                    brand: 'a-card-brand',
                    last4: '4242',
                    fingerprint: 'fp_do_not_export',
                },
                organizationId: 'o1',
                createdAt: '2026-09-01T00:00:00.000Z',
            });

            expect(row).not.toHaveProperty('providerSubscriptionId');
            expect(row).not.toHaveProperty('providerSeatItemId');
            expect(row).not.toHaveProperty('paymentMethodMeta');
            expect(row).toEqual({
                id: 'us1',
                userId: 'u1',
                planCode: 'standard',
                planId: 'plan-standard',
                status: 'active',
                billingProvider: 'a-payment-provider',
                seats: 3,
                currentPeriodEnd: '2026-10-01T00:00:00.000Z',
                cancelAtPeriodEnd: true,
                organizationId: 'o1',
                createdAt: '2026-09-01T00:00:00.000Z',
            });
            expect(JSON.stringify(row)).not.toContain(subscriptionId);
            expect(JSON.stringify(row)).not.toContain(seatItemId);
        });

        it('exports a credit-ledger movement without the provider event id in its replay key', () => {
            // The ledger has no `providerEventId` column. The provider event
            // id is written into `idempotencyKey` — `{provider}:evt:{id}` on
            // a purchase or refund reversal, and behind `revoke:plan:` on a
            // plan-allowance clawback — so that is the column that goes.
            const eventId = 'evt_do_not_export_123';
            const clawback = redactRow('CreditLedgerEntry', {
                id: 'cl1',
                userId: 'u1',
                kind: 'adjustment',
                amountCredits: -3000,
                refType: 'plan-allowance',
                refId: 'us1',
                balanceAfter: -120,
                description: 'Plan allowance reversed after payment reversal',
                idempotencyKey: `revoke:plan:a-payment-provider:evt:${eventId}`,
                remainingCredits: null,
                expiresAt: null,
                createdAt: '2026-09-02T00:00:00.000Z',
            });

            expect(clawback).not.toHaveProperty('idempotencyKey');
            expect(clawback).toEqual({
                id: 'cl1',
                userId: 'u1',
                kind: 'adjustment',
                amountCredits: -3000,
                refType: 'plan-allowance',
                refId: 'us1',
                balanceAfter: -120,
                description: 'Plan allowance reversed after payment reversal',
                remainingCredits: null,
                expiresAt: null,
                createdAt: '2026-09-02T00:00:00.000Z',
            });
            expect(JSON.stringify(clawback)).not.toContain(eventId);

            const purchase = redactRow('CreditLedgerEntry', {
                id: 'cl2',
                kind: 'purchase',
                amountCredits: 1000,
                idempotencyKey: `a-payment-provider:evt:${eventId}`,
            });
            expect(purchase).toEqual({ id: 'cl2', kind: 'purchase', amountCredits: 1000 });
        });

        it('exports a tenant job-runtime config without the pointer to its credentials', () => {
            const row = redactRow('TenantJobRuntimeConfig', {
                id: 'c1',
                providerId: 'a-runtime',
                mode: 'byo',
                credentialsSecretRef: secretLiteral,
                credentialVersion: 4,
            });

            expect(row).toEqual({
                id: 'c1',
                providerId: 'a-runtime',
                mode: 'byo',
                credentialsSecretRef: { wasSet: true },
                credentialVersion: 4,
            });
        });

        it('exports a model account as which keys were set, never their values', () => {
            // The useful answer for an owner restoring elsewhere is "which
            // credentials do I have to re-enter?", so the field NAMES survive
            // and the values do not (spec FR-18.4).
            const row = redactRow('ModelAccount', {
                id: 'ma1',
                providerId: 'a-model-provider',
                enabled: true,
                credentials: { apiKey: secretLiteral, organizationId: secretLiteral },
                credentialVersion: 3,
                credentialExpiresAt: '2027-01-01T00:00:00.000Z',
            });

            expect(row).toEqual({
                id: 'ma1',
                providerId: 'a-model-provider',
                enabled: true,
                credentials: { apiKey: { wasSet: true }, organizationId: { wasSet: true } },
                credentialVersion: 3,
                credentialExpiresAt: '2027-01-01T00:00:00.000Z',
            });
            expect(JSON.stringify(row)).not.toContain(secretLiteral);
        });

        it('exports what a share link published, and none of the three forms of its token', () => {
            // A share token is a read capability: whoever holds it can open
            // the published view without signing in. So it leaves in none of
            // its forms — not the plaintext, not the `sha256(token)` the
            // public path looks up, not the encrypted envelope — while the
            // row that says WHAT was shared still exports.
            const row = redactRow('SharedView', {
                id: 'sv1',
                enabled: true,
                sections: ['board', 'activity'],
                allowIndexing: false,
                token: secretLiteral,
                tokenHash: 'c'.repeat(64),
                tokenEncrypted: { token: secretLiteral },
                tokenRotatedAt: '2026-09-01T00:00:00.000Z',
                viewCount: 12,
            });

            expect(row).toEqual({
                id: 'sv1',
                enabled: true,
                sections: ['board', 'activity'],
                allowIndexing: false,
                // A timestamp survives — it says when the link was rotated,
                // which is record, not capability.
                tokenRotatedAt: '2026-09-01T00:00:00.000Z',
                viewCount: 12,
            });
            expect(JSON.stringify(row)).not.toContain(secretLiteral);
            expect(JSON.stringify(row)).not.toContain('c'.repeat(64));
        });
    });

    describe('redactSecretBag', () => {
        it('reports a set field and an unset one differently', () => {
            expect(redactSecretBag({ present: 'x', absent: null })).toEqual({
                present: { wasSet: true },
                absent: { wasSet: false },
            });
        });

        it('returns an empty bag for anything that is not a plain object', () => {
            for (const value of [null, undefined, 'x', 3, ['a']]) {
                expect(redactSecretBag(value)).toEqual({});
            }
        });

        /**
         * The shape a bag column ACTUALLY gets, which is not always the one
         * `redactRow`'s comment promises.
         *
         * `BackupRowSource.page` reads with `getRawMany()` and `strip()` only
         * renames the `entity_` prefix off the keys — neither parses JSON. A
         * `simple-json` column is stored as text, so what reaches `redactRow`
         * is the JSON STRING, not an object, and the bag branch never runs:
         * the owner gets `{ wasSet: true }` and learns that something was set
         * but not WHICH fields to re-credential. A Postgres `json`/`jsonb`
         * column is parsed by the driver and does get the keyed bag. Same
         * rule, two shapes, decided by the column type and the driver.
         *
         * Pinned rather than fixed here: it fails CLOSED (less is published,
         * never more), and changing it means parsing untrusted stored text in
         * the redaction path, which is a decision with its own risks and not
         * one to make inside a guard change. EW-818.
         */
        it('gives a raw JSON string the opaque shape, not the keyed bag', () => {
            const raw = JSON.stringify({ apiKey: 'sk_live_x', region: 'eu' });

            // Same column, same rule, two shapes — decided entirely by whether
            // the value arrived parsed. The secret is gone from both; only the
            // KEY NAMES differ, and they are what tells an owner what to
            // re-credential.
            expect(redactRow('ModelAccount', { credentials: raw })).toEqual({
                credentials: { wasSet: true },
            });
            expect(redactRow('ModelAccount', { credentials: JSON.parse(raw) })).toEqual({
                credentials: { apiKey: { wasSet: true }, region: { wasSet: true } },
            });

            // And the EW-818 column behaves the same way, which is the point:
            // adding the rule closed the leak, it did not buy the key names.
            expect(redactRow('TenantEmailAddress', { providerSettings: raw })).toEqual({
                providerSettings: { wasSet: true },
            });
        });
    });

    describe('the exclusions list the manifest publishes', () => {
        it('names all nine categories of spec FR-18', () => {
            expect(BACKUP_EXCLUSIONS).toHaveLength(9);
        });
    });

    /**
     * THE GUARD. Everything above is a list of things someone remembered.
     * This is the part that catches the column nobody remembered.
     */
    describe('no secret-shaped column escapes without a decision', () => {
        const ENTITY_DIRS = [
            join(__dirname, '..', '..', 'entities'),
            join(__dirname, '..', '..', 'plugins', 'entities'),
            join(__dirname, '..', 'entities'),
        ];
        // Key MATERIAL is matched with its qualifier attached (`privateKey`,
        // `keyPem`, `passphrase`) and never as the bare substring `key` / `pem`.
        // Those were measured on 2026-09-18 against the 172 entity files / 3,114
        // declared properties in this package: a bare `key` adds 34 mandatory
        // decisions — every one of them an identifier (`dedupKey`,
        // `idempotencyKey`, `scopeKey`, `workspaceKey`…), with the single
        // key-material column in that set, `ApiKey.hashedKey`, already covered by
        // `hash` — and a bare `pem` fires on `domainTypeManuallySet` through
        // "tyPeManually". The anchored form below adds ZERO decisions to today's
        // 84 matching columns while still catching the shapes that matter
        // (`privateKeyPem`, `apiKey`, `signingKey`, `sshKey`, `passphrase`,
        // `certificatePem`). Widen the domain by measuring it, never by guessing.
        const SECRET_SHAPED =
            /secret|password|token|hash|credential|(private|secret|signing|encryption|api|access|auth|ssh|deploy)key|keypem|keypair|keymaterial|passphrase|pem$/i;
        /** Family 2 — envelope-encrypted at rest, said in the column name. */
        const ENCRYPTED_NAMED = /encrypted$/i;
        /** Family 3 — envelope-encrypted at rest, said only by the decorator. */
        const ENCRYPTED_DECORATOR = 'EncryptedJsonColumn';
        /**
         * Family 4 — a payment-provider handle on anything the `billing`
         * domain exports. The archive publishes a `payment_identifiers`
         * exclusion, so an id that addresses a live billing object needs a
         * rule.
         */
        const PAYMENT_IDENTIFIER = /^(?:provider|payg)[A-Za-z0-9_]*(?:Id|Ref)$/;
        /**
         * Rules in the per-entity column tables that name a column their
         * entity does not declare, each with the evidence that no identifier
         * is escaping through it. They are not deleted here — removing a rule
         * is a reviewed decision — but they are listed, so the existence
         * guard passes on purpose rather than by accident and any NEW stale
         * rule still fails it.
         */
        const KNOWN_STALE_COLUMN_RULES: Readonly<Record<string, string>> = Object.freeze({
            'SharedView.token':
                'Surfaced by scoping the extractor to the class body (EW-818): `token` is a field of the `SharedViewTokenEnvelope` INTERFACE declared above `export class SharedView`, not a column, and reading the whole file had been counting it as one. The entity stores `tokenHash` (a sha256 hex) and `tokenEncrypted` (an `@EncryptedJsonColumn`, so family 3 covers it); the plaintext token is never on the row. So the rule protects nothing and nothing escapes through it.',
            'Invoice.providerCustomerId':
                'The invoice mirror has never had a customer column: the creating migration (1784300000000-CreateBillingProfilesAndInvoices) gives `invoices` only `provider` and `providerInvoiceId`, and a mirrored invoice is attributed through `userId`. The provider customer id lives on `BillingProfile`, where it is dropped.',
            'UsageLedgerEntry.providerMeterId':
                'The usage ledger stores no provider handle: `UsageLedgerService.recordUsage` writes `metadata: { cadence }` and nothing else, and `BillingProvider.recordUsageCharge` is a no-op on every provider, so no meter or event id ever comes back to store. Metered usage reported to the provider is mirrored in `CreditMeterEvent`, which never enters an archive.',
            'UsageLedgerEntry.providerEventId':
                'Same evidence as `UsageLedgerEntry.providerMeterId`: no writer puts a provider id on a usage-ledger row, and the entity has never declared one.',
        });
        // `    someColumn?: Type` / `    someColumn: Type` — the property
        // declarations TypeORM turns into columns. Relations and methods do
        // not match, and neither do commented-out lines. The declared type is
        // captured too, because family 5 below is about the TYPE, not the name.
        const PROPERTY = /^\s{4}(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??\s*:\s*(.*)$/;
        /**
         * Family 5 — a free-form bag. `Record<string, unknown>` is the type
         * the codebase uses for "whatever the caller sent", and a caller who
         * can put anything in can put a credential in. Families 1–4 all read
         * a NAME or a DECORATOR, so none of them can see one:
         * `TenantEmailAddress.providerSettings` is a plain `simple-json`
         * column, documented as holding a webhook secret, and it shipped to
         * `data/communication/email-addresses.jsonl` in the clear through
         * every one of them (EW-818).
         *
         * A declared interface or DTO is NOT this — someone chose those
         * fields and can be asked about them. This family is only for the
         * columns where nobody chose.
         */
        const FREE_FORM_RECORD = /Record<\s*string\s*,\s*(?:unknown|any)\s*>/;
        /** `    @SomeDecorator` / `    @SomeDecorator({ … })` on its own line. */
        const DECORATOR = /^\s{4}@([A-Za-z_][A-Za-z0-9_]*)/;

        interface EntityProperty {
            readonly entity: string;
            readonly column: string;
            readonly file: string;
            /** Decorators attached to this property, nearest-first. */
            readonly decorators: readonly string[];
            /** The declared type, as written — what family 5 reads. */
            readonly type: string;
        }

        /**
         * Every property declaration in every entity source, WITH the
         * decorators that sit above it. Reading the decorators is what makes
         * the `@EncryptedJsonColumn` family possible at all: those column
         * names (`envFiles`, `targetConfig`, `authHeaders`, `credentials`)
         * say nothing about what is inside them.
         */
        function collectProperties(): EntityProperty[] {
            const found: EntityProperty[] = [];
            for (const dir of ENTITY_DIRS) {
                let files: string[];
                try {
                    files = readdirSync(dir).filter((name) => name.endsWith('.entity.ts'));
                } catch {
                    continue;
                }
                for (const file of files) {
                    const source = readFileSync(join(dir, file), 'utf8');
                    const entityMatch = /export class ([A-Za-z0-9_]+)/.exec(source);
                    if (!entityMatch) continue;
                    const entity = entityMatch[1];
                    let pending: string[] = [];
                    // Only the CLASS BODY. An entity file routinely declares the
                    // interfaces its JSON columns are typed with ABOVE the class, at
                    // the same indentation, and reading the whole file attributed
                    // those to the entity — inventing columns that do not exist.
                    // `GoalMetricSource.params` is an interface field 245 lines above
                    // `export class Goal`; it arrived here as `Goal.params` and was
                    // very nearly given a redaction rule, which would have protected
                    // nothing. That is precisely the failure
                    // `KNOWN_STALE_COLUMN_RULES` exists to record, arriving through
                    // the guard itself. Anything after the class's closing brace is
                    // excluded for the same reason.
                    let insideClass = false;
                    for (const line of source.split('\n')) {
                        if (!insideClass) {
                            if (/^export class [A-Za-z0-9_]+/.test(line)) insideClass = true;
                            continue;
                        }
                        if (line === '}') break;
                        const decorator = DECORATOR.exec(line);
                        if (decorator) {
                            pending.unshift(decorator[1]);
                            continue;
                        }
                        const property = PROPERTY.exec(line);
                        if (!property) continue;
                        found.push({
                            entity,
                            column: property[1],
                            file,
                            decorators: pending,
                            type: property[2],
                        });
                        pending = [];
                    }
                }
            }
            return found;
        }

        function collectColumns(): Array<{ entity: string; column: string; file: string }> {
            return collectProperties()
                .filter(({ column }) => SECRET_SHAPED.test(column))
                .map(({ entity, column, file }) => ({ entity, column, file }));
        }

        /** Columns with no rule, no drop and no reviewed exemption. */
        function unhandled(properties: readonly EntityProperty[]): string[] {
            return [
                ...new Set(
                    properties
                        .filter(({ entity, column }) => {
                            if (shouldDropEntirely(entity)) return false;
                            if (isDroppedColumn(entity, column)) return false;
                            if (isRedactedColumn(entity, column)) return false;
                            if (isBenignColumn(column)) return false;
                            // The per-ENTITY exemption, for names like
                            // `metadata` that appear on ten exported entities
                            // and must not be waved through on all of them at
                            // once.
                            if (isBenignEntityColumn(entity, column)) return false;
                            return true;
                        })
                        .map(({ entity, column }) => `${entity}.${column}`),
                ),
            ];
        }

        it('finds the entity sources at all (a silent zero here would make this guard useless)', () => {
            const columns = collectColumns();
            expect(columns.length).toBeGreaterThan(20);
        });

        it('has a rule or a reviewed exemption for every secret-shaped column', () => {
            // If this fails, decide in `redaction.ts`: drop the row, redact
            // the value to { wasSet }, delete the column, or add it to
            // BACKUP_BENIGN_COLUMNS with the reason it carries no secret.
            expect(
                unhandled(collectProperties().filter((p) => SECRET_SHAPED.test(p.column))),
            ).toEqual([]);
        });

        it('has a rule for every column whose name says it is encrypted at rest', () => {
            const encrypted = collectProperties().filter((p) => ENCRYPTED_NAMED.test(p.column));

            // A silent zero would make the family useless.
            expect(encrypted.length).toBeGreaterThan(5);
            // `Work.deployDatabaseUrlEncrypted` and
            // `Work.deployRuntimeEnvEncrypted` are the two this family was
            // added for; both must be in the reflected set.
            expect(encrypted.map((p) => `${p.entity}.${p.column}`)).toEqual(
                expect.arrayContaining([
                    'Work.deployDatabaseUrlEncrypted',
                    'Work.deployRuntimeEnvEncrypted',
                ]),
            );
            expect(unhandled(encrypted)).toEqual([]);
        });

        it('has a rule for every @EncryptedJsonColumn, whatever the column is called', () => {
            const encrypted = collectProperties().filter((p) =>
                p.decorators.includes(ENCRYPTED_DECORATOR),
            );

            // Six entities use the decorator today. A zero here would mean
            // the decorator scan stopped matching, not that the risk went
            // away, so the count is asserted rather than assumed.
            expect(encrypted.length).toBeGreaterThanOrEqual(5);
            expect(encrypted.map((p) => `${p.entity}.${p.column}`)).toEqual(
                expect.arrayContaining([
                    'RepoConnection.envFiles',
                    'NotificationChannel.targetConfig',
                ]),
            );
            expect(unhandled(encrypted)).toEqual([]);
        });

        it('has a rule or a reviewed exemption for every free-form record column', () => {
            // Scoped to the entities the archive actually exports. A
            // free-form bag on a table nobody backs up is not this guard's
            // business, and widening it to every entity in the repo would
            // bury the ones that matter in noise.
            const exported = new Set(
                BACKUP_DOMAIN_SPECS.flatMap((domain) => domain.files.map((file) => file.entity)),
            );
            const bags = collectProperties().filter(
                (p) => exported.has(p.entity) && FREE_FORM_RECORD.test(p.type),
            );

            // A silent zero would make the family useless — and unlike the
            // others, this one reads a regex against the declared TYPE, which
            // a formatter could reflow onto the next line. If this count
            // collapses, the extractor broke, not the risk.
            expect(bags.length).toBeGreaterThan(15);
            expect(bags.map((p) => `${p.entity}.${p.column}`)).toEqual(
                expect.arrayContaining(['TenantEmailAddress.providerSettings']),
            );

            // If this fails, decide in `redaction.ts`: redact the value to
            // `{ wasSet }` (keeps the field NAMES, which is what tells an
            // owner what to re-credential), drop the column, or add it to
            // BACKUP_BENIGN_COLUMNS with the reason it cannot carry a secret.
            expect(unhandled(bags)).toEqual([]);
        });

        it('has a rule for every payment-provider identifier in the billing domain', () => {
            // The entity set comes from the archive's own domain table, so a
            // billing entity added to the archive is covered the day it is.
            const billingDomain = BACKUP_DOMAIN_SPECS.find((domain) => domain.key === 'billing');
            expect(billingDomain).toBeDefined();
            const billingEntities = [...new Set(billingDomain.files.map((file) => file.entity))];
            expect(billingEntities).toEqual(
                expect.arrayContaining(['BillingProfile', 'UserSubscription']),
            );

            // Guard the guard: an entity the domain names but the reflection
            // cannot find would make this family silently see less. A moved
            // or renamed entity file has to fail here instead.
            const properties = collectProperties();
            const reflected = new Set(properties.map((p) => p.entity));
            expect(billingEntities.filter((entity) => !reflected.has(entity))).toEqual([]);

            const inBillingDomain = new Set(billingEntities);
            const identifiers = properties.filter(
                (p) => inBillingDomain.has(p.entity) && PAYMENT_IDENTIFIER.test(p.column),
            );

            expect(identifiers.map((p) => `${p.entity}.${p.column}`)).toEqual(
                expect.arrayContaining([
                    'BillingProfile.paygSubscriptionId',
                    'BillingProfile.paygSubscriptionItemId',
                    'UserSubscription.providerSubscriptionId',
                    'UserSubscription.providerSeatItemId',
                ]),
            );
            expect(unhandled(identifiers)).toEqual([]);
        });

        /**
         * The per-entity column tables in `redaction.ts`, read from its
         * source with the compiler rather than a regex, so a comment or a
         * reformat cannot hide an entry. They are read rather than exported
         * because the module's runtime exports are the pinned public surface
         * of the account-transfer barrel, and an accessor that exists only
         * for a test does not belong there.
         */
        function readColumnRules(
            table: 'ENTITY_DROPPED_COLUMNS' | 'ENTITY_SECRET_COLUMNS',
        ): Array<{ entity: string; column: string }> {
            const path = join(__dirname, 'redaction.ts');
            const source = ts.createSourceFile(
                path,
                readFileSync(path, 'utf8'),
                ts.ScriptTarget.Latest,
                true,
            );
            const unfreeze = (node: ts.Expression | undefined): ts.Expression | undefined =>
                node &&
                ts.isCallExpression(node) &&
                node.expression.getText(source) === 'Object.freeze'
                    ? node.arguments[0]
                    : node;
            const nameOf = (name: ts.PropertyName): string => {
                if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
                throw new Error(`${table}: unreadable key ${name.getText(source)}`);
            };

            let literal: ts.ObjectLiteralExpression | undefined;
            const visit = (node: ts.Node): void => {
                if (
                    ts.isVariableDeclaration(node) &&
                    ts.isIdentifier(node.name) &&
                    node.name.text === table
                ) {
                    const initializer = unfreeze(node.initializer);
                    if (initializer && ts.isObjectLiteralExpression(initializer)) {
                        literal = initializer;
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(source);
            if (!literal) {
                throw new Error(`${table} is no longer an object literal in redaction.ts`);
            }

            const rules: Array<{ entity: string; column: string }> = [];
            for (const property of literal.properties) {
                if (!ts.isPropertyAssignment(property)) {
                    throw new Error(`${table}: unreadable entry ${property.getText(source)}`);
                }
                const entity = nameOf(property.name);
                const columns = unfreeze(property.initializer);
                if (!columns || !ts.isArrayLiteralExpression(columns)) {
                    throw new Error(`${table}.${entity} is no longer an array literal`);
                }
                for (const element of columns.elements) {
                    if (!ts.isStringLiteral(element)) {
                        throw new Error(
                            `${table}.${entity}: non-literal ${element.getText(source)}`,
                        );
                    }
                    rules.push({ entity, column: element.text });
                }
            }
            return rules;
        }

        function allColumnRules(): string[] {
            return [
                ...readColumnRules('ENTITY_DROPPED_COLUMNS'),
                ...readColumnRules('ENTITY_SECRET_COLUMNS'),
            ].map(({ entity, column }) => `${entity}.${column}`);
        }

        it('reads the same per-entity column rules the module applies', () => {
            // The existence guard below trusts this reader, so prove it agrees
            // with the running module rather than assuming it does.
            const dropped = readColumnRules('ENTITY_DROPPED_COLUMNS');
            const redacted = readColumnRules('ENTITY_SECRET_COLUMNS');

            expect(dropped.length).toBeGreaterThan(20);
            expect(redacted.length).toBeGreaterThanOrEqual(5);
            expect(dropped.filter((r) => !isDroppedColumn(r.entity, r.column))).toEqual([]);
            expect(redacted.filter((r) => !isRedactedColumn(r.entity, r.column))).toEqual([]);
            expect(dropped.map((r) => `${r.entity}.${r.column}`)).toEqual(
                expect.arrayContaining([
                    'User.password',
                    'BillingProfile.providerCustomerId',
                    'UserSubscription.providerSubscriptionId',
                    'UserSubscription.providerSeatItemId',
                ]),
            );
            expect(redacted.map((r) => `${r.entity}.${r.column}`)).toEqual(
                expect.arrayContaining(['RepoConnection.envFiles', 'ModelAccount.credentials']),
            );
        });

        it('names a column the entity really declares, in every per-entity column rule', () => {
            // A rule on a column that does not exist deletes nothing, and
            // nothing else notices — so an identifier whose column is renamed
            // loses its protection silently. If this fails, find where the
            // value really lives and point the rule there; only a rule with
            // evidence that nothing escapes may go in KNOWN_STALE_COLUMN_RULES.
            const declared = new Set(collectProperties().map((p) => `${p.entity}.${p.column}`));
            const missing = allColumnRules().filter(
                (rule) =>
                    !declared.has(rule) &&
                    !Object.prototype.hasOwnProperty.call(KNOWN_STALE_COLUMN_RULES, rule),
            );

            expect(missing).toEqual([]);
        });

        it('names a declared column and gives a reason, in every per-entity exemption', () => {
            // BACKUP_BENIGN_ENTITY_COLUMNS is the only table here that lets a
            // value through UNCHANGED, so it gets the strictest guard: the
            // entity must be one the archive exports, the column must be
            // declared on it, and the reason must be a real sentence rather
            // than a placeholder. An exemption pointing at a renamed column
            // would otherwise sit there looking like a decision while the
            // column it was written for goes out unguarded under its new name.
            const declared = new Set(collectProperties().map((p) => `${p.entity}.${p.column}`));
            const exported = new Set(
                BACKUP_DOMAIN_SPECS.flatMap((domain) => domain.files.map((file) => file.entity)),
            );

            const problems: string[] = [];
            for (const [entity, columns] of Object.entries(BACKUP_BENIGN_ENTITY_COLUMNS)) {
                if (!exported.has(entity)) {
                    problems.push(`${entity}: exempted but the archive does not export it`);
                }
                for (const [column, reason] of Object.entries(columns)) {
                    if (!declared.has(`${entity}.${column}`)) {
                        problems.push(`${entity}.${column}: not declared on that entity`);
                    }
                    if (reason.trim().length < 20) {
                        problems.push(`${entity}.${column}: reason is not a reason`);
                    }
                }
            }

            expect(problems).toEqual([]);
        });

        it('keeps the known-stale list to rules that are still rules and still stale', () => {
            // The allow-list may not outlive its evidence. An entry whose rule
            // is gone, or whose column now exists, has to come out of it.
            const declared = new Set(collectProperties().map((p) => `${p.entity}.${p.column}`));
            const rules = new Set(allColumnRules());
            const entries = Object.entries(KNOWN_STALE_COLUMN_RULES);

            expect(entries.filter(([rule]) => !rules.has(rule) || declared.has(rule))).toEqual([]);
            expect(entries.filter(([, reason]) => reason.length <= 10)).toEqual([]);
        });

        it('fails on a newly introduced secret column that no rule covers', () => {
            // The guard's own guard: prove the predicate chain actually says
            // "no" to something it has never seen.
            const entity = 'SomeFutureEntity';
            const column = 'fooSecretValue';
            expect(SECRET_SHAPED.test(column)).toBe(true);
            expect(shouldDropEntirely(entity)).toBe(false);
            expect(isDroppedColumn(entity, column)).toBe(false);
            expect(isRedactedColumn(entity, column)).toBe(false);
            expect(isBenignColumn(column)).toBe(false);
        });

        it('catches key material while ignoring identifier keys and pem false-friends', () => {
            // The pattern's domain is a decision, so pin it: a future widening
            // that re-admits bare `key` / `pem` has to argue with this test.
            for (const column of [
                'privateKeyPem',
                'apiKey',
                'signingKey',
                'encryptionKey',
                'sshKey',
                'deployKeyMaterial',
                'passphrase',
                'certificatePem',
            ]) {
                expect([column, SECRET_SHAPED.test(column)]).toEqual([column, true]);
            }
            for (const column of [
                'dedupKey',
                'idempotencyKey',
                'scopeKey',
                'threadKey',
                'externalKey',
                'storageKey',
                'monkeyBusiness',
                'domainTypeManuallySet',
            ]) {
                expect([column, SECRET_SHAPED.test(column)]).toEqual([column, false]);
            }
        });

        it('fails on a future @EncryptedJsonColumn whose name looks harmless', () => {
            // The third family's own guard. `campaignPayload` matches no name
            // shape at all — which is exactly the situation `envFiles` and
            // `targetConfig` were in — so the decorator has to be what
            // demands a decision.
            const entity = 'SomeFutureEntity';
            const column = 'campaignPayload';
            expect(SECRET_SHAPED.test(column)).toBe(false);
            expect(ENCRYPTED_NAMED.test(column)).toBe(false);
            expect(
                unhandled([
                    {
                        entity,
                        column,
                        file: 'x.entity.ts',
                        decorators: ['EncryptedJsonColumn'],
                        // A declared shape, deliberately: this fixture is the
                        // third family's guard, and a free-form type would
                        // make family 5 catch it instead and prove nothing.
                        type: 'CampaignPayload',
                    },
                ]),
            ).toEqual([`${entity}.${column}`]);
        });

        it('gives every benign exemption a stated reason', () => {
            for (const [column, reason] of Object.entries(BACKUP_BENIGN_COLUMNS)) {
                expect(reason.length).toBeGreaterThan(10);
            }
        });
    });
});
