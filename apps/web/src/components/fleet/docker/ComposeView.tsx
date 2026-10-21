'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type {
    FleetComposeAction,
    FleetComposeDescription,
    FleetComposeProjectView,
    FleetComposeServiceView,
    FleetLinkError,
} from '@ever-works/contracts';
import {
    describeFleetComposeAction,
    fleetComposeAction,
    fleetContainerAction,
    listFleetComposeAction,
} from '@/app/actions/fleet/machine';
import { ROUTES } from '@/lib/constants';
import { Button } from '@/components/ui/button';
import { formatBytes, formatPercent } from '../machine/machine-actions.shared';
import { MachineTabNotice } from '../machine/MachineTabNotice';
import { useMachineList } from '../machine/use-machine-list';
import type { useMachineAction } from '../machine/use-machine-action';
import { BOX_HEIGHT, BOX_WIDTH, layoutCompose } from './compose-layout';
import { portsText } from './docker.shared';
import { ShellInsideButton } from './ShellInsideButton';

const REFRESH_MS = 10_000;

/** Stable colours for network tags (the picture's "networks as coloured tags", FR-33). */
const NETWORK_TONES = ['#2563eb', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#db2777'];

function toneOf(name: string): string {
    let hash = 0;
    for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return NETWORK_TONES[hash % NETWORK_TONES.length];
}

const EDGE_COLOURS = { grey: '#94a3b8', amber: '#f59e0b', red: '#ef4444' } as const;

/**
 * Compose on computers (FL-09 P3, spec §5.7, S11, S12, FR-32 – FR-34) — the
 * Docker tab's Compose view: the projects Docker knows, then one project in
 * three views — **Picture** (service boxes with image, state, health, CPU,
 * memory, host ports, networks as coloured tags, named volumes and mounted
 * files; `depends_on` arrows, amber while a `service_healthy` dependency is
 * not healthy, red while it is down), **List** (per-service Start / Stop /
 * Restart / Shell / Logs) and **Logs** (the Logs tab's merged view, FL-08) —
 * with Up / Down / Restart / Pull as operations in the header.
 */
export function ComposeView({
    nodeId,
    machine,
    allowed,
    machineAction,
    onOperation,
}: {
    nodeId: string;
    machine: string;
    allowed: boolean;
    machineAction: ReturnType<typeof useMachineAction<Record<string, unknown>>>;
    onOperation: (result: Record<string, unknown>, title: string, doneTitle: string) => void;
}) {
    const t = useTranslations('fleet.docker.compose');
    const tDocker = useTranslations('fleet.docker');
    const [selected, setSelected] = useState<string | null>(null);
    const loadList = useCallback(() => listFleetComposeAction(nodeId), [nodeId]);
    const list = useMachineList(loadList, REFRESH_MS * 3);

    if (!list.data && list.loading) {
        return <p role="status" className="text-sm text-text-muted dark:text-text-muted-dark">{t('loading')}</p>;
    }
    if (!list.data && list.error) {
        return <MachineTabNotice error={list.error} machine={machine} family="Compose" onRetry={() => void list.refresh()} testId="fleet-compose-notice" />;
    }
    const projects = list.data?.projects ?? [];
    if (projects.length === 0) {
        return <p role="status" className="text-sm text-text-muted dark:text-text-muted-dark">{t('empty', { name: machine })}</p>;
    }
    const current = projects.find((project) => project.name === selected) ?? null;

    return (
        <div className="space-y-3" data-testid="fleet-compose">
            <ul className="flex flex-wrap gap-2" aria-label={t('projects')}>
                {projects.map((project) => (
                    <li key={project.name}>
                        <Button
                            type="button"
                            size="sm"
                            variant={project.name === selected ? 'primary' : 'secondary'}
                            onClick={() => setSelected(project.name)}
                            data-testid="fleet-compose-project"
                        >
                            {project.name} · {project.filesMissing ? t('filesMissing') : project.status}
                        </Button>
                    </li>
                ))}
            </ul>
            {current ? (
                <ComposeProject
                    key={current.name}
                    nodeId={nodeId}
                    machine={machine}
                    project={current}
                    allowed={allowed}
                    machineAction={machineAction}
                    onOperation={onOperation}
                />
            ) : (
                <p className="text-sm text-text-muted dark:text-text-muted-dark">{tDocker('compose.pick')}</p>
            )}
        </div>
    );
}

function ComposeProject({
    nodeId,
    machine,
    project,
    allowed,
    machineAction,
    onOperation,
}: {
    nodeId: string;
    machine: string;
    project: FleetComposeProjectView;
    allowed: boolean;
    machineAction: ReturnType<typeof useMachineAction<Record<string, unknown>>>;
    onOperation: (result: Record<string, unknown>, title: string, doneTitle: string) => void;
}) {
    const t = useTranslations('fleet.docker.compose');
    const tDocker = useTranslations('fleet.docker');
    const [view, setView] = useState<'picture' | 'list'>('picture');
    const load = useCallback(() => describeFleetComposeAction(nodeId, project.name), [nodeId, project.name]);
    const described = useMachineList(load, REFRESH_MS);
    const onError = (error: FleetLinkError) =>
        toast.error(error.hint ? tDocker('actionFailedWith', { hint: error.hint }) : tDocker('actionFailed'));

    const act = (action: FleetComposeAction) => {
        const label = t(`act.${action}`);
        const volumes = described.data?.volumes ?? [];
        machineAction.request({
            key: `compose:${project.name}`,
            dialog: {
                class: 'confirm',
                title: t(`dialog.${action}`, { name: project.name, machine }),
                ...(action === 'down'
                    ? {
                          body: volumes.length > 0
                              ? t('dialog.downKeeps', { count: project.serviceCount, volumes: volumes.join(', ') })
                              : t('dialog.downKeepsNone', { count: project.serviceCount }),
                      }
                    : {}),
            },
            actionLabel: label,
            run: (fields) => fleetComposeAction(nodeId, { project: project.name, action, fields }),
            onDone: (result) => {
                onOperation(result, t(`running.${action}`, { name: project.name, machine }), t(`done.${action}`, { name: project.name }));
                void described.refresh();
            },
            onError,
        });
    };

    const serviceAct = (service: FleetComposeServiceView, action: 'start' | 'stop' | 'restart') => {
        if (!service.containerId) return;
        const label = tDocker(`act.${action}`);
        machineAction.request({
            key: `container:${service.containerId}`,
            dialog: {
                class: 'confirm',
                title: tDocker('dialog.title', { action: label, name: service.containerName ?? service.name, machine }),
            },
            actionLabel: label,
            run: (fields) => fleetContainerAction(nodeId, { container: service.containerId!, action, fields }),
            onDone: () => {
                toast.success(tDocker('done', { action: label, name: service.name }));
                void described.refresh();
            },
            onError,
        });
    };

    const logsHref = `${ROUTES.DASHBOARD_FLEET_COMPUTER(nodeId, 'logs')}&source=compose&project=${encodeURIComponent(project.name)}`;

    return (
        <section className="space-y-2 rounded-xl border border-border dark:border-border-dark p-3" aria-label={project.name}>
            <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">{project.name}</h3>
                <div role="tablist" className="flex gap-1">
                    {(['picture', 'list'] as const).map((id) => (
                        <Button key={id} type="button" role="tab" aria-selected={view === id} size="sm" variant={view === id ? 'primary' : 'ghost'} onClick={() => setView(id)}>
                            {t(id)}
                        </Button>
                    ))}
                    <Button type="button" size="sm" variant="ghost" href={logsHref}>
                        {t('logs')}
                    </Button>
                </div>
                <span className="ml-auto flex gap-1">
                    {(['up', 'down', 'restart', 'pull'] as const).map((action) => (
                        <Button
                            key={action}
                            type="button"
                            size="sm"
                            variant={action === 'down' ? 'ghost' : 'secondary'}
                            disabled={!allowed || !project.actions.includes(action) || machineAction.busyKey === `compose:${project.name}`}
                            title={!project.actions.includes(action) ? t('filesMissingHint') : undefined}
                            onClick={() => act(action)}
                            data-testid={`fleet-compose-${action}`}
                        >
                            {t(`act.${action}`)}
                        </Button>
                    ))}
                </span>
            </div>
            {project.filesMissing ? (
                <p role="status" className="text-sm text-warning">{t('filesMissingHint')}</p>
            ) : null}
            {!described.data && described.error ? (
                <MachineTabNotice error={described.error} machine={machine} family="Compose" onRetry={() => void described.refresh()} testId="fleet-compose-describe-notice" />
            ) : null}
            {described.data ? (
                view === 'picture' ? (
                    <ComposePicture description={described.data} />
                ) : (
                    <ServiceTable
                        nodeId={nodeId}
                        services={described.data.services}
                        allowed={allowed}
                        busyKey={machineAction.busyKey}
                        onAct={serviceAct}
                        logsHref={logsHref}
                    />
                )
            ) : null}
        </section>
    );
}

/** The SVG picture (FR-33): boxes laid out by `depends_on`, arrows coloured by the dependency's health. */
export function ComposePicture({ description }: { description: FleetComposeDescription }) {
    const t = useTranslations('fleet.docker.compose');
    const layout = useMemo(() => layoutCompose(description.services), [description.services]);
    const byName = new Map(description.services.map((service) => [service.name, service]));
    const boxOf = new Map(layout.boxes.map((box) => [box.name, box]));
    const pad = 12;

    return (
        <div className="overflow-auto" data-testid="fleet-compose-picture">
            <svg
                role="img"
                aria-label={t('pictureLabel', { count: description.services.length })}
                width={layout.width + pad * 2}
                height={layout.height + pad * 2}
                viewBox={`${-pad} ${-pad} ${layout.width + pad * 2} ${layout.height + pad * 2}`}
            >
                <defs>
                    {Object.entries(EDGE_COLOURS).map(([tone, colour]) => (
                        <marker key={tone} id={`fleet-compose-arrow-${tone}`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                            <path d="M0,0 L8,4 L0,8 z" fill={colour} />
                        </marker>
                    ))}
                </defs>
                {layout.edges.map((edge) => {
                    const from = boxOf.get(edge.from);
                    const to = boxOf.get(edge.to);
                    if (!from || !to) return null;
                    const x1 = from.x + BOX_WIDTH;
                    const y1 = from.y + BOX_HEIGHT / 2;
                    const x2 = to.x;
                    const y2 = to.y + BOX_HEIGHT / 2;
                    const mid = (x1 + x2) / 2;
                    return (
                        <path
                            key={`${edge.from}->${edge.to}`}
                            d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                            fill="none"
                            stroke={EDGE_COLOURS[edge.tone]}
                            strokeWidth={2}
                            markerEnd={`url(#fleet-compose-arrow-${edge.tone})`}
                            data-testid="fleet-compose-edge"
                            data-tone={edge.tone}
                        >
                            <title>{t(`edge.${edge.tone}`, { from: edge.from, to: edge.to })}</title>
                        </path>
                    );
                })}
                {layout.boxes.map((box) => {
                    const service = byName.get(box.name);
                    if (!service) return null;
                    const running = service.state === 'running';
                    return (
                        <g key={box.name} transform={`translate(${box.x},${box.y})`} data-testid="fleet-compose-box" data-state={service.state}>
                            <rect width={BOX_WIDTH} height={BOX_HEIGHT} rx={10} fill="none" stroke={running ? '#16a34a' : '#94a3b8'} strokeWidth={1.5} />
                            <text x={10} y={20} fontSize={13} fontWeight={600} fill="currentColor">
                                {service.name} {running ? '●' : '○'} {service.health ?? ''}
                            </text>
                            <text x={10} y={38} fontSize={11} fill="currentColor" opacity={0.75}>
                                {(service.image ?? '—').slice(0, 30)}
                            </text>
                            <text x={10} y={55} fontSize={11} fill="currentColor" opacity={0.75}>
                                {running ? `cpu ${formatPercent(service.cpuPercent)} · ${formatBytes(service.memBytes)}` : t(`state.${service.state === 'absent' ? 'absent' : 'stopped'}`)}
                            </text>
                            <text x={10} y={72} fontSize={11} fill="currentColor" opacity={0.75}>
                                {portsText(service.ports).slice(0, 34)}
                            </text>
                            <text x={10} y={89} fontSize={11} fill="currentColor" opacity={0.75}>
                                {[...service.volumes.map((volume) => `vol ${volume}`), ...service.mounts.map((mount) => `file ${mount.split(/[\\/]/).pop()}`)]
                                    .join(' · ')
                                    .slice(0, 34)}
                            </text>
                            {service.networks.slice(0, 3).map((network, index) => (
                                <g key={network} transform={`translate(${10 + index * 68},${96})`}>
                                    <rect width={64} height={12} rx={6} fill={toneOf(network)} opacity={0.2} />
                                    <text x={4} y={9} fontSize={9} fill={toneOf(network)}>
                                        {network.slice(0, 12)}
                                    </text>
                                </g>
                            ))}
                        </g>
                    );
                })}
            </svg>
        </div>
    );
}

function ServiceTable({
    nodeId,
    services,
    allowed,
    busyKey,
    onAct,
    logsHref,
}: {
    nodeId: string;
    services: FleetComposeServiceView[];
    allowed: boolean;
    busyKey: string | null;
    onAct: (service: FleetComposeServiceView, action: 'start' | 'stop' | 'restart') => void;
    logsHref: string;
}) {
    const t = useTranslations('fleet.docker.compose');
    const tDocker = useTranslations('fleet.docker');
    return (
        <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="fleet-compose-services">
                <thead className="text-left text-xs uppercase text-text-muted dark:text-text-muted-dark">
                    <tr>
                        <th className="px-2 py-1">{t('columns.service')}</th>
                        <th className="px-2 py-1">{t('columns.image')}</th>
                        <th className="px-2 py-1">{t('columns.state')}</th>
                        <th className="px-2 py-1">{t('columns.health')}</th>
                        <th className="px-2 py-1">{t('columns.ports')}</th>
                        <th className="px-2 py-1">{t('columns.volumes')}</th>
                        <th className="px-2 py-1">{t('columns.networks')}</th>
                        <th className="px-2 py-1">
                            <span className="sr-only">{tDocker('columns.actions')}</span>
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {services.map((service) => {
                        const running = service.state === 'running';
                        const busy = service.containerId ? busyKey === `container:${service.containerId}` : false;
                        return (
                            <tr key={service.name} className="border-t border-border dark:border-border-dark">
                                <td className="px-2 py-1 font-medium">{service.name}</td>
                                <td className="px-2 py-1 font-mono text-xs">{service.image ?? '—'}</td>
                                <td className="px-2 py-1">{service.state}</td>
                                <td className="px-2 py-1">{service.health ?? '—'}</td>
                                <td className="px-2 py-1 text-xs">{portsText(service.ports)}</td>
                                <td className="px-2 py-1 text-xs">{service.volumes.join(', ') || '—'}</td>
                                <td className="px-2 py-1 text-xs">{service.networks.join(', ') || '—'}</td>
                                <td className="px-2 py-1">
                                    <div className="flex justify-end gap-1">
                                        {service.containerId ? (
                                            running ? (
                                                <>
                                                    <Button type="button" size="sm" variant="secondary" disabled={!allowed || busy} onClick={() => onAct(service, 'stop')}>
                                                        {tDocker('act.stop')}
                                                    </Button>
                                                    <Button type="button" size="sm" variant="secondary" disabled={!allowed || busy} onClick={() => onAct(service, 'restart')}>
                                                        {tDocker('act.restart')}
                                                    </Button>
                                                    <ShellInsideButton nodeId={nodeId} container={service.containerId} disabled={!allowed} />
                                                </>
                                            ) : (
                                                <Button type="button" size="sm" variant="secondary" disabled={!allowed || busy} onClick={() => onAct(service, 'start')}>
                                                    {tDocker('act.start')}
                                                </Button>
                                            )
                                        ) : null}
                                        <Button type="button" size="sm" variant="ghost" href={logsHref}>
                                            {tDocker('logs')}
                                        </Button>
                                    </div>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
