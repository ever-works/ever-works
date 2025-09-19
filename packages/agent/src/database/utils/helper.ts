import type { TlsOptions } from 'tls';

/**
 * Gets TLS options for a database connection based on the provided SSL mode.
 */
export const getTlsOptions = (
    dbSslMode: boolean,
    caCertBase64: string | undefined,
): TlsOptions | undefined => {
    if (!dbSslMode) {
        return undefined;
    }

    if (!caCertBase64) {
        console.error('DATABASE_CA_CERT is not defined. TLS options cannot be configured.');
        return undefined;
    }

    try {
        const buff = Buffer.from(caCertBase64, 'base64');
        const sslCert = buff.toString('ascii');

        return {
            rejectUnauthorized: true,
            ca: sslCert,
        };
    } catch (error) {
        console.error('Error decoding DATABASE_CA_CERT:', error.message);
        return undefined;
    }
};

export function parseDatabaseUrl(databaseUrl: string) {
    try {
        const url = new URL(databaseUrl);

        const config = {
            protocol: url.protocol.slice(0, -1),
            username: url.username,
            password: url.password,
            host: url.hostname,
            port: url.port ? parseInt(url.port, 10) : undefined,
            database: url.pathname.slice(1),
            searchParams: Object.fromEntries(url.searchParams.entries()),
        };
        return config;
    } catch (error) {
        return null;
    }
}
