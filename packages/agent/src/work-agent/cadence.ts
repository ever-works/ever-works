export const SUPPORTED_AUTO_GENERATE_CADENCE_PATTERN =
    /^\*\/([1-9]|[1-9]\d|[1-9]\d{2}|1[0-3]\d{2}|14[0-3]\d|1440)\s+\*\s+\*\s+\*\s+\*$/;

export const DEFAULT_AUTO_GENERATE_CADENCE_MINUTES = 60;

export function parseAutoGenerateCadenceMinutes(cadence: string | null | undefined): number | null {
    if (!cadence) return null;
    const match = SUPPORTED_AUTO_GENERATE_CADENCE_PATTERN.exec(cadence.trim());
    if (!match) return null;
    return Number(match[1]);
}

export function isSupportedAutoGenerateCadence(cadence: string): boolean {
    return parseAutoGenerateCadenceMinutes(cadence) !== null;
}
