'use client';

import { useId, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    FLEET_CLOUD_IDLE_MAX_HOURS,
    FLEET_CLOUD_IDLE_MIN_HOURS,
    FLEET_CLOUD_IDLE_POLICY_MODES,
    type FleetCloudIdlePolicy,
    type FleetCloudIdlePolicyMode,
} from '@ever-works/contracts';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { setFleetCloudIdlePolicyAction } from '@/app/actions/fleet/cloud';
import { idleHoursValid, idlePolicyChanged, idlePolicyDraftOf, idlePolicyFromDraft, type IdlePolicyDraft } from './cloud.shared';

const MODE_KEYS: Readonly<Record<FleetCloudIdlePolicyMode, 'nothing' | 'tellMe' | 'powerOff'>> = {
    nothing: 'nothing',
    'tell-me': 'tellMe',
    'power-off': 'powerOff',
};

/**
 * Cloud computers (FL-17 P2, spec FR-25, §5.6) — the idle policy editor:
 * Nothing · Tell me after N hours (the default, 3) · Power off after N hours,
 * N a whole number from 1 to 72 (clamped on Save, and again by the API).
 * States what idle means and that Ever Works never destroys a cloud computer
 * on its own (FR-28). Saving starts the idle window again, so the new policy
 * waits its full hours from now.
 */
export function IdlePolicyEditor({
    nodeId,
    name,
    policy,
    onDone,
}: {
    nodeId: string;
    name: string;
    policy: FleetCloudIdlePolicy | null | undefined;
    /** Called after a save (or Cancel), e.g. to close an inline editor. */
    onDone?: () => void;
}) {
    const t = useTranslations('fleet.cloud.idlePolicy');
    const router = useRouter();
    const groupId = useId();
    const [draft, setDraft] = useState<IdlePolicyDraft>(() => idlePolicyDraftOf(policy));
    const [pending, startTransition] = useTransition();
    const hoursOk = draft.mode === 'nothing' || idleHoursValid(draft.hours);
    const dirty = idlePolicyChanged(policy, draft);

    const save = () => {
        const next = idlePolicyFromDraft(draft);
        startTransition(async () => {
            const result = await setFleetCloudIdlePolicyAction(nodeId, next);
            if (result.ok) {
                toast.success(t('saved', { name }));
                router.refresh();
                onDone?.();
            } else {
                toast.error(result.error.hint || t('failed'));
            }
        });
    };

    return (
        <fieldset className="mt-2 space-y-2" data-testid="fleet-cloud-idle-editor" disabled={pending}>
            <legend className="text-sm font-medium">{t('title')}</legend>
            {FLEET_CLOUD_IDLE_POLICY_MODES.map((mode) => {
                const id = `${groupId}-${mode}`;
                const withHours = mode !== 'nothing';
                return (
                    <div key={mode} className="flex flex-wrap items-center gap-2 text-sm">
                        <input
                            type="radio"
                            id={id}
                            name={`${groupId}-mode`}
                            value={mode}
                            checked={draft.mode === mode}
                            onChange={() => setDraft((current) => ({ ...current, mode }))}
                            data-testid={`fleet-cloud-idle-mode-${mode}`}
                        />
                        <label htmlFor={id}>{t(`modes.${MODE_KEYS[mode]}`)}</label>
                        {withHours ? (
                            <>
                                <input
                                    type="number"
                                    inputMode="numeric"
                                    min={FLEET_CLOUD_IDLE_MIN_HOURS}
                                    max={FLEET_CLOUD_IDLE_MAX_HOURS}
                                    step={1}
                                    aria-label={t('hoursLabel', { mode: t(`modes.${MODE_KEYS[mode]}`) })}
                                    className="h-8 w-16 rounded-md border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2 text-sm tabular-nums disabled:opacity-60"
                                    value={draft.mode === mode ? draft.hours : idlePolicyDraftOf(policy).hours}
                                    disabled={draft.mode !== mode}
                                    onChange={(event) => setDraft({ mode, hours: event.target.value })}
                                    data-testid={`fleet-cloud-idle-hours-${mode}`}
                                />
                                <span>{t('hours')}</span>
                            </>
                        ) : null}
                    </div>
                );
            })}
            {!hoursOk ? (
                <p className="text-xs text-amber-700 dark:text-amber-400" role="alert" data-testid="fleet-cloud-idle-range">
                    {t('range', { min: FLEET_CLOUD_IDLE_MIN_HOURS, max: FLEET_CLOUD_IDLE_MAX_HOURS })}
                </p>
            ) : null}
            <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('meaning')}</p>
            <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('neverDestroys')}</p>
            <div className="flex items-center gap-2">
                <Button
                    size="sm"
                    onClick={save}
                    disabled={!dirty || !hoursOk}
                    loading={pending}
                    data-testid="fleet-cloud-idle-save"
                >
                    {t('save')}
                </Button>
                {onDone ? (
                    <Button size="sm" variant="secondary" onClick={onDone} data-testid="fleet-cloud-idle-cancel">
                        {t('cancel')}
                    </Button>
                ) : null}
            </div>
        </fieldset>
    );
}
