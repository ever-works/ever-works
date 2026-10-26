import {
    FLEET_HELPER_SEEN_EVENT_IDS,
    fleetHelperEventAuditAction,
    normalizeFleetDesktopReasons,
    normalizeFleetDisplays,
    normalizeFleetHelperEvents,
    normalizeFleetHelperStatus,
    normalizeFleetHelperTrust,
    type FleetAuditAction,
    type FleetHelperEvent,
    type FleetHelperTrust,
    type FleetNodeDesktopFacts,
    type FleetNodeDesktopView,
} from '@ever-works/contracts';
import type { FleetNode } from '../../entities/fleet-node.entity';

/**
 * Desktop view & control (FL-07, CONTRACTS §1.1, R-8, FR-16, FR-18, U3) —
 * what a heartbeat's desktop fields become on the row, and which admission
 * events the platform has not audited yet.
 *
 * Pure: `FleetService.heartbeat` merges the patch into its own and writes one
 * `node.helper.*` row per new event after the row is saved. Every value is
 * untrusted off the wire and re-normalised here; a beat that carries none of
 * the five fields (a node without `--attend`, or older than the fields) leaves
 * the stored facts alone, like every other telemetry field.
 */

/** The heartbeat's five desktop fields, as `EnrollInput` carries them (untrusted). */
export interface ReportedDesktopFields {
    helperTrust?: unknown;
    helper?: unknown;
    displays?: unknown;
    desktopReasons?: unknown;
    helperEvents?: unknown;
}

export interface AppliedDesktopReport {
    patch: Partial<Pick<FleetNode, 'helperTrust' | 'desktopFacts'>>;
    /** Events to audit now (not seen before), oldest first. */
    newEvents: FleetHelperEvent[];
}

function stored(node: Pick<FleetNode, 'desktopFacts'>): FleetNodeDesktopFacts | null {
    const facts = node.desktopFacts;
    return facts && typeof facts === 'object' ? facts : null;
}

/** Merge a beat's desktop fields into a patch; null when the beat said nothing about the desktop. */
export function applyReportedDesktop(
    node: Pick<FleetNode, 'helperTrust' | 'desktopFacts'>,
    refresh: ReportedDesktopFields,
    receivedAt: Date,
): AppliedDesktopReport | null {
    const said =
        refresh.helperTrust !== undefined ||
        refresh.helper !== undefined ||
        refresh.displays !== undefined ||
        refresh.desktopReasons !== undefined ||
        refresh.helperEvents !== undefined;
    if (!said) return null;
    const previous = stored(node);
    const seen = new Set<string>(Array.isArray(previous?.seenEventIds) ? previous!.seenEventIds : []);
    const events = normalizeFleetHelperEvents(refresh.helperEvents);
    const newEvents = events.filter((event) => !seen.has(event.id));
    const seenEventIds = [
        ...(previous?.seenEventIds ?? []).filter((id) => typeof id === 'string'),
        ...newEvents.map((event) => event.id),
    ].slice(-FLEET_HELPER_SEEN_EVENT_IDS);
    const trust: FleetHelperTrust = normalizeFleetHelperTrust(refresh.helperTrust);
    const facts: FleetNodeDesktopFacts = {
        helper: normalizeFleetHelperStatus(refresh.helper),
        displays: normalizeFleetDisplays(refresh.displays),
        reasons: normalizeFleetDesktopReasons(refresh.desktopReasons),
        reportedAt: receivedAt.toISOString(),
        seenEventIds,
    };
    return { patch: { helperTrust: trust, desktopFacts: facts }, newEvents };
}

/** The view block of a row's desktop facts (never the audited ids). */
export function fleetNodeDesktopViewOf(node: Pick<FleetNode, 'desktopFacts'>): FleetNodeDesktopView | null {
    const facts = stored(node);
    if (!facts) return null;
    return {
        helper: normalizeFleetHelperStatus(facts.helper),
        displays: normalizeFleetDisplays(facts.displays),
        reasons: normalizeFleetDesktopReasons(facts.reasons),
        reportedAt: typeof facts.reportedAt === 'string' ? facts.reportedAt : null,
    };
}

/** One admission event as its `fleet_audit` row (CONTRACTS §2.3; no key a redactor would eat). */
export function helperEventAudit(event: FleetHelperEvent): {
    action: Extract<FleetAuditAction, `node.helper.${string}`>;
    extra: Record<string, unknown>;
} {
    return {
        action: fleetHelperEventAuditAction(event.kind),
        extra: {
            family: 'desktop',
            target: 'screen-helper',
            // Done on the machine, by whoever was at its keyboard: not a platform user.
            requestedBy: 'system:node',
            confirmationClass: 'plain',
            outcome: event.kind === 'verify-failed' ? 'refused' : 'done',
            eventId: event.id,
            eventAt: event.at,
            level: event.level ?? null,
            version: event.version ?? null,
            fingerprintPrefix: event.fingerprintPrefix ?? null,
            published: event.published ?? null,
            reason: event.reason ?? null,
        },
    };
}
