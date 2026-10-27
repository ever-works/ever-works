'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type {
    FleetContainerAction,
    FleetContainerView,
    FleetImageView,
    FleetLinkError,
    FleetRunRequest,
} from '@ever-works/contracts';
import {
    fleetContainerAction,
    listFleetContainersAction,
    listFleetImagesAction,
    pruneFleetImagesAction,
    pullFleetImageAction,
    removeFleetImageAction,
    runFleetContainerAction,
} from '@/app/actions/fleet/machine';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { Button } from '@/components/ui/button';
import { computerActionAllowed, type FleetComputerTabProps } from '../registry';
import { ConfirmActionDialog } from '../machine/ConfirmActionDialog';
import { MachineTabNotice } from '../machine/MachineTabNotice';
import { OperationCard } from '../machine/OperationCard';
import { RootRequiredDialog } from '../machine/RootRequiredDialog';
import {
    dialogForRow,
    formatBytes,
    formatPercent,
    formatSince,
} from '../machine/machine-actions.shared';
import { useMachineAction } from '../machine/use-machine-action';
import { useMachineList } from '../machine/use-machine-list';
import { containerGlyph, imageName, portsText, sortContainers } from './docker.shared';
import { ComposeView } from './ComposeView';
import { RunContainerDialog } from './RunContainerDialog';
import { ShellInsideButton } from './ShellInsideButton';

/** Lists refresh every 10 s while the tab is visible, and at once after an act. */
const REFRESH_MS = 10_000;

type View = 'containers' | 'images' | 'compose';

interface RunningOperation {
    id: string;
    title: string;
    doneTitle: string;
}

/**
 * Docker on computers (FL-09 P2, spec §5.5) — the Docker tab: Containers
 * (Start / Stop / Restart / Remove / Logs, Run a container) and Images (Pull,
 * Run, Remove, Remove unused), every act through the shared confirm dialog
 * (Remove needs the container's name typed), long acts as operation cards.
 * Docker not installed (U6) or not running (U7) is said in words. Compose
 * projects (P3) have their own view (`ComposeView`), and every running
 * container offers Shell inside (an owner Session, FL-04).
 */
