/**
 * `@ever-works` node core — enrollment, heartbeat and capability detection,
 * written once and consumed by both node shells:
 *
 *   - `apps/node`         headless CLI / service (this package's own `cli.ts`)
 *   - `apps/desktop-node` Electron status shell (imports `ever-works-node`)
 *
 * Every module here is pure logic over injected IO (fetch, fs, clock, command
 * runner), so both shells stay thin and the whole surface is unit-testable.
 */

export * from './capabilities';
export * from './config-store';
export * from './fleet-client';
export * from './job-client';
export * from './heartbeat';
export * from './logger';
export * from './runtime';
export * from './types';
export * from './worker-loop';
export * from './executors/acceptance-checks';
export * from './executors/agent-task';
