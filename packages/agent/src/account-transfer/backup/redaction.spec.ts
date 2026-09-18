import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    BACKUP_BENIGN_COLUMNS,
    BACKUP_DROPPED_ENTITIES,
    BACKUP_EXCLUSIONS,
    isBenignColumn,
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
 *  2. A reflection pass over the entity sources that fails when a
 *     secret-shaped column has no rule and no reviewed exemption.
 *
 * Half 2 is the one that matters in a year: it is what makes a new
 * `fooSecretEncrypted` column on a new entity a failing test rather than a
 * quiet leak into everybody's downloaded backup.
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

        it('keeps the NAMES of a plugin’s secret settings and none of their values', () => {
            const row = redactRow('UserPluginEntity', {
                id: 'up1',
                pluginId: 'some-provider',
                settings: { model: 'default' },
                secretSettings: { apiKey: secretLiteral, organizationKey: secretLiteral },
            });

            expect(row).toEqual({
                id: 'up1',
                pluginId: 'some-provider',
                settings: { model: 'default' },
                // The names are exactly what tells an owner which connections
                // will need a credential re-entered after a restore.
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
            });

            expect(row).toEqual({ id: 'b1', provider: 'a-payment-provider', status: 'active' });
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
        // `    someColumn?: Type` / `    someColumn: Type` — the property
        // declarations TypeORM turns into columns. Relations and methods do
        // not match, and neither do commented-out lines.
        const PROPERTY = /^\s{4}(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)\??\s*:/;

        function collectColumns(): Array<{ entity: string; column: string; file: string }> {
            const found: Array<{ entity: string; column: string; file: string }> = [];
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
                    for (const line of source.split('\n')) {
                        const property = PROPERTY.exec(line);
                        if (!property) continue;
                        const column = property[1];
                        if (!SECRET_SHAPED.test(column)) continue;
                        found.push({ entity, column, file });
                    }
                }
            }
            return found;
        }

        it('finds the entity sources at all (a silent zero here would make this guard useless)', () => {
            const columns = collectColumns();
            expect(columns.length).toBeGreaterThan(20);
        });

        it('has a rule or a reviewed exemption for every secret-shaped column', () => {
            const unhandled = collectColumns()
                .filter(({ entity, column }) => {
                    if (shouldDropEntirely(entity)) return false;
                    if (isDroppedColumn(entity, column)) return false;
                    if (isRedactedColumn(entity, column)) return false;
                    if (isBenignColumn(column)) return false;
                    return true;
                })
                .map(({ entity, column }) => `${entity}.${column}`);

            // If this fails, decide in `redaction.ts`: drop the row, redact
            // the value to { wasSet }, delete the column, or add it to
            // BACKUP_BENIGN_COLUMNS with the reason it carries no secret.
            expect([...new Set(unhandled)]).toEqual([]);
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

        it('gives every benign exemption a stated reason', () => {
            for (const [column, reason] of Object.entries(BACKUP_BENIGN_COLUMNS)) {
                expect(reason.length).toBeGreaterThan(10);
            }
        });
    });
});
