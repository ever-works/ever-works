import {
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
            return 'warning';
        case 'expired':
        case 'unreachable':
            return 'danger';
        default:
            return 'muted';
    }
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
): 'credentialMissingHint' | 'insecureTransportHint' | 'credentialRejectedHint' | null {
    switch (row.lastErrorCode) {
        case 'credential_missing':
            return 'credentialMissingHint';
        case 'insecure_transport':
            return 'insecureTransportHint';
        case 'credential_rejected':
            return 'credentialRejectedHint';
        default:
            return null;
    }
}
