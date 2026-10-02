import {
    EVER_PLATFORM_DEFAULT_API_URL,
    normaliseStatsBaseUrl,
    type WorksStatsFeatures,
} from '@ever-works/contracts';

/**
 * Configuration of the anonymous usage statistics module, read from the
 * environment ONCE at boot.
 *
 * | Variable                     | Default                       | Meaning |
 * |------------------------------|-------------------------------|---------|
 * | `EVER_STATS_ENABLED`         | unset ⇒ on                    | `false` (or any value other than empty / `true`) ⇒ the module is not loaded: no route, no timer, no request |
 * | `EVER_STATS_API_URL`         | `EVER_PLATFORM_API_URL`       | base URL of the statistics endpoint |
 * | `EVER_PLATFORM_API_URL`      | `https://api.ever.co`         | shared Ever Platform base URL |
 * | `EVER_STATS_COUNTRY`         | unset ⇒ `ZZ`                  | ISO 3166-1 alpha-2 country the operator declares |
 * | `EVER_STATS_SEND_INTERVAL_S` | `86400` (daily)               | test override; never below 3600 outside tests |
 * | `EVER_INSTALL_SOURCE`        | `self-hosted`                 | `cloud`, `self-hosted`, `ever.sh`, `works_app`, `desktop`, `partner:<slug>` |
 * | `EVER_WORKS_STATS_SINK`      | `ever-stats-sink`             | id of the `stats-sink` plugin that delivers reports |
 *
 * Nothing about the installation is inferred: `install_source` comes only from
 * `EVER_INSTALL_SOURCE` and `country` only from `EVER_STATS_COUNTRY`. A
 * malformed value falls back to its default and is reported once in
 * {@link EverStatsConfig.warnings} (machine tokens, never the value itself).
 */
export interface EverStatsConfig {
    /** Whether the module is loaded at all. */
    readonly enabled: boolean;
    /** Normalised base URL (no trailing slash), or the default when the configured one is unusable. */
    readonly apiBaseUrl: string;
    /**
     * `false` when the operator configured a URL the module refuses (not https,
     * credentials in it, …). Sends are then refused with `invalid_url` and NO
     * request is made: a broken setting never silently falls back to Ever's host.
     */
    readonly apiBaseUrlUsable: boolean;
    readonly installSource: string;
    readonly country: string;
    readonly sendIntervalS: number;
    readonly sinkPluginId: string;
    readonly features: WorksStatsFeatures;
    readonly warnings: readonly string[];
}

/** The default delivery plugin. */
export const EVER_STATS_DEFAULT_SINK_PLUGIN_ID = 'ever-stats-sink';
/** One report a day. */
export const EVER_STATS_DEFAULT_INTERVAL_S = 86_400;
/** Floor of `EVER_STATS_SEND_INTERVAL_S` outside tests and CI. */
export const EVER_STATS_MIN_INTERVAL_S = 3_600;

const INSTALL_SOURCE_PATTERN =
    /^(cloud|self-hosted|ever\.sh|works_app|desktop|partner:[a-z0-9-]{2,32})$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The module switch. Unset, empty or `true` ⇒ on (anonymous statistics are on
 * by default). `false` ⇒ off. ANY other value ⇒ off as well: an operator who
 * writes `0`, `no` or `False` means off, and a switch that guards outbound
 * traffic fails closed.
 */
export function isEverStatsModuleEnabled(env: Env = process.env): boolean {
    const raw = env.EVER_STATS_ENABLED;
    if (raw === undefined) return true;
    const value = raw.trim();
    return value === '' || value === 'true';
}

