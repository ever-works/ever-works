import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ENTITIES } from '@ever-works/agent/database';
import { AuthSession, ExternalIdentity } from '@ever-works/agent/entities';

/** An in-memory database with every entity (relations are not seeded: keys off). */
export async function createIdentityDataSource(): Promise<DataSource> {
    const dataSource = new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: ENTITIES,
        synchronize: true,
        logging: false,
    });
    await dataSource.initialize();
    await dataSource.query('PRAGMA foreign_keys = OFF');
    return dataSource;
}

/** A connected identity of one local account. */
export function insertIdentity(
    dataSource: DataSource,
    values: {
        userId?: string;
        issuer: string;
        subject: string;
        linkedVia?: 'sign-up' | 'settings' | 'provisioning';
        tenantId?: string | null;
    },
): Promise<ExternalIdentity> {
    const repository = dataSource.getRepository(ExternalIdentity);
    return repository.save(
        repository.create({
            userId: values.userId ?? randomUUID(),
            issuer: values.issuer,
            subject: values.subject,
            emailAtLink: 'person@example.test',
            emailVerifiedAtLink: true,
            linkedVia: values.linkedVia ?? 'settings',
            linkedAt: new Date(),
            tenantId: values.tenantId ?? null,
        }),
    );
}

/** A session the identity opened. */
export function insertSession(
    dataSource: DataSource,
    identity: ExternalIdentity,
): Promise<AuthSession> {
    const repository = dataSource.getRepository(AuthSession);
    return repository.save(
        repository.create({
            id: randomUUID(),
            userId: identity.userId,
            token: randomUUID(),
            expiresAt: new Date(Date.now() + 3_600_000),
            externalIdentityId: identity.id,
        } as Partial<AuthSession>),
    );
}
