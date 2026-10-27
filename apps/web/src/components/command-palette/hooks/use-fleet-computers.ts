'use client';

import { useEffect, useState } from 'react';
import { listVisibleFleetNodesAction } from '@/app/actions/settings/fleet';

export interface PaletteFleetComputer {
    id: string;
    name: string;
    /**
     * The capability tags it advertises (FL-09: `services`, `processes`,
     * `docker` add "Services on <name>" and friends). Optional: a row
     * without them gets only "Go to computer".
     */
    capabilities?: string[];
    /**
     * Virtual computers (FL-16): the host a virtual computer runs on, so the
     * palette offers "Start <name>" / "Stop <name>" for it (opening its page,
     * where the act and its confirmation live). Absent for every other computer.
     */
    hostNodeId?: string;
    /** Virtual computers (FL-16): its state, to offer Start or Stop. */
    virtualState?: string;
    /** Cloud computers (FL-17): its power at the provider, to offer Power off or Power on. */
    cloudPowerState?: string;
}

/**
 * Fleet hub (FL-01, FR-33, T-27) — the computers the viewer may see, for the
 * palette's "Go to computer <name>" rows: read once each time the palette
 * opens while the hub is on (the viewer's own and those shared with them,
 * enrolled computers only). A failed read leaves the rows out — the palette
 * never waits on it and never shows a stale list as fresh.
 */
/**
 * The tags that add per-computer palette rows (FL-09: Services, Docker, Processes on <name>; FL-11: Files on <name>;
 * FL-18: Install Actions runners on <name>).
 */
const PALETTE_MACHINE_TAGS: readonly string[] = [
    'services',
    'docker',
    'processes',
    'files',
    'actions-runner',
];

export function useFleetPaletteComputers(open: boolean, enabled: boolean): PaletteFleetComputer[] {
    const [computers, setComputers] = useState<PaletteFleetComputer[]>([]);

    useEffect(() => {
        if (!open || !enabled) return undefined;
        let cancelled = false;
        void listVisibleFleetNodesAction()
            .then((result) => {
                if (cancelled) return;
                setComputers(
                    result.success
                        ? result.data
                              .filter((node) => node.persisted && node.status !== 'enrolling')
                              .map((node) => {
                                  // Only the tags a palette row is built from (FL-09), and only when present.
                                  const tags = (node.capabilities ?? []).filter((tag) =>
                                      PALETTE_MACHINE_TAGS.includes(tag),
                                  );
                                  const base: PaletteFleetComputer =
                                      tags.length > 0
                                          ? { id: node.id, name: node.name, capabilities: tags }
                                          : { id: node.id, name: node.name };
                                  // FL-16: a virtual computer carries its host and state.
                                  if (node.hostNodeId) base.hostNodeId = node.hostNodeId;
                                  if (node.virtual?.state) base.virtualState = node.virtual.state;
                                  // FL-17: a cloud computer carries its power state (no act while one is pending).
                                  if (node.cloud && !node.cloud.pending)
                                      base.cloudPowerState = node.cloud.powerState;
                                  return base;
                              })
                        : [],
                );
            })
            .catch(() => {
                if (!cancelled) setComputers([]);
            });
        return () => {
            cancelled = true;
        };
    }, [open, enabled]);

    return enabled ? computers : [];
}
