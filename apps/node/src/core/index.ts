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

export * from './browser-probe';
export * from './auth-client';
export * from './capabilities';
export * from './config-store';
export * from './resource-limits';
export * from './fleet-client';
export * from './gpu-probe';
export * from './job-client';
export * from './heartbeat';
export * from './logger';
export * from './model-execution/model-process';
export * from './runtime';
export * from './secret-store';
export * from './telemetry-probe';
export * from './types';
export * from './worker-loop';
export * from './executors/acceptance-checks';
export * from './executors/agent-task';
export * from './executors/browser-check';