export default function DockerTab({ node }: FleetComputerTabProps) {
    const t = useTranslations('fleet.docker');
    const tActions = useTranslations('fleet.actions');
    const [view, setView] = useState<View>('containers');
    const [runOpen, setRunOpen] = useState<{ image?: string } | null>(null);
    const [pullRef, setPullRef] = useState('');
    const [operations, setOperations] = useState<RunningOperation[]>([]);
    const allowed = computerActionAllowed(node, 'docker');
    const loadContainers = useCallback(() => listFleetContainersAction(node.id), [node.id]);
    const loadImages = useCallback(() => listFleetImagesAction(node.id), [node.id]);
    const containers = useMachineList(loadContainers, REFRESH_MS);
    const images = useMachineList(loadImages, REFRESH_MS * 3);
    const machineAction = useMachineAction<Record<string, unknown>>();

    const onError = (error: FleetLinkError) => {
        toast.error(error.hint ? t('actionFailedWith', { hint: error.hint }) : t('actionFailed'));
    };
    const refreshAll = () => {
        void containers.refresh();
        void images.refresh();
    };
    const track = (result: Record<string, unknown>, title: string, doneTitle: string) => {
        if (typeof result.operationId === 'string') {
            setOperations((previous) => [
                ...previous,
                { id: result.operationId as string, title, doneTitle },
            ]);
        } else {
            toast.success(doneTitle);
            refreshAll();
        }
    };

    const actOnContainer = (container: FleetContainerView, action: FleetContainerAction) => {
        const label = t(`act.${action}`);
        machineAction.request({
            key: `container:${container.id}`,
            dialog: dialogForRow({
                class: container.confirmation[action],
                title: t('dialog.title', {
                    action: label,
                    name: container.name,
                    machine: node.name,
                }),
                body: action === 'remove' ? t('dialog.removeBody') : undefined,
                typeName: container.name,
            }),
            actionLabel: label,
            run: (fields) =>
                fleetContainerAction(node.id, { container: container.id, action, fields }),
            onDone: () => {
                toast.success(t('done', { action: label, name: container.name }));
                refreshAll();
            },
            onError,
        });
    };

    const run = (request: FleetRunRequest) => {
        machineAction.request({
            key: 'run',
            dialog: null,
            actionLabel: t('run'),
            // The Run dialog, with its command line, IS the confirmation (FR-28).
            run: (fields) =>
                runFleetContainerAction(node.id, { request, fields: { ...fields, confirm: true } }),
            onDone: (result) => {
                setRunOpen(null);
                track(
                    result,
                    t('running', { image: request.image, name: node.name }),
                    t('ran', { image: request.image }),
                );
            },
            onError,
        });
    };

    const pull = (ref: string) => {
        machineAction.request({
            key: 'pull',
            dialog: { class: 'confirm', title: t('dialog.pullTitle', { ref, machine: node.name }) },
            actionLabel: t('pull'),
            run: (fields) => pullFleetImageAction(node.id, { ref, fields }),
            onDone: (result) => {
                setPullRef('');
                track(result, t('pulling', { ref, name: node.name }), t('pulled', { ref }));
            },
            onError,
        });
    };

    const removeImage = (image: FleetImageView) => {
        machineAction.request({
            key: `image:${image.id}`,
            dialog: {
                class: 'confirm',
                title: t('dialog.removeImageTitle', { name: imageName(image), machine: node.name }),
            },
            actionLabel: t('act.remove'),
            run: (fields) => removeFleetImageAction(node.id, { id: image.id, fields }),
            onDone: () => {
                toast.success(t('imageRemoved', { name: imageName(image) }));
                refreshAll();
            },
            onError,
        });
    };

    const prune = (count: number, bytes: number) => {
        machineAction.request({
            key: 'prune',
            dialog: {
                class: 'confirm',
                title: t('dialog.pruneTitle', { machine: node.name }),
                body: t('dialog.pruneBody', { count, size: formatBytes(bytes) }),
            },
            actionLabel: t('removeUnused'),
            run: (fields) => pruneFleetImagesAction(node.id, { fields }),
            onDone: (result) => {
                if (result.nothingToDo === true)
                    toast.message(t('nothingToRemove', { name: node.name }));
                else track(result, t('pruning', { name: node.name }), t('pruned'));
            },
            onError,
        });
    };

    const docker = containers.data?.docker ?? images.data?.docker;
    const firstError = !containers.data ? containers.error : null;

    if (!containers.data && containers.loading) {
        return (
            <p
                role="status"
                className="text-sm text-text-muted dark:text-text-muted-dark"
                data-testid="fleet-docker-loading"
            >
                {containers.slow
                    ? tActions('states.slow', { name: node.name })
                    : tActions('states.asking', { name: node.name })}
            </p>
        );
    }
    if (firstError) {
        return (
            <MachineTabNotice
                error={firstError}
                machine={node.name}
                family={t('family')}
                onRetry={refreshAll}
                testId="fleet-docker-notice"
            />
        );
    }
    if (docker && !docker.installed) {
        return (
            <p
                role="status"
                className="rounded-xl border border-dashed border-border dark:border-border-dark p-8 text-center text-sm"
                data-testid="fleet-docker-not-installed"
            >
                {t('notInstalled', { name: node.name })}{' '}
                <a
                    className="underline"
                    href="https://docs.docker.com/engine/install/"
                    target="_blank"
                    rel="noreferrer"
                >
                    {t('installLink')}
                </a>
            </p>
        );
    }
    if (docker && !docker.daemonRunning) {
        return (
            <div
                role="status"
                className="rounded-xl border border-dashed border-border dark:border-border-dark p-8 text-center text-sm space-y-2"
                data-testid="fleet-docker-daemon-down"
            >
                <p>{t('daemonDown', { name: node.name })}</p>
                <Link
                    className="underline"
                    href={ROUTES.DASHBOARD_FLEET_COMPUTER(node.id, 'services')}
                >
                    {t('startDocker')}
                </Link>
            </div>
        );
    }

    const containerRows = sortContainers(containers.data?.containers ?? []);
    const imageRows = images.data?.images ?? [];

    return (
        <section className="space-y-3" data-testid="fleet-docker-tab" aria-label={t('title')}>
            {containers.error ? (
                <p
                    role="status"
                    className="rounded-md border border-warning/40 bg-warning/5 p-2 text-sm"
                >
                    {containers.error.code === 'kill_switch'
                        ? tActions('states.killSwitchLastKnown')
                        : tActions('states.lastKnown', { name: node.name })}
                </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
                <div role="tablist" aria-label={t('title')} className="flex gap-1">
                    {(['containers', 'images', 'compose'] as const).map((id) => (
                        <Button
                            key={id}
                            type="button"
                            role="tab"
                            aria-selected={view === id}
                            size="sm"
                            variant={view === id ? 'primary' : 'ghost'}
                            onClick={() => setView(id)}
                        >
                            {id === 'containers'
                                ? t('tabs.containers', { count: containerRows.length })
                                : id === 'images'
                                  ? t('tabs.images', { count: imageRows.length })
                                  : t('tabs.compose')}
                        </Button>
                    ))}
                </div>
                <span className="ml-auto flex gap-2">
                    <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        disabled={!allowed}
                        onClick={() => setRunOpen({})}
                        data-testid="fleet-docker-run-open"
                    >
                        {t('runContainer')}
                    </Button>
                </span>
            </div>
            {!allowed ? (
                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                    {t('ownerOnly', { name: node.name })}
                </p>
            ) : null}
            {operations.map((operation) => (
                <OperationCard
                    key={operation.id}
                    operationId={operation.id}
                    title={operation.title}
                    doneTitle={operation.doneTitle}
                    onDone={refreshAll}
                    onDismiss={() =>
                        setOperations((previous) =>
                            previous.filter((entry) => entry.id !== operation.id),
                        )
                    }
                />
            ))}

            {view === 'containers' ? (
                containerRows.length === 0 ? (
                    <p role="status" className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('noContainers', { name: node.name })}
                    </p>
                ) : (
                    <div className="overflow-x-auto rounded-xl border border-border dark:border-border-dark">
                        <table className="w-full text-sm" data-testid="fleet-docker-containers">
                            <thead className="text-left text-xs uppercase text-text-muted dark:text-text-muted-dark">
                                <tr>
                                    <th className="px-3 py-2">{t('columns.name')}</th>
                                    <th className="px-3 py-2">{t('columns.image')}</th>
                                    <th className="px-3 py-2">{t('columns.state')}</th>
                                    <th className="px-3 py-2">{t('columns.ports')}</th>
                                    <th className="px-3 py-2 text-right">{t('columns.cpu')}</th>
                                    <th className="px-3 py-2 text-right">{t('columns.memory')}</th>
                                    <th className="px-3 py-2">{t('columns.project')}</th>
                                    <th className="px-3 py-2">
                                        <span className="sr-only">{t('columns.actions')}</span>
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {containerRows.map((container) => {
                                    const busy =
                                        machineAction.busyKey === `container:${container.id}`;
                                    return (
                                        <tr
                                            key={container.id}
                                            className="border-t border-border dark:border-border-dark"
                                            data-testid="fleet-docker-container"
                                            data-name={container.name}
                                        >
                                            <td className="px-3 py-1.5">
                                                <span
                                                    aria-hidden
                                                    className={
                                                        container.state === 'running'
                                                            ? 'text-success'
                                                            : 'text-text-muted dark:text-text-muted-dark'
                                                    }
                                                >
                                                    {containerGlyph(container)}
                                                </span>{' '}
                                                <span className="font-medium">
                                                    {container.name}
                                                </span>
                                            </td>
                                            <td className="px-3 py-1.5 font-mono text-xs">
                                                {container.image}
                                            </td>
                                            <td className="px-3 py-1.5">
                                                {busy
                                                    ? t('working')
                                                    : container.status || container.state}
                                            </td>
                                            <td className="px-3 py-1.5 text-xs">
                                                {portsText(container.ports)}
                                            </td>
                                            <td className="px-3 py-1.5 text-right tabular-nums">
                                                {formatPercent(container.cpuPercent)}
                                            </td>
                                            <td className="px-3 py-1.5 text-right tabular-nums">
                                                {formatBytes(container.memBytes)}
                                            </td>
                                            <td className="px-3 py-1.5 text-xs">
                                                {container.composeProject ?? '—'}
                                            </td>
                                            <td className="px-3 py-1.5">
                                                <div className="flex justify-end gap-1">
                                                    {container.actions.map((action) => (
                                                        <Button
                                                            key={action}
                                                            type="button"
                                                            size="sm"
                                                            variant={
                                                                action === 'remove'
                                                                    ? 'ghost'
                                                                    : 'secondary'
                                                            }
                                                            disabled={!allowed || busy}
                                                            onClick={() =>
                                                                actOnContainer(container, action)
                                                            }
                                                            data-testid={`fleet-docker-${action}`}
                                                        >
                                                            {t(`act.${action}`)}
                                                        </Button>
                                                    ))}
                                                    {container.state === 'running' ? (
                                                        <ShellInsideButton
                                                            nodeId={node.id}
                                                            container={container.id}
                                                            disabled={!allowed}
                                                        />
                                                    ) : null}
                                                    <Button
                                                        type="button"
                                                        size="sm"
                                                        variant="ghost"
                                                        href={`${ROUTES.DASHBOARD_FLEET_COMPUTER(node.id, 'logs')}&source=container&container=${encodeURIComponent(container.name)}`}
                                                    >
                                                        {t('logs')}
                                                    </Button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )
            ) : null}

            {view === 'images' ? (
                <div className="space-y-2">
                    <form
                        className="flex flex-wrap items-center gap-2"
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (pullRef.trim()) pull(pullRef.trim());
                        }}
                    >
                        <input
                            value={pullRef}
                            onChange={(event) => setPullRef(event.target.value)}
                            placeholder="redis:7"
                            aria-label={t('pullLabel')}
                            spellCheck={false}
                            className="h-8 w-56 rounded-md border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2 text-sm"
                        />
                        <Button
                            type="submit"
                            size="sm"
                            variant="secondary"
                            disabled={!allowed || !pullRef.trim()}
                        >
                            {t('pull')}
                        </Button>
                        {images.data && images.data.unusedCount > 0 ? (
                            <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="ml-auto"
                                disabled={!allowed}
                                onClick={() =>
                                    prune(images.data!.unusedCount, images.data!.unusedBytes)
                                }
                                data-testid="fleet-docker-prune"
                            >
                                {t('removeUnusedCount', {
                                    count: images.data.unusedCount,
                                    size: formatBytes(images.data.unusedBytes),
                                })}
                            </Button>
                        ) : null}
                    </form>
                    {imageRows.length === 0 ? (
                        <p
                            role="status"
                            className="text-sm text-text-muted dark:text-text-muted-dark"
                        >
                            {t('images.empty', { name: node.name })}
                        </p>
                    ) : (
                        <div className="overflow-x-auto rounded-xl border border-border dark:border-border-dark">
                            <table className="w-full text-sm" data-testid="fleet-docker-images">
                                <thead className="text-left text-xs uppercase text-text-muted dark:text-text-muted-dark">
                                    <tr>
                                        <th className="px-3 py-2">{t('images.columns.tag')}</th>
                                        <th className="px-3 py-2">{t('images.columns.id')}</th>
                                        <th className="px-3 py-2 text-right">
                                            {t('images.columns.size')}
                                        </th>
                                        <th className="px-3 py-2">{t('images.columns.age')}</th>
                                        <th className="px-3 py-2">{t('images.columns.used')}</th>
                                        <th className="px-3 py-2">
                                            <span className="sr-only">{t('columns.actions')}</span>
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {imageRows.map((image) => (
                                        <tr
                                            key={image.id}
                                            className="border-t border-border dark:border-border-dark"
                                            data-testid="fleet-docker-image"
                                        >
                                            <td className="px-3 py-1.5 font-mono text-xs">
                                                {imageName(image)}
                                            </td>
                                            <td className="px-3 py-1.5 font-mono text-xs">
                                                {image.id}
                                            </td>
                                            <td className="px-3 py-1.5 text-right tabular-nums">
                                                {formatBytes(image.sizeBytes)}
                                            </td>
                                            <td className="px-3 py-1.5 text-xs">
                                                {formatSince(image.createdAt) ?? '—'}
                                            </td>
                                            <td className="px-3 py-1.5 text-xs">
                                                {image.inUseBy > 0
                                                    ? t('images.usedBy', { count: image.inUseBy })
                                                    : t('images.unused')}
                                            </td>
                                            <td className="px-3 py-1.5">
                                                <div className="flex justify-end gap-1">
                                                    <Button
                                                        type="button"
                                                        size="sm"
                                                        variant="secondary"
                                                        disabled={
                                                            !allowed || image.repoTags.length === 0
                                                        }
                                                        onClick={() =>
                                                            setRunOpen({ image: image.repoTags[0] })
                                                        }
                                                    >
                                                        {t('run')}
                                                    </Button>
                                                    <Button
                                                        type="button"
                                                        size="sm"
                                                        variant="ghost"
                                                        disabled={!allowed || image.inUseBy > 0}
                                                        title={
                                                            image.inUseBy > 0
                                                                ? t('images.inUseHint')
                                                                : undefined
                                                        }
                                                        onClick={() => removeImage(image)}
                                                    >
                                                        {t('act.remove')}
                                                    </Button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            ) : null}

            {view === 'compose' ? (
                <ComposeView
                    nodeId={node.id}
                    machine={node.name}
                    allowed={allowed}
                    machineAction={machineAction}
                    onOperation={track}
                />
            ) : null}

            <RunContainerDialog
                key={runOpen?.image ?? 'blank'}
                open={runOpen !== null}
                machine={node.name}
                initialImage={runOpen?.image}
                pending={machineAction.isPending && machineAction.busyKey === 'run'}
                onRun={run}
                onClose={() => setRunOpen(null)}
            />
            <ConfirmActionDialog
                model={machineAction.dialog}
                actionLabel={machineAction.actionLabel}
                pending={machineAction.isPending}
                onConfirm={machineAction.confirm}
                onCancel={machineAction.cancel}
            />
            <RootRequiredDialog
                model={machineAction.root}
                machine={node.name}
                onClose={machineAction.closeRoot}
            />
        </section>
    );
}
