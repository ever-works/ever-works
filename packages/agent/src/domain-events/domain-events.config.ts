/**
 * Domain event settings (EW-P1-1), read from the environment once per call so
 * tests can change them.
 *
 * | Variable                              | Default | Meaning                                                        |
 * | ------------------------------------- | ------- | -------------------------------------------------------------- |
 * | `DOMAIN_EVENTS_RELAY_ENABLED`         | `true`  | `false` stops the relay; events wait in the outbox             |
 * | `DOMAIN_EVENTS_RETENTION_DAYS`        | `30`    | dispatched rows older than this are purged                     |
 * | `DOMAIN_EVENTS_RELAY_INTERVAL_MS`     | `1000`  | polling tick (Postgres `LISTEN` wakes the relay earlier)       |
 * | `DOMAIN_EVENTS_RELAY_BATCH_SIZE`      | `200`   | rows given positions per transaction                           |
 * | `DOMAIN_EVENTS_LEASE_TTL_MS`          | `30000` | how long a relay lease lasts without renewal                   |
 * | `DOMAIN_EVENTS_PLUGIN_TIMEOUT_MS`     | `10000` | per-call timeout of a plugin's `onDomainEvent`                 |
 * | `DOMAIN_EVENTS_LISTENER_TIMEOUT_MS`   | `10000` | bound on in-process listeners and consumers per event/batch    |
 */
export interface DomainEventsSettings {
    readonly relayEnabled: boolean;
    readonly retentionDays: number;
    readonly relayIntervalMs: number;
    readonly batchSize: number;
    readonly leaseTtlMs: number;
    readonly pluginTimeoutMs: number;
    readonly listenerTimeoutMs: number;
}

/** Consecutive failures on one event before a plugin's delivery dead-letters it. */
export const DOMAIN_EVENT_PLUGIN_MAX_FAILURES = 10;

/** Postgres `LISTEN`/`NOTIFY` channel the recorder pings and the relay listens on. */
export const DOMAIN_EVENTS_NOTIFY_CHANNEL = 'ever_works_domain_events';

function positiveInt(
    raw: string | undefined,
    fallback: number,
    min = 1,
    max = Number.MAX_SAFE_INTEGER,
): number {
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) return fallback;
    return value;
}

export function readDomainEventsSettings(
    env: NodeJS.ProcessEnv = process.env,
): DomainEventsSettings {
    return {
        // Only an explicit `false` switches the relay off.
        relayEnabled: (env.DOMAIN_EVENTS_RELAY_ENABLED ?? '').trim().toLowerCase() !== 'false',
        retentionDays: positiveInt(env.DOMAIN_EVENTS_RETENTION_DAYS, 30, 1, 3650),
        relayIntervalMs: positiveInt(env.DOMAIN_EVENTS_RELAY_INTERVAL_MS, 1000, 100, 60_000),
        batchSize: positiveInt(env.DOMAIN_EVENTS_RELAY_BATCH_SIZE, 200, 1, 1000),
        leaseTtlMs: positiveInt(env.DOMAIN_EVENTS_LEASE_TTL_MS, 30_000, 5_000, 600_000),
        pluginTimeoutMs: positiveInt(env.DOMAIN_EVENTS_PLUGIN_TIMEOUT_MS, 10_000, 100, 300_000),
        listenerTimeoutMs: positiveInt(env.DOMAIN_EVENTS_LISTENER_TIMEOUT_MS, 10_000, 100, 300_000),
    };
}
