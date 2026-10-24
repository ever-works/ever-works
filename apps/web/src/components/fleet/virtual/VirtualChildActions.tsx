'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { FleetLinkError } from '@ever-works/contracts';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { Button } from '@/components/ui/button';
import {
    destroyFleetVirtualAction,
    fleetVirtualPowerAction,
    rebuildFleetVirtualAction,
    retryFleetVirtualEnrollmentAction,
} from '@/app/actions/fleet/virtual';
import { ConfirmActionDialog } from '../machine/ConfirmActionDialog';
import type { ConfirmDialogModel } from '../machine/machine-actions.shared';
import type { FleetComputerActionProps } from '../registry';
import { isVirtualBusy, isVirtualChild } from './virtual.shared';
import { RevealPasswordDialog } from './RevealPasswordDialog';
import { ResizeVirtualDialog } from './ResizeVirtualDialog';

/**
 * Virtual computers (FL-16, spec §5.5, §5.6, FR-26 – FR-28, FR-33, U10) — the
 * child's header actions: **Start** or **Stop** (stop asks first: Windows gets
 * two minutes, a Container ten seconds), **Retry enrolment** for a guest that
 * was built but never enrolled, and **Destroy…** (type the name; deletes the
 * machine and its disk on the host; job history is kept). Registered through
 * the FL-01 registry (`registerComputerAction`, family `machines`); renders
 * nothing on a computer that is not a virtual one. Disabled with the reason
 * when the host's `machines` audience leaves the viewer out (S8). The server
 * still decides every act.
 */
