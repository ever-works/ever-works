/** The Ever Platform API this installation connects to unless told otherwise. */
export const DEFAULT_EVER_PLATFORM_API_URL = 'https://api.ever.co';

export const EVER_CONNECT_CONFIG = Symbol('EVER_CONNECT_CONFIG');

/**
 * The Ever Connect settings, read once from the environment at boot.
 *
 * - `EVER_PLATFORM_API_URL`: the API (default `https://api.ever.co`). The SDK
 *   refuses plain `http` except to a local address.
 * - `EVER_PLATFORM_ISSUER`: the issuer documents name when it differs from the
 *   API's origin (a local mock); honoured by the SDK for a local address only.
 * - `EVER_CONNECT_CODE`: a connect code (`EVC-…`) used once at the first boot.
 * - `EVER_CONNECT_FEED_MODE`: `longpoll` (default) or `interval` (every 15 minutes).
 * - `EVER_INSTALL_SOURCE`: `self-hosted` (default) or `cloud`.
 */
export interface EverConnectConfig {
    readonly platformApiUrl: string;
    readonly issuer: string | null;
    readonly connectCode: string | null;
    readonly feedMode: 'longpoll' | 'interval';
    readonly installSource: 'self-hosted' | 'cloud';
}

export function readEverConnectConfig(
    env: Readonly<Record<string, string | undefined>> = process.env,
): EverConnectConfig {
    const trimmed = (name: string) => {
        const value = env[name]?.trim();
        return value ? value : null;
    };
    return {
        platformApiUrl: (trimmed('EVER_PLATFORM_API_URL') ?? DEFAULT_EVER_PLATFORM_API_URL).replace(
            /\/+$/,
            '',
        ),
        issuer: trimmed('EVER_PLATFORM_ISSUER'),
        connectCode: trimmed('EVER_CONNECT_CODE'),
        feedMode:
            trimmed('EVER_CONNECT_FEED_MODE')?.toLowerCase() === 'interval'
                ? 'interval'
                : 'longpoll',
        installSource:
            trimmed('EVER_INSTALL_SOURCE')?.toLowerCase() === 'cloud' ? 'cloud' : 'self-hosted',
    };
}

/** A connect code as Ever Platform issues it (`EVC-XXXX-XXXX-XXXX`, case-insensitive). */
export const CONNECT_CODE_PATTERN = /^EVC(-[0-9A-HJKMNP-TV-Z]{4}){3}$/i;
