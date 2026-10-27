'use client';

import { useCallback, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { FLEET_DOCKER_CAPABILITY, type FleetContainerView } from '@ever-works/contracts';
import { fleetContainerAction, listFleetContainersAction } from '@/app/actions/fleet/machine';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { Button } from '@/components/ui/button';
import { computerActionAllowed, type FleetOverviewBlockProps } from '../registry';
import { ConfirmActionDialog } from '../machine/ConfirmActionDialog';
import { dialogForRow } from '../machine/machine-actions.shared';
import { useMachineAction } from '../machine/use-machine-action';
import { useMachineList } from '../machine/use-machine-list';
import { containerGlyph, sortContainers } from './docker.shared';
import { VirtualRunsHereRows } from '../virtual/VirtualRunsHereRows';

/** The Overview reads less often than the Docker tab. */
const REFRESH_MS = 30_000;

/**
 * Docker on computers (FL-09 P2, spec §5.8, FR-30) — the computer Overview's
 * **Runs here** block: the machine's containers, running first, each with
 * Start or Stop behind the shared confirm dialog, and a link to the Docker
 * tab. Registered through the FL-01 registry (`registerOverviewBlock`);
 * FL-16 adds its nested computers to the same line. Renders nothing for a
 * computer that does not advertise Docker, and nothing while it is offline —
 * the Overview already says so.
 */
export default function RunsHereBlock({ nodes, flags }: FleetOverviewBlockProps) {
    const node = nodes[0];
    const enabled = !!node && (node.capabilities ?? []).includes(FLEET_DOCKER_CAPABILITY);
    if (!node || !enabled) return null;
    // Virtual computers (FL-16, FR-32): this host's virtual computers are rows
    // of THIS block (with Start / Stop and the memory they reserve), never a
    // second block.
    const virtualRows =
        flags?.FLEET_VIRTUAL_ENABLED === true ? (
            <VirtualRunsHereRows
                hostNodeId={node.id}
                allowed={computerActionAllowed(node, 'machines')}
            />
        ) : null;
    return (
        <RunsHere
            nodeId={node.id}
            nodeName={node.name}
            allowed={computerActionAllowed(node, 'docker')}
            extra={virtualRows}
        />
    );
}

function RunsHere({
    nodeId,
    nodeName,
    allowed,
    extra = null,
}: {
    nodeId: string;
    nodeName: string;
    allowed: boolean;
    /** FL-16's virtual-computer rows, rendered inside this block. */
    extra?: ReactNode;
}) {
    const t = useTranslations('fleet.docker');
    const load = useCallback(() => listFleetContainersAction(nodeId), [nodeId]);
    const list = useMachineList(load, REFRESH_MS);
    const machineAction = useMachineAction<Record<string, unknown>>();
    const rows = sortContainers(list.data?.containers ?? []).slice(0, 12);
    if (!list.data || !list.data.docker.daemonRunning || (rows.length === 0 && !extra)) return null;

    const act = (container: FleetContainerView, action: 'start' | 'stop') => {
        const label = t(`act.${action}`);
        machineAction.request({
            key: `container:${container.id}`,
            dialog: dialogForRow({
                class: container.confirmation[action],
                title: t('dialog.title', {
                    action: label,
                    name: container.name,
                    machine: nodeName,
                }),
            }),
            actionLabel: label,
            run: (fields) =>
                fleetContainerAction(nodeId, { container: container.id, action, fields }),
            onDone: () => {
                toast.success(t('done', { action: label, name: container.name }));
                void list.refresh();
            },
            onError: (error) =>
                toast.error(
                    error.hint ? t('actionFailedWith', { hint: error.hint }) : t('actionFailed'),
                ),
        });
    };

    return (
        <section
            className="rounded-xl border border-border dark:border-border-dark p-3"
            aria-label={t('runsHere.title')}
            data-testid="fleet-runs-here"
        >
            <div className="flex flex-wrap items-center gap-3 text-sm">
                <h3 className="font-semibold">{t('runsHere.title')}</h3>
                {rows.map((container) => (
                    <span
                        key={container.id}
                        className="inline-flex items-center gap-1"
                        data-testid="fleet-runs-here-item"
                    >
                        <span
                            aria-hidden
                            className={
                                container.state === 'running'
                                    ? 'text-success'
                                    : 'text-text-muted dark:text-text-muted-dark'
                            }
                        >
                            {containerGlyph(container)}
                        </span>
                        <span>{container.name}</span>
                        {container.state !== 'running' ? (
                            <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                ({container.state})
                            </span>
                        ) : null}
                        {allowed &&
                        container.actions.includes(
                            container.state === 'running' ? 'stop' : 'start',
                        ) ? (
                            <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={machineAction.busyKey === `container:${container.id}`}
                                onClick={() =>
                                    act(container, container.state === 'running' ? 'stop' : 'start')
                                }
                            >
                                {container.state === 'running' ? t('act.stop') : t('act.start')}
                            </Button>
                        ) : null}
                    </span>
                ))}
                <Link
                    className="ml-auto text-xs underline"
                    href={ROUTES.DASHBOARD_FLEET_COMPUTER(nodeId, 'docker')}
                >
                    {t('runsHere.open')}
                </Link>
            </div>
            {extra}
            <ConfirmActionDialog
                model={machineAction.dialog}
                actionLabel={machineAction.actionLabel}
                pending={machineAction.isPending}
                onConfirm={machineAction.confirm}
                onCancel={machineAction.cancel}
            />
        </section>
    );
}