export default function VirtualChildActions({ node, allowed = true }: FleetComputerActionProps) {
    const t = useTranslations('fleet.virtual');
    const router = useRouter();
    const [dialog, setDialog] = useState<{ act: 'stop' | 'destroy' | 'rebuild'; model: ConfirmDialogModel } | null>(null);
    const [pending, startTransition] = useTransition();
    const [revealOpen, setRevealOpen] = useState(false);
    const [resizeOpen, setResizeOpen] = useState(false);
    if (!isVirtualChild(node) || !node.hostNodeId) return null;
    const hostNodeId = node.hostNodeId;
    const virtual = node.virtual ?? null;
    const state = virtual?.state ?? null;
    const busy = isVirtualBusy(state) || pending;
    const isVm = node.virtualKind === 'vm';
    // The computer page's row carries no host name; "the host" reads right either way.
    const hostLabel = virtual?.hostName ?? t('create.theHost');

    const fail = (error: FleetLinkError) => toast.error(error.hint || t('power.failed'));

    const start = () =>
        startTransition(async () => {
            const result = await fleetVirtualPowerAction(hostNodeId, node.id, 'start');
            if (result.ok) {
                toast.success(t('power.starting', { name: node.name }));
                router.refresh();
            } else fail(result.error);
        });

    const retry = () =>
        startTransition(async () => {
            const result = await retryFleetVirtualEnrollmentAction(hostNodeId, node.id);
            if (result.ok) {
                toast.success(t('power.retrying', { name: node.name }));
                router.refresh();
            } else fail(result.error);
        });

    const confirm = (typed: string) => {
        const current = dialog;
        if (!current) return;
        startTransition(async () => {
            const result =
                current.act === 'stop'
                    ? await fleetVirtualPowerAction(hostNodeId, node.id, 'stop', { confirm: true })
                    : current.act === 'rebuild'
                      ? await rebuildFleetVirtualAction(hostNodeId, node.id)
                      : await destroyFleetVirtualAction(hostNodeId, node.id, typed);
            if (result.ok) {
                setDialog(null);
                if (current.act === 'destroy') {
                    toast.success(t('destroy.started', { name: node.name }));
                    router.push(ROUTES.DASHBOARD_FLEET_COMPUTERS);
                } else if (current.act === 'rebuild') {
                    toast.success(t('rebuild.started', { name: node.name }));
                    router.refresh();
                } else {
                    toast.success(isVm ? t('power.stoppingVm', { name: node.name }) : t('power.stopping', { name: node.name }));
                    router.refresh();
                }
            } else {
                setDialog(null);
                fail(result.error);
            }
        });
    };

    const openStop = () =>
        setDialog({
            act: 'stop',
            model: {
                class: 'confirm',
                title: t('power.stopTitle', { name: node.name }),
                body: isVm ? t('power.stopBodyVm') : t('power.stopBody'),
            },
        });

    const openRebuild = () =>
        setDialog({
            act: 'rebuild',
            model: { class: 'confirm', title: t('rebuild.title', { name: node.name }), body: t('rebuild.body') },
        });

    const openDestroy = () =>
        setDialog({
            act: 'destroy',
            model: {
                class: 'confirm-destructive',
                title: t('destroy.title', { name: node.name }),
                body: isVm ? t('destroy.bodyVm', { host: hostLabel }) : t('destroy.body', { host: hostLabel }),
                typeName: node.name,
            },
        });

    const notAllowed = allowed ? undefined : t('power.notAllowed', { name: hostLabel });
    // Copy password is the owner's alone (spec U16), and only a Windows VM has one.
    const isOwner = (node.viewerRole ?? 'owner') === 'owner';
    const viewerPort = virtual?.viewerPort ?? null;

    // Watch the install (FR-23): the installer's screen, opened ON the host
    // through FL-10's "open on the machine" (its viewer listens on the host's
    // loopback only).
    const watch = () =>
        startTransition(async () => {
            if (!viewerPort) return;
            try {
                const response = await fetch(
                    `/api/fleet/nodes/${encodeURIComponent(hostNodeId)}/ports/${viewerPort}/open`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ target: 'desktop' }),
                    },
                );
                if (response.ok) toast.success(t('watch.opened', { host: hostLabel }));
                else {
                    const body = (await response.json().catch(() => null)) as { error?: { hint?: string } } | null;
                    toast.error(body?.error?.hint || t('watch.failed'));
                }
            } catch {
                toast.error(t('watch.failed'));
            }
        });
    const running = state === 'running' || node.status === 'online';

    return (
        <div className="flex items-center gap-2" data-testid="fleet-virtual-child-actions">
            {isVm && viewerPort ? (
                <Button type="button" size="sm" variant="ghost" onClick={watch} disabled={pending} data-testid="fleet-virtual-watch">
                    {t('watch.button')}
                </Button>
            ) : null}
            {isVm && isOwner && state !== 'creating' && state !== 'destroying' ? (
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setRevealOpen(true)}
                    data-testid="fleet-virtual-copy-password"
                >
                    {t('password.button')}
                </Button>
            ) : null}
            {state === 'not-enrolled' ? (
                <Button type="button" size="sm" variant="ghost" onClick={retry} disabled={!allowed || busy} title={notAllowed}>
                    {t('power.retryEnrollment')}
                </Button>
            ) : null}
            {running ? (
                <Button type="button" size="sm" variant="ghost" onClick={openStop} disabled={!allowed || busy} title={notAllowed}>
                    {t('power.stop')}
                </Button>
            ) : state === 'stopped' ? (
                <Button type="button" size="sm" variant="ghost" onClick={start} disabled={!allowed || busy} title={notAllowed}>
                    {t('power.start')}
                </Button>
            ) : null}
            {state === 'stopped' ? (
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setResizeOpen(true)}
                    disabled={!allowed || busy}
                    title={notAllowed}
                    data-testid="fleet-virtual-resize"
                >
                    {t('resize.button')}
                </Button>
            ) : null}
            {!isVm && (state === 'running' || state === 'stopped') ? (
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={openRebuild}
                    disabled={!allowed || busy}
                    title={notAllowed}
                    data-testid="fleet-virtual-rebuild"
                >
                    {t('rebuild.button')}
                </Button>
            ) : null}
            <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={openDestroy}
                disabled={!allowed || pending || state === 'destroying'}
                title={notAllowed}
                data-testid="fleet-virtual-destroy"
            >
                {t('destroy.button')}
            </Button>
            <ConfirmActionDialog
                model={dialog?.model ?? null}
                actionLabel={
                    dialog?.act === 'destroy'
                        ? t('destroy.confirm')
                        : dialog?.act === 'rebuild'
                          ? t('rebuild.confirm')
                          : t('power.stop')
                }
                pending={pending}
                onConfirm={confirm}
                onCancel={() => setDialog(null)}
            />
            <ResizeVirtualDialog
                open={resizeOpen}
                hostNodeId={hostNodeId}
                childNodeId={node.id}
                name={node.name}
                cpus={virtual?.cpus ?? 4}
                memoryGiB={virtual?.memoryGiB ?? 8}
                onClose={() => setResizeOpen(false)}
                onDone={() => router.refresh()}
            />
            {isVm ? (
                <RevealPasswordDialog
                    open={revealOpen}
                    hostNodeId={hostNodeId}
                    childNodeId={node.id}
                    name={node.name}
                    hostName={hostLabel}
                    onClose={() => setRevealOpen(false)}
                />
            ) : null}
        </div>
    );
}
