'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { FleetLinkError } from '@ever-works/contracts';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { Button } from '@/components/ui/button';
import { destroyFleetCloudAction, fleetCloudPowerAction } from '@/app/actions/fleet/cloud';
import { ConfirmActionDialog } from '../machine/ConfirmActionDialog';
import type { ConfirmDialogModel } from '../machine/machine-actions.shared';
import type { FleetComputerActionProps } from '../registry';
import { cloudActFromQuery, cloudDisplayState, cloudPowerChoice, hourly, money } from './cloud.shared';

/**
 * Cloud computers (FL-17, spec §5.3 – §5.5, FR-16 – FR-20, S10) — a cloud
 * computer's header actions: **Power off** (asks first and says whether the
 * provider still bills it while off) or **Power on**, and **Destroy…** (states
 * the cost so far and the creation date; type the name). Registered through
 * the FL-01 registry (`registerComputerAction`, family `machines`); renders
 * nothing on a computer that is not a cloud computer. Disabled with the reason
 * when the viewer is outside the computer's `machines` audience. The server
 * decides every act (kill switch, busy, price) and its refusal is shown as is.
 */
export default function CloudComputerActions({ node, allowed = true }: FleetComputerActionProps) {
    const t = useTranslations('fleet.cloud');
    const router = useRouter();
    const [dialog, setDialog] = useState<{ act: 'off' | 'on' | 'destroy'; model: ConfirmDialogModel } | null>(null);
    const [pending, startTransition] = useTransition();
    const params = useSearchParams();
    const opened = useRef(false);
    const openPowerRef = useRef<((act: 'off' | 'on') => void) | null>(null);
    const openDestroyRef = useRef<(() => void) | null>(null);
    const cloud = node.cloud;
    // P2: a "needs a look" item links here with `?cloud=power-off|power-on|destroy`
    // (spec §5.7): open that act's confirmation once, when it is offered now.
    const requested = cloudActFromQuery(params?.get('cloud'));
    useEffect(() => {
        if (opened.current || !requested || !cloud || !allowed) return;
        opened.current = true;
        const state = cloudDisplayState(node, cloud);
        if (requested === 'destroy') {
            if (state !== 'destroying' && state !== 'creating') openDestroyRef.current?.();
            return;
        }
        if (cloudPowerChoice(state) === requested) openPowerRef.current?.(requested);
    }, [requested, cloud, allowed, node]);
    if (!cloud) return null;
    const state = cloudDisplayState(node, cloud);
    const power = cloudPowerChoice(state);
    const busy = pending || state === 'destroying' || state === 'poweringOff' || state === 'starting';
    const notAllowed = allowed ? undefined : t('power.notAllowed', { name: node.name });

    const fail = (error: FleetLinkError, fallback: string) => toast.error(error.hint || fallback);

    const confirm = (typed: string) => {
        const current = dialog;
        if (!current) return;
        startTransition(async () => {
            if (current.act === 'destroy') {
                const result = await destroyFleetCloudAction(node.id, typed);
                setDialog(null);
                if (result.ok) {
                    toast.success(
                        t('destroy.done', { name: node.name, cost: money(result.data.costSoFarCents ?? 0, cloud.currency) }),
                    );
                    router.push(ROUTES.DASHBOARD_FLEET_COMPUTERS);
                } else fail(result.error, t('destroy.failed'));
                return;
            }
            const result = await fleetCloudPowerAction(node.id, current.act, true);
            setDialog(null);
            if (result.ok) {
                toast.success(current.act === 'off' ? t('power.poweringOff', { name: node.name }) : t('power.starting', { name: node.name }));
                router.refresh();
            } else fail(result.error, t('power.failed'));
        });
    };

    const openPower = (act: 'off' | 'on') =>
        setDialog({
            act,
            model: {
                class: 'confirm',
                title: act === 'off' ? t('power.offTitle', { name: node.name }) : t('power.onTitle', { name: node.name }),
                body:
                    act === 'off'
                        ? cloud.billsWhileOff
                            ? t('power.offBody', { provider: cloud.providerName })
                            : t('power.offBodyFree')
                        : t('power.onBody', { rate: hourly(cloud.hourlyRateCents, cloud.currency) }),
            },
        });

    const openDestroy = () => {
        // The block's figure is the server's at page load; the 409 carries the
        // server's again, and the destroy answers with the final figure.
        const costSoFar = cloud.cost.sinceCreatedCents;
        setDialog({
            act: 'destroy',
            model: {
                class: 'confirm-destructive',
                title: t('destroy.title', { name: node.name }),
                body: t('destroy.body', {
                    cost: money(costSoFar, cloud.currency),
                    date: (cloud.machineCreatedAt ?? cloud.createdAt).slice(0, 10),
                    provider: cloud.providerName,
                }),
                typeName: node.name,
            },
        });
    };

    openPowerRef.current = openPower;
    openDestroyRef.current = openDestroy;

    return (
        <div className="flex items-center gap-2" data-testid="fleet-cloud-actions">
            {power ? (
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => openPower(power)}
                    disabled={!allowed || busy}
                    title={notAllowed}
                    data-testid={`fleet-cloud-power-${power}`}
                >
                    {power === 'off' ? t('power.off') : t('power.on')}
                </Button>
            ) : null}
            {state !== 'gone' ? (
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={openDestroy}
                    disabled={!allowed || busy}
                    title={notAllowed}
                    data-testid="fleet-cloud-destroy"
                >
                    {t('destroy.button')}
                </Button>
            ) : null}
            <ConfirmActionDialog
                model={dialog?.model ?? null}
                actionLabel={
                    dialog?.act === 'destroy' ? t('destroy.confirm') : dialog?.act === 'on' ? t('power.on') : t('power.off')
                }
                pending={pending}
                onConfirm={confirm}
                onCancel={() => setDialog(null)}
            />
        </div>
    );
}
