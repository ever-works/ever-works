/**
 * Package entry point for `ever-works-node`.
 *
 * Re-exports the whole node core so consumers (notably `apps/desktop-node`,
 * whose Electron main process compiles with node10 module resolution and can
 * therefore not reach the `./core` subpath export) can simply
 * `import { ... } from 'ever-works-node'`.
 */

export * from './core';

/**
 * Real IO adapters (command runner, config filesystem, fetch, host
 * environment) so the Electron shell binds the core to Node built-ins exactly
 * the way the headless CLI does, instead of writing its own.
 */
export * from './node-io';
export { NODE_APP_VERSION } from './version';
