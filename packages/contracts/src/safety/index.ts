/**
 * Safety rails and the trust ladder (AW-24) — the shared vocabulary.
 *
 * Ever Works already refuses things, in six unrelated places with six
 * different vocabularies. This folder is the one vocabulary all of them speak
 * from here on: thirteen kinds of work, four rungs, seven rails in a
 * published order, fourteen reason codes, and the numbers behind every
 * sentence the product says out loud.
 *
 * Everything here is pure and dependency-free so the identical comparison
 * runs in the API, the agent tool loop, the worker and the web UI. A rung
 * that means one thing on the screen and another at the enforcement point is
 * not a safety property.
 */
export * from './action-category.types.js';
export * from './trust-rung.types.js';
export * from './safety-rail.types.js';
export * from './autonomy-grant.types.js';
export * from './rail-refusal.types.js';
export * from './workspace-pause.types.js';
export * from './safety-readiness.types.js';
export * from './safety-overview.types.js';
export * from './limits.js';
