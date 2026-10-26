import type { RunReceiptFleetUsage } from '@ever-works/contracts';

/**
 * Usage & cost on the fleet (FL-20, spec FR-11, plan §8) — the Run receipt's
 * fleet line: the model work a Run did on a computer, at list price, from that
 * computer's opt-in transcript scan.
 *
 * A port so the receipt (AW-09, `RunLedgerModule`) does not import the fleet
 * usage module: the API binds it to `FleetUsageViewService` in
 * `FleetUsageApiModule` (global). Unbound — or `FLEET_USAGE_SCAN_ENABLED` off —
 * the receipt simply has no fleet line.
 */
export const RUN_RECEIPT_FLEET_USAGE_READER = 'RUN_RECEIPT_FLEET_USAGE_READER' as const;

export interface RunReceiptFleetUsageReader {
    /** The Run's scanned model work, or null when there is none. Never throws for a missing row. */
    runFleetUsage(runId: string): Promise<RunReceiptFleetUsage | null>;
}
