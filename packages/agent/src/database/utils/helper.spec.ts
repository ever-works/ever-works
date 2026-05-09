import { getTlsOptions, parseDatabaseUrl } from './helper';

describe('database/utils/helper', () => {
    let consoleErrorSpy: jest.SpyInstance;

    beforeEach(() => {
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('getTlsOptions', () => {
        it('returns undefined when SSL mode is disabled', () => {
            expect(getTlsOptions(false, undefined)).toBeUndefined();
            expect(consoleErrorSpy).not.toHaveBeenCalled();
        });

        it('returns undefined and short-circuits before reading the cert when SSL mode is disabled even with a cert provided', () => {
            const result = getTlsOptions(false, 'aGVsbG8=');
            expect(result).toBeUndefined();
            expect(consoleErrorSpy).not.toHaveBeenCalled();
        });

        it('logs an error and returns undefined when SSL mode is enabled but no CA cert is provided', () => {
            expect(getTlsOptions(true, undefined)).toBeUndefined();
            expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                'DATABASE_CA_CERT is not defined. TLS options cannot be configured.',
            );
        });

        it('logs the same error and returns undefined when caCertBase64 is the empty string (falsy)', () => {
            expect(getTlsOptions(true, '')).toBeUndefined();
            expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
            expect(consoleErrorSpy).toHaveBeenCalledWith(
                'DATABASE_CA_CERT is not defined. TLS options cannot be configured.',
            );
        });

        it('decodes a valid base64 cert into the rejectUnauthorized + ca shape', () => {
            // "hello" → base64 "aGVsbG8="
            const result = getTlsOptions(true, 'aGVsbG8=');
            expect(result).toEqual({
                rejectUnauthorized: true,
                ca: 'hello',
            });
            expect(consoleErrorSpy).not.toHaveBeenCalled();
        });

        it('decodes a multi-line PEM cert preserving newlines', () => {
            const pem =
                '-----BEGIN CERTIFICATE-----\nMIIBhTCCASugAwIBAgIQ\n-----END CERTIFICATE-----\n';
            const encoded = Buffer.from(pem, 'ascii').toString('base64');
            const result = getTlsOptions(true, encoded);
            expect(result).toEqual({
                rejectUnauthorized: true,
                ca: pem,
            });
            expect(consoleErrorSpy).not.toHaveBeenCalled();
        });

        it('catches Buffer-decode failures and logs an error returning undefined', () => {
            const fromSpy = jest.spyOn(Buffer, 'from').mockImplementation(() => {
                throw new Error('boom');
            });
            try {
                expect(getTlsOptions(true, 'aGVsbG8=')).toBeUndefined();
                expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
                expect(consoleErrorSpy).toHaveBeenCalledWith(
                    'Error decoding DATABASE_CA_CERT:',
                    'boom',
                );
            } finally {
                fromSpy.mockRestore();
            }
        });
    });

    describe('parseDatabaseUrl', () => {
        it('parses a fully-qualified PostgreSQL URL into all fields', () => {
            const result = parseDatabaseUrl('postgres://user:pass@host:5432/mydb?ssl=true');
            expect(result).toEqual({
                protocol: 'postgres',
                username: 'user',
                password: 'pass',
                host: 'host',
                port: 5432,
                database: 'mydb',
                searchParams: { ssl: 'true' },
            });
        });

        it('returns undefined port when the URL has no explicit port', () => {
            const result = parseDatabaseUrl('postgres://user:pass@host/mydb');
            expect(result).toEqual({
                protocol: 'postgres',
                username: 'user',
                password: 'pass',
                host: 'host',
                port: undefined,
                database: 'mydb',
                searchParams: {},
            });
        });

        it('parses a MySQL URL', () => {
            const result = parseDatabaseUrl('mysql://root:@localhost:3306/ever_works');
            expect(result).toEqual({
                protocol: 'mysql',
                username: 'root',
                password: '',
                host: 'localhost',
                port: 3306,
                database: 'ever_works',
                searchParams: {},
            });
        });

        it('captures multiple search params', () => {
            const result = parseDatabaseUrl(
                'postgres://u:p@host:5432/db?ssl=true&sslmode=require&pool=20',
            );
            expect(result).toEqual({
                protocol: 'postgres',
                username: 'u',
                password: 'p',
                host: 'host',
                port: 5432,
                database: 'db',
                searchParams: {
                    ssl: 'true',
                    sslmode: 'require',
                    pool: '20',
                },
            });
        });

        it('returns an empty database string when the path is just a slash', () => {
            const result = parseDatabaseUrl('postgres://u:p@host:5432/');
            expect(result?.database).toBe('');
        });

        it('strips the trailing colon from the protocol', () => {
            const result = parseDatabaseUrl('postgres://u:p@host:5432/db');
            expect(result?.protocol).toBe('postgres');
        });

        it('returns null for an invalid URL', () => {
            expect(parseDatabaseUrl('not a url at all')).toBeNull();
        });

        it('returns null for the empty string', () => {
            expect(parseDatabaseUrl('')).toBeNull();
        });

        it('handles URL-encoded credentials by passing them through verbatim from URL parser', () => {
            // The URL parser keeps username/password URL-encoded as-is — the
            // caller is responsible for decoding (this test pins that
            // current behaviour so a future decodeURIComponent change is
            // a deliberate one).
            const result = parseDatabaseUrl('postgres://us%40er:p%40ss@host:5432/db');
            expect(result?.username).toBe('us%40er');
            expect(result?.password).toBe('p%40ss');
        });
    });
});
