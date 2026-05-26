import { MissionTabs } from '@/components/missions/MissionTabs';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 14.4 layout mount.
 *
 * Mounts the `MissionTabs` strip across `/missions/[id]` (the
 * Overview tab — existing `MissionDetailClient`) and
 * `/missions/[id]/tasks` (the Tasks tab — `TasksScopedSection`).
 *
 * The component itself was shipped in tick 19 but its mount was
 * deferred on a "single-column body stability" concern that no
 * longer applies — the Tasks tab has been live as a direct deep-link
 * for the full feature-set lifetime and the Overview body has not
 * regressed. Hoisting the strip up to the layout fixes the discovery
 * gap: today a user landing on Overview has no visible affordance to
 * find the Tasks tab.
 */
export default async function MissionDetailLayout({
    params,
    children,
}: {
    params: Promise<{ id: string }>;
    children: React.ReactNode;
}) {
    const { id } = await params;
    return (
        <div className="w-full">
            <MissionTabs missionId={id} />
            {children}
        </div>
    );
}
