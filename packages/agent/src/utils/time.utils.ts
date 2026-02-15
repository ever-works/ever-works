/**
 * Calculate duration between two dates in seconds, rounded to the nearest integer.
 */
export function calculateDurationSeconds(start: Date, end: Date): number {
    return Math.round((end.getTime() - start.getTime()) / 1000);
}
