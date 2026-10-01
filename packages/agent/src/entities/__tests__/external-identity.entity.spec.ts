import { DataSource } from 'typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { AGENT_ENTITY_NAMES } from '../../database/_entity-names';
import { BACKUP_DROPPED_ENTITIES } from '../../account-transfer/backup/redaction';
import { AuthSession } from '../auth-session.entity';
import { ExternalIdentity } from '../external-identity.entity';
import * as entitiesBarrel from '../index';

/**
 * APW-12 (Ever ID) — the `ExternalIdentity` entity and the two `session` columns
 * (plan §3.1, §3.2), read off TypeORM's own metadata so a drift between the
 * entity and the plan's table fails here.
 */
describe('ExternalIdentity entity', () => {
    let dataSource: DataSource;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: false,
        });
        await dataSource.initialize();
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    it('is registered in the entity barrel, the name list and the ENTITIES inventory', () => {
        expect((entitiesBarrel as Record<string, unknown>).ExternalIdentity).toBe(ExternalIdentity);
        expect(AGENT_ENTITY_NAMES).toContain('ExternalIdentity');
        expect(ENTITIES).toContain(ExternalIdentity);
    });

    it('is never exported in a workspace backup (an identity link is a sign-in binding)', () => {
        expect(BACKUP_DROPPED_ENTITIES).toContain('ExternalIdentity');
    });

    it('maps to `external_identities` with exactly the FR-31 columns — no token column', () => {
        const metadata = dataSource.getMetadata(ExternalIdentity);
        expect(metadata.tableName).toBe('external_identities');
        expect(metadata.columns.map((column) => column.propertyName).sort()).toEqual(
            [
                'createdAt',
                'delegatedClients',
                'emailAtLink',
                'emailVerifiedAtLink',
                'id',
                'issuer',
                'lastLoginAt',
                'linkedAt',
                'linkedVia',
                'subject',
                'tenantId',
                'updatedAt',
                'userId',
            ].sort(),
        );
        const lengths = Object.fromEntries(
            metadata.columns.map((column) => [column.propertyName, column.length]),
        );
        expect(lengths).toMatchObject({
            issuer: '512',
            subject: '255',
            emailAtLink: '320',
            linkedVia: '16',
        });
    });

    it('declares the two linking rules as named unique constraints and the user index', () => {
        const metadata = dataSource.getMetadata(ExternalIdentity);
        const uniques = metadata.uniques.map((unique) => ({
            name: unique.name,
            columns: unique.columns.map((column) => column.propertyName),
        }));
        expect(uniques).toEqual(
            expect.arrayContaining([
                { name: 'uq_external_identities_issuer_subject', columns: ['issuer', 'subject'] },
                { name: 'uq_external_identities_user_issuer', columns: ['userId', 'issuer'] },
            ]),
        );
        expect(metadata.indices.map((index) => index.name)).toContain(
            'idx_external_identities_user',
        );
    });

    it('cascades the delete of its account (FR-30)', () => {
        const relation = dataSource
            .getMetadata(ExternalIdentity)
            .relations.find((candidate) => candidate.propertyName === 'user');
        expect(relation?.onDelete).toBe('CASCADE');
    });

    it('adds two nullable, indexed, foreign-key-free columns to `session` (plan §3.2)', () => {
        const metadata = dataSource.getMetadata(AuthSession);
        const identity = metadata.findColumnWithPropertyName('externalIdentityId');
        const sid = metadata.findColumnWithPropertyName('externalSid');
        expect(identity?.isNullable).toBe(true);
        expect(sid?.isNullable).toBe(true);
        expect(sid?.length).toBe('255');
        expect(metadata.indices.map((index) => index.name)).toEqual(
            expect.arrayContaining(['idx_session_external_identity', 'idx_session_external_sid']),
        );
        expect(metadata.foreignKeys).toHaveLength(0);
    });
});
