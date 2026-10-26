'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * Fleet hub (FL-01) — whether the hub is on for this deployment, decided ONCE
 * on the server (`isFleetHubEnabled()` in the dashboard layout) and read by
 * the client surfaces that change with it: the sidebar entry, the runner
 * pill's Manage link and the command palette's hub screens.
 *
 * A context rather than a prop threaded through the sidebar into the pill:
 * the three readers sit at different depths of the shell, and every one of
 * them must get the same answer. Outside the provider the answer is `false`
 * — exactly today's navigation (spec FR-15).
 */
const FleetHubFlagContext = createContext<boolean>(false);

/** Logs on computers (FL-08): `FLEET_MACHINE_FACTS_ENABLED` (with the hub), for "Logs on <computer>". */
const FleetMachineFactsFlagContext = createContext<boolean>(false);

/** Virtual computers (FL-16): `FLEET_VIRTUAL_ENABLED` (with the hub), for "New virtual computer" in the palette. */
const FleetVirtualFlagContext = createContext<boolean>(false);

/** Cloud computers (FL-17): `FLEET_CLOUD_ENABLED` (with the hub), for "New cloud computer" in the palette. */
const FleetCloudFlagContext = createContext<boolean>(false);

/** Actions runners (FL-18): `FLEET_ACTIONS_RUNNERS_ENABLED` (with the hub), for "Install Actions runners on <computer>". */
const FleetActionsRunnersFlagContext = createContext<boolean>(false);

export function FleetHubFlagProvider({
    enabled,
    machineFacts = false,
    virtual = false,
    cloud = false,
    runners = false,
    children,
}: {
    enabled: boolean;
    /** FL-08: machine facts are on for this deployment (never without the hub). */
    machineFacts?: boolean;
    /** FL-16: virtual computers are on for this deployment (never without the hub). */
    virtual?: boolean;
    /** FL-17: cloud computers are on for this deployment (never without the hub). */
    cloud?: boolean;
    /** FL-18: Actions runners are on for this deployment (never without the hub). */
    runners?: boolean;
    children: ReactNode;
}) {
    return (
        <FleetHubFlagContext.Provider value={enabled}>
            <FleetMachineFactsFlagContext.Provider value={enabled && machineFacts}>
                <FleetVirtualFlagContext.Provider value={enabled && virtual}>
                    <FleetCloudFlagContext.Provider value={enabled && cloud}>
                        <FleetActionsRunnersFlagContext.Provider value={enabled && runners}>
                            {children}
                        </FleetActionsRunnersFlagContext.Provider>
                    </FleetCloudFlagContext.Provider>
                </FleetVirtualFlagContext.Provider>
            </FleetMachineFactsFlagContext.Provider>
        </FleetHubFlagContext.Provider>
    );
}

/** True when `FLEET_ENABLED` and `FLEET_HUB_ENABLED` are both on. */
export function useFleetHubEnabled(): boolean {
    return useContext(FleetHubFlagContext);
}

/** True when the hub and `FLEET_MACHINE_FACTS_ENABLED` are both on (FL-08). */
export function useFleetMachineFactsEnabled(): boolean {
    return useContext(FleetMachineFactsFlagContext);
}

/** True when the hub and `FLEET_VIRTUAL_ENABLED` are both on (FL-16). */
export function useFleetVirtualEnabled(): boolean {
    return useContext(FleetVirtualFlagContext);
}

/** True when the hub and `FLEET_CLOUD_ENABLED` are both on (FL-17). */
export function useFleetCloudEnabled(): boolean {
    return useContext(FleetCloudFlagContext);
}

/** True when the hub and `FLEET_ACTIONS_RUNNERS_ENABLED` are both on (FL-18). */
export function useFleetActionsRunnersEnabled(): boolean {
    return useContext(FleetActionsRunnersFlagContext);
}
