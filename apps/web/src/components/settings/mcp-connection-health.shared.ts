import {
    connectionHealthIsWarning,
    connectionHealthNeedsAttention,
    isConnectionHealth,
    type ConnectionHealth,
    type ConnectionHealthErrorCode,
} from '@ever-works/contracts';

/**
 * Settings → Connections — health presentation POLICY for MCP server rows
 * (AW-15). No React; `McpConnectionsClient.tsx` renders what this decides.
 */

export interface HealthBearingRow {
    health?: ConnectionHealth | string | null;
    lastErrorCode?: ConnectionHealthErrorCode | string | null;
    /** AW-15 — literal credentials to a plain-http address (known before the first attempt). */
    insecureCredentialTransport?: boolean | null;
}

/** A row from an API without the health columns reads as "not checked yet". */
export function rowHealth(row: HealthBearingRow): ConnectionHealth {
    return isConnectionHealth(row.health) ? row.health : 'unknown';
}

export type HealthTone = 'success' | 'warning' | 'danger' | 'muted';

export function healthTone(health: ConnectionHealth): HealthTone {
    switch (health) {
        case 'healthy':
            return 'success';
        case 'degraded':
        // A working connection whose credentials travel unencrypted.
        case 'insecure_transport':
            return 'warning';
        case 'expired':
        case 'unreachable':
            return 'danger';
        default:
            return 'muted';
    }
}

/**
 * The i18n leaf (under `health`) for a state's pill label. Leaf keys are
 * camelCase, so `insecure_transport` reads `insecureTransport`.
 */
export function healthLabelKey(
    health: ConnectionHealth,
): 'unknown' | 'healthy' | 'degraded' | 'expired' | 'unreachable' | 'insecureTransport' {
    return health === 'insecure_transport' ? 'insecureTransport' : health;
}

/**
 * Does this connection send credentials unencrypted? True from the stored
 * URL + headers before any attempt, and from the health warning after one.
 * The connection still works — this is a warning, never a failure.
 */
export function sendsCredentialsUnencrypted(row: HealthBearingRow): boolean {
    return row.insecureCredentialTransport === true || connectionHealthIsWarning(rowHealth(row));
}

/** How many rows the unencrypted-credentials banner counts. */
export function countSendingUnencrypted(rows: readonly HealthBearingRow[]): number {
    return rows.filter((row) => sendsCredentialsUnencrypted(row)).length;
}

/** How many rows the attention banner counts. */
export function countNeedingAttention(rows: readonly HealthBearingRow[]): number {
    return rows.filter((row) => connectionHealthNeedsAttention(rowHealth(row))).length;
}

/**
 * The i18n leaf (under `health`) for the one extra sentence a failure needs,
 * or `null` when the stored message already says everything.
 */
export function healthHintKey(
    row: HealthBearingRow,
):
    | 'credentialMissingHint'
    | 'insecureTransportHint'
    | 'credentialRejectedHint'
    | 'httpsRequiredHint'
    | null {
    switch (row.lastErrorCode) {
        case 'credential_missing':
            return 'credentialMissingHint';
        case 'insecure_transport':
            return 'insecureTransportHint';
        case 'https_required':
            return 'httpsRequiredHint';
        case 'credential_rejected':
            return 'credentialRejectedHint';
        default:
            return null;
    }
}
