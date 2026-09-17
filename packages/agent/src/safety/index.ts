/**
 * Safety rails and the trust ladder (AW-24).
 *
 * Ever Works already refuses things — a merge into a protected branch, a tool
 * call the grant matrix does not allow, a run above a budget ceiling, a
 * dispatch while the platform stop flag is set. Every one of those refusals is
 * real and enforced in the platform rather than asked of the model. None of it
 * was legible, none of it was uniform, and none of it was something an owner
 * could turn up or down as their trust grew.
 *
 * This module is the shared half: one taxonomy, one order, one enforcement
 * point, one refusal record — and the ladder, which is the dial that never
 * existed. Every existing mechanism keeps its behaviour, its response shape
 * and its configuration surface; the rails delegate to them rather than
 * replacing them.
 */
export * from './action-category';
export * from './trust-ladder';
export * from './guardrail-interop';
export * from './safety-rails';
export * from './rails';
export * from './readiness';
export * from './safety-readiness.service';
export * from './payload-digest';
export * from './safety-gate.port';
export * from './safety-gate.service';
export * from './safety-state.cache';
export * from './autonomy-grant.repository';
export * from './autonomy-grant.service';
export * from './rail-refusal.repository';
export * from './rail-refusal.service';
export * from './workspace-pause.repository';
export * from './workspace-pause.service';
export * from './safety.module';
