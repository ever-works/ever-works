import { pgClientOptions, summarizeDbProvisionError } from './ever-works-db-provision.service';

describe('summarizeDbProvisionError', () => {
    it('maps Node network errno codes to a label + code and drops the host', () => {
        const err = Object.assign(new Error('connect ECONNREFUSED 10.0.0.12:5432'), {
            code: 'ECONNREFUSED',
        });
        const out = summarizeDbProvisionError(err);
        expect(out).toBe('connection refused [ECONNREFUSED]');
        expect(out).not.toContain('10.0.0.12');
    });

    it('maps Postgres SQLSTATEs (auth / privilege) without echoing the message', () => {
        expect(
            summarizeDbProvisionError(
                Object.assign(new Error('password authentication failed for user "ewadmin"'), {
                    code: '28P01',
                }),
            ),
        ).toBe('password authentication failed [28P01]');
        expect(
            summarizeDbProvisionError(
                Object.assign(new Error('permission denied to create database'), { code: '42501' }),
            ),
        ).toContain('[42501]');
    });

    it('falls back to the bare code, then to message classes, then to unknown', () => {
        expect(summarizeDbProvisionError(Object.assign(new Error('x'), { code: 'XX000' }))).toBe(
            'error code XX000',
        );
        expect(
            summarizeDbProvisionError(new Error('Connection terminated due to connection timeout')),
        ).toBe('connection timed out');
        expect(
            summarizeDbProvisionError(new Error('self signed certificate in certificate chain')),
        ).toBe('TLS certificate rejected');
        expect(
            summarizeDbProvisionError(new Error('The server does not support SSL connections')),
        ).toBe('TLS negotiation failed');
        expect(summarizeDbProvisionError(new Error('something odd at db.internal'))).toBe(
            'unknown error',
        );
        expect(summarizeDbProvisionError(null)).toBe('unknown error');
    });
});

describe('pgClientOptions', () => {
    it('strips sslmode=require from the URL and disables CA verification (libpq semantics)', () => {
        const out = pgClientOptions(
            'postgresql://u:p@pg-rw.databases.svc.cluster.local:5432/postgres?sslmode=require',
        );
        expect(out.connectionString).toBe(
            'postgresql://u:p@pg-rw.databases.svc.cluster.local:5432/postgres',
        );
        expect(out.ssl).toEqual({ rejectUnauthorized: false });
    });

    it('keeps other query params and handles sslmode in the middle of the query', () => {
        const out = pgClientOptions(
            'postgresql://u:p@h:5432/db?application_name=x&sslmode=prefer&connect_timeout=5',
        );
        expect(out.connectionString).toBe(
            'postgresql://u:p@h:5432/db?application_name=x&connect_timeout=5',
        );
        expect(out.ssl).toEqual({ rejectUnauthorized: false });
    });

    it('keeps full verification for verify-ca / verify-full', () => {
        expect(pgClientOptions('postgresql://u:p@h/db?sslmode=verify-full').ssl).toEqual({
            rejectUnauthorized: true,
        });
        expect(pgClientOptions('postgresql://u:p@h/db?sslmode=verify-ca').ssl).toEqual({
            rejectUnauthorized: true,
        });
    });

    it('leaves URLs without sslmode (or disable) untouched and unencrypted', () => {
        expect(pgClientOptions('postgresql://u:p@h/db')).toEqual({
            connectionString: 'postgresql://u:p@h/db',
            ssl: undefined,
        });
        expect(pgClientOptions('postgresql://u:p@h/db?sslmode=disable').ssl).toBeUndefined();
    });
});
