import type { GenerateStatus } from '@/lib/api/types-only';

/**
 * Get progress percentage for a generation status.
 * Uses dynamic progress data from the pipeline plugin.
 */
export function getStepProgress(status: GenerateStatus | undefined): number {
    if (!status?.step) return 0;

    // Use dynamic progress from pipeline if available
    if (status.progress !== undefined) {
        return Math.round(status.progress);
    }

    // Calculate from step index if available
    if (
        status.stepIndex !== undefined &&
        status.totalSteps !== undefined &&
        status.totalSteps > 0
    ) {
        return Math.round(((status.stepIndex + 1) / status.totalSteps) * 100);
    }

    // No progress info available - return 0
    return 0;
}

/**
 * Get human-readable step text.
 * Prefers the static `stepName` (e.g. "Generate Items") for a clean label.
 * Falls back to `step` when `stepName` is not set.
 */
export function getStepText(status: GenerateStatus | undefined, fallbackText: string): string {
    if (!status?.step) {
        return fallbackText;
    }

    if (status.stepName) {
        return status.stepName;
    }

    return status.step || fallbackText;
}

/**
 * Get items-processed text when available.
 * Returns e.g. "27 items generated" or undefined when not applicable.
 */
export function getItemsProcessedText(status: GenerateStatus | undefined): string | undefined {
    if (status?.itemsProcessed !== undefined && status.itemsProcessed > 0) {
        return `${status.itemsProcessed} items generated`;
    }
    return undefined;
}
