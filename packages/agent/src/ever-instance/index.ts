/**
 * Public API of the anonymous usage statistics primitives — imported as
 * `@ever-works/agent/ever-instance`.
 *
 * - `ever-stats-config` — the environment switches, read once at boot
 *   (`isEverStatsModuleEnabled` is what `ApiModule` asks before it imports the
 *   statistics module at all).
 * - `validate-stats-report` — strict validation against the vendored
 *   `ever.stats.v1` schema, of a report object and of the exact body.
 * - `EverInstanceService` — the installation identity: opaque id, the
 *   statistics-only signing key, reset.
 * - `InstanceStatsRepository` — the instance-wide aggregate queries.
 * - `EverInstanceModule` — wires the two above.
 */
export * from './ever-stats-config';
export * from './validate-stats-report';
export * from './ever-instance.service';
export * from './instance-stats.repository';
export * from './ever-instance.module';
