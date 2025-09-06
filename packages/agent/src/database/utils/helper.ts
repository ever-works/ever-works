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
        console.error('DB_CA_CERT is not defined. TLS options cannot be configured.');
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
        console.error('Error decoding DB_CA_CERT:', error.message);
        return undefined;
    }
};
