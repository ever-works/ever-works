/**
 * Public API of the anonymous usage statistics primitives — imported as
 * `@ever-works/agent/ever-instance`.
 *
 * - `ever-stats-config` — the environment switches, read once at boot
 *   (`isEverStatsModuleEnabled` is what `ApiModule` asks before it imports the
 *   statistics module at all).
 * - `EverInstanceService` — the installation identity: opaque id, the
 *   statistics-only signing key (the Ever Platform SDK's `StatsSigner`), reset.
 * - `InstanceStatsRepository` — the instance-wide aggregate queries.
 * - `EverInstanceModule` — wires the two above.
 *
 * The `ever.stats.v1` schema, its checks and the signing primitives are the
 * published `@ever-co/connect-contracts` and `@ever-co/connect-sdk` packages;
 * nothing of them is copied here.
 */
export * from './ever-stats-config';
export * from './ever-instance.service';
export * from './instance-stats.repository';
export * from './ever-instance.module';
