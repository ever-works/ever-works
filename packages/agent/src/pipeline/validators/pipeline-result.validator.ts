import type { PipelineResult } from '@ever-works/plugin';

/**
 * Result of pipeline result validation
 */
export interface PipelineResultValidation {
    /** Whether the result is valid */
    valid: boolean;
    /** Validation errors if any */
    errors: string[];
    /** The validated result if valid */
    result?: PipelineResult;
}

/**
 * Validate that an object conforms to the PipelineResult interface.
 * Returns validation errors for missing or incorrectly typed fields.
 *
 * @param result - The result object to validate
 * @returns Validation result with errors if invalid
 */
export function validatePipelineResult(result: unknown): PipelineResultValidation {
    const errors: string[] = [];

    // Check if result is an object
    if (typeof result !== 'object' || result === null) {
        return { valid: false, errors: ['Result must be an object'] };
    }

    const r = result as Record<string, unknown>;

    // Validate required fields
    if (typeof r.success !== 'boolean') {
        errors.push('Missing or invalid "success" field (expected boolean)');
    }

    if (!Array.isArray(r.items)) {
        errors.push('Missing or invalid "items" field (expected array)');
    }

    if (!Array.isArray(r.categories)) {
        errors.push('Missing or invalid "categories" field (expected array)');
    }

    if (!Array.isArray(r.tags)) {
        errors.push('Missing or invalid "tags" field (expected array)');
    }

    if (!Array.isArray(r.brands)) {
        errors.push('Missing or invalid "brands" field (expected array)');
    }

    if (typeof r.stepsCompleted !== 'number') {
        errors.push('Missing or invalid "stepsCompleted" field (expected number)');
    }

    if (typeof r.totalSteps !== 'number') {
        errors.push('Missing or invalid "totalSteps" field (expected number)');
    }

    // Validate state object
    if (typeof r.state !== 'object' || r.state === null) {
        errors.push('Missing or invalid "state" field (expected object)');
    } else {
        const state = r.state as Record<string, unknown>;
        if (typeof state.isRunning !== 'boolean') {
            errors.push('Missing or invalid "state.isRunning" field (expected boolean)');
        }
        if (typeof state.isCancelled !== 'boolean') {
            errors.push('Missing or invalid "state.isCancelled" field (expected boolean)');
        }
        if (!Array.isArray(state.completedSteps)) {
            errors.push('Missing or invalid "state.completedSteps" field (expected array)');
        }
        if (!Array.isArray(state.failedSteps)) {
            errors.push('Missing or invalid "state.failedSteps" field (expected array)');
        }
    }

    // Optional fields validation
    if (r.duration !== undefined && typeof r.duration !== 'number') {
        errors.push('Invalid "duration" field (expected number)');
    }

    if (r.error !== undefined && typeof r.error !== 'string' && !(r.error instanceof Error)) {
        errors.push('Invalid "error" field (expected string or Error)');
    }

    if (r.failedStep !== undefined && typeof r.failedStep !== 'string') {
        errors.push('Invalid "failedStep" field (expected string)');
    }

    return {
        valid: errors.length === 0,
        errors,
        result: errors.length === 0 ? (result as PipelineResult) : undefined,
    };
}

/**
 * Validate a pipeline result and throw an error if invalid.
 *
 * @param result - The result object to validate
 * @param pluginId - The plugin ID for error messages
 * @returns The validated result
 * @throws Error if validation fails
 */
export function validatePipelineResultOrThrow(result: unknown, pluginId?: string): PipelineResult {
    const validation = validatePipelineResult(result);

    if (!validation.valid) {
        const plugin = pluginId ? ` from plugin '${pluginId}'` : '';
        throw new Error(`Invalid pipeline result${plugin}: ${validation.errors.join('; ')}`);
    }

    return validation.result!;
}
