import posthog from 'posthog-js';
import type { NeedsALookKind } from '@ever-works/contracts';
import type { FleetComputerTabId, FleetHubTabId } from './registry';

/**
 * Fleet hub (FL-01, spec §6 Observability) — the hub's analytics events.
 * Every property is an enum — never a computer name, an id or any text
 * (same posture as the manual's events). The union is closed so a free-text
 * property cannot be added without changing this type.
 */
export type FleetTelemetryEvent =
    | { name: 'fleet_hub_opened'; properties: { tab: FleetHubTabId } }
    | { name: 'fleet_computer_opened'; properties: { tab: FleetComputerTabId } }
    | {
          name: 'fleet_needs_a_look_acted';
          properties: { kind: NeedsALookKind; action: 'route' | 'command' };
      }
    | { name: 'fleet_favorite_toggled'; properties: { on: boolean } };

/** Capture one hub event through the already-mounted analytics client. Never throws. */
export function captureFleetEvent(event: FleetTelemetryEvent): void {
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
    try {
        posthog.capture(event.name, event.properties);
    } catch {
        // Analytics must never break the hub.
    }
}
