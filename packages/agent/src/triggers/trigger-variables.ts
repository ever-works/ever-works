import type { InboundTriggerVariable } from '../entities/inbound-trigger.entity';

/**
 * Default variables — the payload contract a trigger declares.
 *
 * Pure functions, no I/O. A trigger lists the top-level payload keys it
 * expects; the ones marked `required` are a GATE: a delivery missing one
 * is refused before any Task is created, and the reason is written to
 * the fire log so the owner can see why nothing happened (rather than
 * an agent being handed a half-empty payload and improvising).
 */

/** Top-level payload key shape — same alphabet the templates accept. */
export const VARIABLE_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Cap on how many variables one trigger may declare. */
export const MAX_DEFAULT_VARIABLES = 20;

/** Cap on a variable's display label. */
export const MAX_VARIABLE_LABEL_LENGTH = 80;

export class TriggerVariablesError extends Error {}

/**
 * Validate + canonicalize a caller-supplied variable list. Throws
 * {@link TriggerVariablesError} (mapped to 400 by the service) on a
 * malformed key, a duplicate key, an over-long label, or too many
 * entries. An empty list normalizes to `null` — "no contract declared".
 */
export function normalizeDefaultVariables(
    input: readonly Partial<InboundTriggerVariable>[] | null | undefined,
): InboundTriggerVariable[] | null {
    if (input === null || input === undefined) return null;
    if (!Array.isArray(input)) {
        throw new TriggerVariablesError('defaultVariables must be an array.');
    }
    if (input.length > MAX_DEFAULT_VARIABLES) {
        throw new TriggerVariablesError(
            `defaultVariables accepts at most ${MAX_DEFAULT_VARIABLES} entries.`,
        );
    }
    const seen = new Set<string>();
    const normalized: InboundTriggerVariable[] = [];
    for (const entry of input) {
        const key = (entry?.key ?? '').trim();
        if (!VARIABLE_KEY_RE.test(key)) {
            throw new TriggerVariablesError(
                `defaultVariables key "${key}" must match ${VARIABLE_KEY_RE.source}.`,
            );
        }
        if (seen.has(key)) {
            throw new TriggerVariablesError(`defaultVariables has a duplicate key "${key}".`);
        }
        seen.add(key);
        const label = typeof entry?.label === 'string' ? entry.label.trim() : '';
        if (label.length > MAX_VARIABLE_LABEL_LENGTH) {
            throw new TriggerVariablesError(
                `defaultVariables label for "${key}" must be at most ${MAX_VARIABLE_LABEL_LENGTH} characters.`,
            );
        }
        const variable: InboundTriggerVariable = { key, required: entry?.required === true };
        if (label.length > 0) variable.label = label;
        normalized.push(variable);
    }
    return normalized.length > 0 ? normalized : null;
}

/**
 * Required keys the payload does NOT satisfy. A key counts as missing
 * when it is absent as an OWN property (inherited `constructor` & co.
 * must never satisfy a contract), or present but null/undefined/blank.
 * Returns the keys in declaration order.
 */
export function findMissingRequiredVariables(
    variables: readonly InboundTriggerVariable[] | null | undefined,
    payload: Record<string, unknown> | null | undefined,
): string[] {
    if (!variables || variables.length === 0) return [];
    const missing: string[] = [];
    for (const variable of variables) {
        if (!variable?.required) continue;
        const key = variable.key;
        if (!payload || !Object.prototype.hasOwnProperty.call(payload, key)) {
            missing.push(key);
            continue;
        }
        const value = payload[key];
        if (value === null || value === undefined) {
            missing.push(key);
            continue;
        }
        if (typeof value === 'string' && value.trim().length === 0) {
            missing.push(key);
        }
    }
    return missing;
}

/** Human-readable refusal reason for the fire log (keys only — never values). */
export function describeMissingVariables(missing: readonly string[]): string {
    return `Missing required payload variable(s): ${missing.join(', ')}.`;
}
