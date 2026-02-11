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
 * Uses dynamic stepName from the pipeline plugin.
 *
 * @param status - The generation status
 * @param fallbackText - Fallback text when no step name is available (e.g., "Processing...")
 */
export function getStepText(status: GenerateStatus | undefined, fallbackText: string): string {
    if (!status?.step) {
        return fallbackText;
    }

    // Use dynamic step name from pipeline if available
    if (status.stepName) {
        return status.stepName;
    }

    // Fallback: display the fallback text if no step name available
    return fallbackText;
}
