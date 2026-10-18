'use client';

import { useEffect } from 'react';
import { captureFleetEvent, type FleetTelemetryEvent } from './fleet-telemetry';

/** Fleet hub (FL-01) — captures one hub event when a page mounts (e.g. `fleet_hub_opened`). */
export function FleetTelemetryOnMount({ event }: { event: FleetTelemetryEvent }) {
    const key = JSON.stringify(event);
    useEffect(() => {
        captureFleetEvent(JSON.parse(key) as FleetTelemetryEvent);
    }, [key]);
    return null;
}
