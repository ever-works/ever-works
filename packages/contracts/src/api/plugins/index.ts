/**
 * Dynamic plugin distribution (EW-693) API contracts.
 *
 * Wire-types shared between the API (NestJS controllers) and any
 * client that consumes them (web app, CLI, automation). Pure types —
 * no decorators — so they can be imported from both server and
 * client without dragging in `class-validator` etc.
 */
export * from './install-state.js';
export * from './catalog.js';
export * from './allowlist.js';
