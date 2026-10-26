'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus, Workflow } from 'lucide-react';
import {
    FLEET_ACTIONS_RUNNERS_OPEN_REFRESH_MS,
    type FleetActionsRunnerOptionsView,
    type FleetActionsRunnersListView,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import {
    fleetActionsRunnerOptionsAction,
    listFleetActionsRunnersAction,
    type FleetActionsRunnersResult,
} from '@/app/actions/fleet/runners';
import { computerActionAllowed, type FleetOverviewBlockProps } from '../registry';
import { useMachineList } from '../machine/use-machine-list';
import { InstallRunnersDialog } from './InstallRunnersDialog';
import { RunnerActionsMenu } from './RunnerActionsMenu';
import { RunnerRow } from './RunnerRow';
import { RUNNERS_INSTALL_PARAM, RUNNERS_INSTALL_VALUE, formatClock } from './runners.shared';

const NOT_FOUND: FleetActionsRunnersResult<FleetActionsRunnersListView> = {
    ok: false,
    error: { code: 'not_found', hint: '' },
};

/**
 * Actions runners on computers (FL-18 P1, spec §0, §5.2, FR-1, FR-13, FR-14) —
 * the **Actions runners** block on a computer's Overview:
 *
 * ```
 * Actions runners (2)                                     checked 09:41   [+ Install runners]
 *   ● build-01-1   acme/api   idle      self-hosted Linux X64 gpu
 *   ◐ build-01-2   acme/api   working   "test · ubuntu" run #4821
 * ```
 *
 * One row per runner (`RunnerRow`, with its acts in `RunnerActionsMenu`),
 * when GitHub was last read, and the two notes the list carries: GitHub is
 * rate-limiting (U17), and the kill switch (runners keep running; installing
 * and controlling them is paused, U14). Re-read every
 * {@link FLEET_ACTIONS_RUNNERS_OPEN_REFRESH_MS} while the page is visible (the
 * last good answer is kept when a later read is refused). **Install runners**
 * is offered to the computer's `machines` audience only, disabled with the
 * server's reason when the computer cannot host runners (FR-1). Renders
 * nothing while runners are switched off on this deployment (the API answers
 * 404) or outside a single computer's page.
 */
export default function RunnersBlock({ nodes }: FleetOverviewBlockProps) {
    const t = useTranslations('fleet.runners');
    const node = nodes.length === 1 ? nodes[0] : null;
    const nodeId = node?.id ?? null;
    // The page's mirror of the server's family check — the server still decides.
    const allowed = node ? computerActionAllowed(node, 'machines') : false;
    const searchParams = useSearchParams();
    const [installOpen, setInstallOpen] = useState(
        () => allowed && searchParams?.get(RUNNERS_INSTALL_PARAM) === RUNNERS_INSTALL_VALUE,
    );
    const [options, setOptions] = useState<FleetActionsRunnerOptionsView | null>(null);
    const [optionsKey, setOptionsKey] = useState(0);

    const load = useCallback(
        () => (nodeId ? listFleetActionsRunnersAction(nodeId) : Promise.resolve(NOT_FOUND)),
        [nodeId],
    );
    const { data, error, loading, refresh } = useMachineList(
        load,
        FLEET_ACTIONS_RUNNERS_OPEN_REFRESH_MS,
    );
    const switchedOff = !data && error?.code === 'not_found';

    // Whether the computer can host runners, for the Install button's state (FR-1).
    useEffect(() => {
        if (!nodeId || !allowed || switchedOff) return;
        let live = true;
        void fleetActionsRunnerOptionsAction(nodeId).then((result) => {
            if (live) setOptions(result.ok ? result.data : null);
        });
        return () => {
            live = false;
        };
    }, [nodeId, allowed, switchedOff, optionsKey]);

    if (!node || switchedOff) return null;

    const runners = data?.runners ?? [];
    const killSwitch = data?.killSwitch === true;
    const checked = formatClock(data?.checkedAt);
    const rateLimitedUntil = data?.rateLimitedUntil ? formatClock(data.rateLimitedUntil) : null;
    const cannotHost = options !== null && !options.canHost;
    const installReason = killSwitch
        ? t('block.killSwitch')
        : cannotHost
          ? (options?.hint ?? t('block.cannotInstall', { name: node.name }))
          : undefined;

    const changed = () => {
        void refresh();
        setOptionsKey((key) => key + 1);
    };

    return (
        <section
            className="rounded-lg border border-border p-4 text-sm dark:border-border-dark"
            aria-labelledby="fleet-runners-block-title"
            data-testid="fleet-runners-block"
        >
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <h3
                    id="fleet-runners-block-title"
                    className="flex items-center gap-2 font-semibold"
                >
                    <Workflow className="h-4 w-4" aria-hidden="true" />
                    {data && runners.length > 0
                        ? t('block.titleCount', { count: runners.length })
                        : t('block.title')}
                </h3>
                {data ? (
                    <span
                        className="text-xs text-text-muted dark:text-text-muted-dark"
                        data-testid="fleet-runners-checked"
                    >
                        {checked ? t('block.checked', { time: checked }) : t('block.notChecked')}
                    </span>
                ) : null}
                {allowed ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="ml-auto"
                        onClick={() => setInstallOpen(true)}
                        disabled={Boolean(installReason)}
                        title={installReason}
                        data-testid="fleet-runners-install"
                    >
                        <Plus className="h-4 w-4" aria-hidden />
                        {t('install.button')}
                    </Button>
                ) : null}
            </div>

            {cannotHost && !killSwitch && installReason ? (
                <p
                    className="mb-2 text-xs text-text-muted dark:text-text-muted-dark"
                    data-testid="fleet-runners-cannot-host"
                >
                    {installReason}
                </p>
            ) : null}
            {killSwitch ? (
                <p
                    className="mb-2 rounded-md bg-warning/10 p-2 text-xs text-warning"
                    role="status"
                    data-testid="fleet-runners-kill-switch"
                >
                    {t('block.killSwitch')}
                </p>
            ) : null}
            {data?.rateLimitedUntil ? (
                <p
                    className="mb-2 text-xs text-warning"
                    role="status"
                    data-testid="fleet-runners-rate-limited"
                >
                    {rateLimitedUntil
                        ? t('block.rateLimited', { time: rateLimitedUntil })
                        : t('block.rateLimitedWait')}
                </p>
            ) : null}
            {data && error ? (
                <p className="mb-2 text-xs text-warning" role="status">
                    {t('block.lastKnown', { reason: error.hint || t('block.loadFailed') })}
                </p>
            ) : null}

            {!data ? (
                loading ? (
                    <p className="text-text-muted dark:text-text-muted-dark" role="status">
                        {t('block.loading')}
                    </p>
                ) : (
                    <p className="text-danger" role="alert">
                        {error?.hint || t('block.loadFailed')}
                    </p>
                )
            ) : runners.length === 0 ? (
                <div data-testid="fleet-runners-empty">
                    <p>{t('block.empty', { name: node.name })}</p>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('block.emptyHint', { name: node.name })}
                    </p>
                </div>
            ) : (
                <ul aria-label={t('block.listLabel', { name: node.name })}>
                    {runners.map((runner) => (
                        <RunnerRow
                            key={runner.id}
                            runner={runner}
                            nodeId={node.id}
                            computer={node.name}
                            actions={
                                <RunnerActionsMenu
                                    runner={runner}
                                    nodeId={node.id}
                                    computer={node.name}
                                    allowed={allowed}
                                    paused={killSwitch}
                                    onChanged={changed}
                                />
                            }
                        />
                    ))}
                </ul>
            )}

            {allowed ? (
                <InstallRunnersDialog
                    open={installOpen}
                    nodeId={node.id}
                    computer={node.name}
                    existingNames={runners.map((runner) => runner.name)}
                    onClose={() => setInstallOpen(false)}
                    onInstalled={changed}
                />
            ) : null}
        </section>
    );
}
