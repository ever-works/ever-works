'use client';

import { useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    FLEET_ACTION_FAMILIES,
    FLEET_AUDIENCES,
    effectiveControlPolicy,
    type FleetActionFamily,
    type FleetAudience,
    type FleetControlPolicyFamilies,
    type FleetControlPolicyFamiliesInput,
    type FleetNodeView,
} from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { setFleetNodePolicyFamiliesAction } from '@/app/actions/settings/fleet';

/** Message keys of the audiences (camelCase leaves, CONTRACTS §11.4). */
const AUDIENCE_KEYS: Readonly<Record<FleetAudience, 'owner' | 'orgAdmins' | 'orgMembers'>> = {
    owner: 'owner',
    'org-admins': 'orgAdmins',
    'org-members': 'orgMembers',
};

/** The families whose audience differs between two policies — what a save sends. */
export function changedFamilies(
    saved: FleetControlPolicyFamilies,
    draft: FleetControlPolicyFamilies,
): FleetControlPolicyFamiliesInput {
    const changes: FleetControlPolicyFamiliesInput = {};
    for (const family of FLEET_ACTION_FAMILIES) {
        if (saved[family] !== draft[family]) changes[family] = draft[family];
    }
    return changes;
}

/**
 * Fleet hub (FL-01, FR-27 – FR-31, spec §5.10) — "Who can do what on
 * build-01": one choice per action family (the thirteen of CONTRACTS §2.1,
 * the `machines` family labelled "Lifecycle"), each Only me · Organization
 * admins · Organization members. The `desktop` row reads the computer's
 * existing take-over policy when nothing newer was saved (its legacy single
 * value), and saving it writes that value back, so AW-11's take-over follows.
 *
 * Owner only: anyone else sees the same table read-only, with who may change
 * it. A save sends only the families that changed; the server audits one
 * `node.policy.change` per family. The decision is the server's — this only
 * mirrors it.
 */
export function PolicyFamiliesEditor({ node }: { node: FleetNodeView }) {
    const t = useTranslations('fleet.computer.settings.policy');
    const isOwner = node.viewerRole === undefined || node.viewerRole === 'owner';
    const initial = useMemo(
        () =>
            node.controlPolicyFamilies ??
            effectiveControlPolicy({
                controlPolicy: node.controlPolicy,
                controlPolicyFamilies: null,
            }),
        [node.controlPolicyFamilies, node.controlPolicy],
    );
    const [saved, setSaved] = useState<FleetControlPolicyFamilies>(initial);
    const [draft, setDraft] = useState<FleetControlPolicyFamilies>(initial);
    const [isPending, startTransition] = useTransition();
    const changes = changedFamilies(saved, draft);
    const dirty = Object.keys(changes).length > 0;

    const save = () => {
        if (!dirty) return;
        startTransition(async () => {
            const result = await setFleetNodePolicyFamiliesAction(node.id, changes);
            if (result.success) {
                const next = result.data.controlPolicyFamilies ?? draft;
                setSaved(next);
                setDraft(next);
                toast.success(t('saved'));
            } else {
                toast.error(result.error || t('failed'));
            }
        });
    };

    const set = (family: FleetActionFamily, audience: FleetAudience) =>
        setDraft((prev) => ({ ...prev, [family]: audience }));

    return (
        <section
            aria-labelledby="fleet-policy-heading"
            className="space-y-4"
            data-testid="fleet-policy-editor"
        >
            <div className="space-y-1">
                <h2
                    id="fleet-policy-heading"
                    className="text-base font-semibold text-text dark:text-text-dark"
                >
                    {t('heading', { name: node.name })}
                </h2>
                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                    {isOwner
                        ? t('intro', { name: node.name })
                        : t('introShared', { name: node.name })}
                </p>
            </div>
            <div className="rounded-lg border border-border dark:border-border-dark divide-y divide-border dark:divide-border-dark">
                {FLEET_ACTION_FAMILIES.map((family) => {
                    const id = `fleet-policy-${family}`;
                    return (
                        <div
                            key={family}
                            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                        >
                            <div className="min-w-0">
                                <label
                                    htmlFor={id}
                                    className="text-sm font-medium text-text dark:text-text-dark"
                                >
                                    {t(`families.${family}.label`)}
                                </label>
                                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {t(`families.${family}.hint`)}
                                </p>
                            </div>
                            <select
                                id={id}
                                value={draft[family]}
                                onChange={(event) =>
                                    set(family, event.target.value as FleetAudience)
                                }
                                disabled={!isOwner || isPending}
                                data-testid={id}
                                className="h-8 rounded-md border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2 text-sm text-text dark:text-text-dark disabled:opacity-60"
                            >
                                {FLEET_AUDIENCES.map((audience) => (
                                    <option key={audience} value={audience}>
                                        {t(`audiences.${AUDIENCE_KEYS[audience]}`)}
                                    </option>
                                ))}
                            </select>
                        </div>
                    );
                })}
            </div>
            <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('agentsNote')}</p>
            {isOwner && (
                <div className="flex items-center justify-end gap-2">
                    <Button
                        variant="secondary"
                        onClick={() => setDraft(saved)}
                        disabled={!dirty || isPending}
                        data-testid="fleet-policy-reset"
                    >
                        {t('reset')}
                    </Button>
                    <Button
                        onClick={save}
                        disabled={!dirty}
                        loading={isPending}
                        data-testid="fleet-policy-save"
                    >
                        {t('save')}
                    </Button>
                </div>
            )}
        </section>
    );
}
