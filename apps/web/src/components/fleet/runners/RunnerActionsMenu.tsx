'use client';

import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { MoreHorizontal } from 'lucide-react';
import type {
    FleetActionsRunnerOperationResponse,
    FleetActionsRunnerView,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
    fleetActionsRunnerControlAction,
    reinstallFleetActionsRunnerAction,
    removeFleetActionsRunnerAction,
} from '@/app/actions/fleet/runners';
import { ConfirmActionDialog } from '../machine/ConfirmActionDialog';
import { RootRequiredDialog } from '../machine/RootRequiredDialog';
import { useMachineAction } from '../machine/use-machine-action';
import {
    runnerActAvailability,
    runnerActDialog,
    runnerReinstallAvailability,
    runnerReinstallDialog,
    runnerReinstallPlacement,
    type RunnerRowAct,
} from './runners.shared';

/**
 * Actions runners on computers (FL-18 P1, spec §4.3, §5.2, §5.3, FR-15,
 * FR-16) — one runner's acts: **Start** (no dialog), **Stop** and **Restart**
 * (`confirm`, with the contracts' sentence), and **⋯ › Remove runner…**
 * (`confirm-destructive`: type the runner's name). Which acts a row offers
 * follows its state (`runnerActAvailability`); the server still decides each
 * one, and its refusal (`busy` mid-job, `kill_switch`, `permission_denied`) is
 * shown as a toast with its hint. A `confirmation_required` the row did not
 * expect reopens the dialog the server describes; `root_required` shows the
 * exact command (FL-09's dialog). Disabled with the reason when the viewer is
 * outside the computer's `machines` audience or while all computers are
 * stopped.
 *
 * P3 (FR-28): **Reinstall…** (`confirm`, with the contracts' sentence naming
 * the newer build) for an idle, offline, stopped or failed runner — in the row
 * as **Retry** on a failed install or when an update is available, else in the
 * ⋯ menu beside Remove runner….
 */
export function RunnerActionsMenu({
    runner,
    nodeId,
    computer,
    allowed,
    paused,
    onChanged,
}: {
    runner: FleetActionsRunnerView;
    nodeId: string;
    /** The computer's name, for the dialogs. */
    computer: string;
    /** Whether the viewer is in the computer's `machines` audience (the server still decides). */
    allowed: boolean;
    /** The kill switch is on: runners keep running; their controls are paused. */
    paused: boolean;
    /** Re-read the list after an act was accepted. */
    onChanged: () => void;
}) {
    const t = useTranslations('fleet.runners');
    const action = useMachineAction<FleetActionsRunnerOperationResponse>();
    const availability = runnerActAvailability(runner);
    const busy = action.isPending && (action.busyKey?.startsWith(`${runner.id}:`) ?? false);
    const blocked = !allowed
        ? t('actions.notAllowed', { computer })
        : paused
          ? t('actions.paused')
          : undefined;

    const verb = (act: RunnerRowAct): string =>
        act === 'remove'
            ? t('remove.confirm')
            : act === 'start'
              ? t('actions.start')
              : act === 'stop'
                ? t('actions.stop')
                : t('actions.restart');

    const done = (act: RunnerRowAct): string =>
        act === 'remove'
            ? t('remove.removing', { name: runner.name })
            : act === 'start'
              ? t('actions.starting', { name: runner.name })
              : act === 'stop'
                ? t('actions.stopping', { name: runner.name })
                : t('actions.restarting', { name: runner.name });

    const request = (act: RunnerRowAct) => {
        if (blocked) return;
        action.request({
            key: `${runner.id}:${act}`,
            dialog: runnerActDialog(act, runner, computer),
            actionLabel: verb(act),
            run: (fields) =>
                act === 'remove'
                    ? removeFleetActionsRunnerAction(nodeId, runner.id, fields.confirmName)
                    : fleetActionsRunnerControlAction(
                          nodeId,
                          runner.id,
                          act,
                          fields.confirm === true,
                      ),
            onDone: () => {
                toast.success(done(act));
                onChanged();
            },
            onError: (error) =>
                toast.error(
                    error.hint || (act === 'remove' ? t('remove.failed') : t('actions.failed')),
                ),
        });
    };

    // P3 (FR-28): Reinstall — the same confirm loop, its own route.
    const reinstall = runnerReinstallAvailability(runner);
    const reinstallPlacement = runnerReinstallPlacement(runner);
    const reinstallDisabled = reinstall === 'disabled' || Boolean(blocked) || busy;
    const requestReinstall = () => {
        if (blocked) return;
        action.request({
            key: `${runner.id}:reinstall`,
            dialog: runnerReinstallDialog(runner),
            actionLabel: t('reinstall.confirm'),
            run: (fields) =>
                reinstallFleetActionsRunnerAction(nodeId, runner.id, fields.confirm === true),
            onDone: () => {
                toast.success(t('reinstall.reinstalling', { name: runner.name }));
                onChanged();
            },
            onError: (error) => toast.error(error.hint || t('reinstall.failed')),
        });
    };

    const button = (act: Exclude<RunnerRowAct, 'remove'>) =>
        availability[act] === 'hidden' ? null : (
            <Button
                key={act}
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => request(act)}
                disabled={availability[act] === 'disabled' || Boolean(blocked) || busy}
                title={blocked}
                data-testid={`fleet-runner-${act}`}
            >
                {verb(act)}
            </Button>
        );

    return (
        <div className="flex items-center gap-1" data-testid="fleet-runner-actions">
            {button('start')}
            {button('stop')}
            {button('restart')}
            {reinstall !== 'hidden' && reinstallPlacement !== 'menu' ? (
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={requestReinstall}
                    disabled={reinstallDisabled}
                    title={blocked}
                    data-testid="fleet-runner-reinstall"
                >
                    {reinstallPlacement === 'retry' ? t('reinstall.retry') : t('reinstall.button')}
                </Button>
            ) : null}
            {availability.remove !== 'hidden' ? (
                <div className="w-8 shrink-0">
                    <DropdownMenu>
                        <DropdownMenuTrigger
                            aria-label={t('actions.more', { name: runner.name })}
                            className="h-8 w-8 rounded-md hover:bg-surface-hover dark:hover:bg-surface-hover-dark"
                        >
                            <MoreHorizontal className="h-4 w-4" aria-hidden />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            {reinstall !== 'hidden' && reinstallPlacement === 'menu' ? (
                                <DropdownMenuItem
                                    onClick={requestReinstall}
                                    disabled={reinstallDisabled}
                                >
                                    <span data-testid="fleet-runner-reinstall-menu">
                                        {t('reinstall.button')}
                                    </span>
                                </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem
                                onClick={() => request('remove')}
                                disabled={
                                    availability.remove === 'disabled' || Boolean(blocked) || busy
                                }
                                className="text-danger"
                            >
                                <span data-testid="fleet-runner-remove">{t('remove.button')}</span>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            ) : null}
            <ConfirmActionDialog
                model={action.dialog}
                actionLabel={action.actionLabel}
                pending={action.isPending}
                onConfirm={action.confirm}
                onCancel={action.cancel}
            />
            <RootRequiredDialog model={action.root} machine={computer} onClose={action.closeRoot} />
        </div>
    );
}