export function readEverStatsConfig(env: Env = process.env): EverStatsConfig {
    const warnings: string[] = [];

    const enabledRaw = env.EVER_STATS_ENABLED?.trim();
    if (
        enabledRaw !== undefined &&
        enabledRaw !== '' &&
        enabledRaw !== 'true' &&
        enabledRaw !== 'false'
    ) {
        warnings.push('EVER_STATS_ENABLED:unrecognised_value_treated_as_off');
    }

    const configuredUrl = firstNonEmpty(env.EVER_STATS_API_URL, env.EVER_PLATFORM_API_URL);
    let apiBaseUrl: string = EVER_PLATFORM_DEFAULT_API_URL;
    let apiBaseUrlUsable = true;
    if (configuredUrl) {
        const normalised = normaliseStatsBaseUrl(configuredUrl);
        if (normalised) {
            apiBaseUrl = normalised;
        } else {
            apiBaseUrlUsable = false;
            warnings.push('EVER_STATS_API_URL:refused');
        }
    }

    let installSource = 'self-hosted';
    const sourceRaw = env.EVER_INSTALL_SOURCE?.trim();
    if (sourceRaw) {
        if (INSTALL_SOURCE_PATTERN.test(sourceRaw)) installSource = sourceRaw;
        else warnings.push('EVER_INSTALL_SOURCE:malformed');
    }

    let country = 'ZZ';
    const countryRaw = env.EVER_STATS_COUNTRY?.trim();
    if (countryRaw) {
        const upper = countryRaw.toUpperCase();
        if (COUNTRY_PATTERN.test(upper)) country = upper;
        else warnings.push('EVER_STATS_COUNTRY:malformed');
    }

    let sendIntervalS = EVER_STATS_DEFAULT_INTERVAL_S;
    const intervalRaw = env.EVER_STATS_SEND_INTERVAL_S?.trim();
    if (intervalRaw) {
        const parsed = /^\d{1,9}$/.test(intervalRaw) ? Number(intervalRaw) : Number.NaN;
        const isTest = env.NODE_ENV === 'test' || env.CI === 'true';
        if (!Number.isInteger(parsed) || parsed < 1) {
            warnings.push('EVER_STATS_SEND_INTERVAL_S:malformed');
        } else if (!isTest && parsed < EVER_STATS_MIN_INTERVAL_S) {
            sendIntervalS = EVER_STATS_MIN_INTERVAL_S;
            warnings.push('EVER_STATS_SEND_INTERVAL_S:raised_to_floor');
        } else {
            sendIntervalS = parsed;
        }
    }

    let sinkPluginId = EVER_STATS_DEFAULT_SINK_PLUGIN_ID;
    const sinkRaw = env.EVER_WORKS_STATS_SINK?.trim();
    if (sinkRaw) {
        if (PLUGIN_ID_PATTERN.test(sinkRaw)) sinkPluginId = sinkRaw;
        else warnings.push('EVER_WORKS_STATS_SINK:malformed');
    }

    return {
        enabled: isEverStatsModuleEnabled(env),
        apiBaseUrl,
        apiBaseUrlUsable,
        installSource,
        country,
        sendIntervalS,
        sinkPluginId,
        features: readWorksStatsFeatures(env),
        warnings,
    };
}

/**
 * The six feature booleans of a Works report, each a strict `=== 'true'` (or
 * the documented equivalent) of a switch the installation already has. They
 * are only REPORTED: nothing here changes what any switch does.
 */
export function readWorksStatsFeatures(env: Env = process.env): WorksStatsFeatures {
    return {
        app_works_enabled: env.EVER_WORKS_APP_WORKS_ENABLED === 'true',
        app_launcher_enabled: env.EVER_WORKS_APP_LAUNCHER_ENABLED === 'true',
        dynamic_plugins: (env.PLUGIN_DISTRIBUTION_MODE ?? '').trim().toLowerCase() === 'dynamic',
        deploy_ever_works_enabled: env.DEPLOY_EVER_WORKS_ENABLED === 'true',
        subscriptions_enabled: env.SUBSCRIPTIONS_ENABLED === 'true',
        mcp_enabled: (env.EVER_WORKS_MCP_AUTH_MODE ?? '').trim().length > 0,
    };
}

function firstNonEmpty(...values: Array<string | undefined>): string | null {
    for (const value of values) {
        const trimmed = value?.trim();
        if (trimmed) return trimmed;
    }
    return null;
}
