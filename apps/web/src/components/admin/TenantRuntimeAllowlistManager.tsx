'use client';

import { useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Save, Eraser, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { TenantJobRuntimeProviderId } from '@/lib/api/tenant-job-runtime';
import type { TenantRuntimeAllowlistResponse } from '@/lib/api/operator-tenant-runtime-allowlist';
import {
    deleteTenantRuntimeAllowlistEntryAction,
    replaceTenantRuntimeAllowlistAction,
} from '@/app/actions/admin/tenant-runtime-allowlist';

interface TenantRuntimeAllowlistManagerProps {
    readonly tenantId: string;
    readonly initial: TenantRuntimeAllowlistResponse;
}

/**
 * EW-742 P5.1 (T35a UI follow-up) — operator client component for
 * editing a tenant's per-runtime-provider allow-list.
 *
 * Visual structure:
 *   1. Status banner (`perTenantGatingEnabled` + saved-list summary)
 *   2. Picker of the 5 known providers as checkboxes
 *   3. Inline list of currently-saved providers with an `×` per-row
 *      delete shortcut + Save / Clear actions
 *
 * The picker tracks a draft selection; "Save" replaces the whole list
 * atomically via the operator PUT endpoint (single transaction on the
 * API side), "Clear" replaces with an empty array (tenant inherits the
 * global list), and per-row `×` removes a single provider via DELETE.
 *
 * Mirrors the visual language of `JobRuntimeSettings` (the tenant
 * self-service view) — same Button / Checkbox / AlertTriangle
 * primitives, same `space-y-*` rhythm — so an operator who has used
 * the tenant page recognises the operator page immediately.
 */
const KNOWN_PROVIDERS: readonly TenantJobRuntimeProviderId[] = [
    'trigger',
    'temporal',
    'bullmq',
    'pgboss',
    'inngest',
] as const;

const PROVIDER_LABELS: Record<TenantJobRuntimeProviderId, string> = {
    trigger: 'Trigger.dev',
    temporal: 'Temporal',
    bullmq: 'BullMQ',
    pgboss: 'pg-boss',
    inngest: 'Inngest',
};

export function TenantRuntimeAllowlistManager({
    tenantId,
    initial,
}: TenantRuntimeAllowlistManagerProps) {
    const t = useTranslations('dashboard.adminTenantRuntimeAllowlist');
    const [saved, setSaved] = useState<TenantRuntimeAllowlistResponse>(initial);
    const [draft, setDraft] = useState<Set<TenantJobRuntimeProviderId>>(
        () => new Set(initial.providerIds),
    );
    const [isPending, startTransition] = useTransition();

    // Local change tracking — used to disable the Save button when the
    // operator has not actually changed anything (avoids round-trips
    // that would no-op on the API side but still emit an audit row).
    const isDirty = useMemo(() => {
        if (draft.size !== saved.providerIds.length) return true;
        for (const id of saved.providerIds) {
            if (!draft.has(id)) return true;
        }
        return false;
    }, [draft, saved.providerIds]);

    function toggle(providerId: TenantJobRuntimeProviderId, checked: boolean) {
        setDraft((prev) => {
            const next = new Set(prev);
            if (checked) {
                next.add(providerId);
            } else {
                next.delete(providerId);
            }
            return next;
        });
    }

    function handleSave() {
        // Preserve the user-friendly KNOWN_PROVIDERS order so the API
        // receives a deterministic sequence; the server stores rows in
        // insertion order and the operator UI lists them the same way.
        const ordered: TenantJobRuntimeProviderId[] = KNOWN_PROVIDERS.filter((id) => draft.has(id));
        startTransition(async () => {
            const result = await replaceTenantRuntimeAllowlistAction(tenantId, ordered);
            if (result.success) {
                setSaved(result.data);
                setDraft(new Set(result.data.providerIds));
                toast.success(t('messages.saveSuccess'));
            } else {
                toast.error(result.error || t('messages.saveError'));
            }
        });
    }

    function handleClear() {
        startTransition(async () => {
            const result = await replaceTenantRuntimeAllowlistAction(tenantId, []);
            if (result.success) {
                setSaved(result.data);
                setDraft(new Set());
                toast.success(t('messages.saveSuccess'));
            } else {
                toast.error(result.error || t('messages.saveError'));
            }
        });
    }

    function handleDeleteRow(providerId: TenantJobRuntimeProviderId) {
        startTransition(async () => {
            const result = await deleteTenantRuntimeAllowlistEntryAction(tenantId, providerId);
            if (result.success) {
                setSaved(result.data);
                setDraft(new Set(result.data.providerIds));
                toast.success(t('messages.deleteSuccess'));
            } else {
                toast.error(result.error || t('messages.deleteError'));
            }
        });
    }

    // Status-banner copy depends on two orthogonal axes — gating
    // on/off + saved-list empty/populated — so resolve it once here
    // rather than scattering ternaries through JSX.
    const gatingDisabled = !saved.perTenantGatingEnabled;
    const savedList = saved.providerIds.map((id) => PROVIDER_LABELS[id] ?? id).join(', ');

    return (
        <div className="space-y-8">
            {gatingDisabled ? (
                <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg">
                    <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-text dark:text-text-dark">
                        {t('gatingDisabledBanner')}
                    </p>
                </div>
            ) : saved.providerIds.length === 0 ? (
                <div className="flex items-start gap-2 p-3 bg-surface-secondary/40 dark:bg-surface-secondary-dark/40 border border-border dark:border-border-dark rounded-lg">
                    <p className="text-sm text-text dark:text-text-dark">
                        {t('emptyInheritBanner')}
                    </p>
                </div>
            ) : (
                <div className="flex items-start gap-2 p-3 bg-surface-secondary/40 dark:bg-surface-secondary-dark/40 border border-border dark:border-border-dark rounded-lg">
                    <p className="text-sm text-text dark:text-text-dark">
                        {t('restrictedBanner', { providers: savedList })}
                    </p>
                </div>
            )}

            <section className="space-y-4 p-4 rounded-lg border border-border dark:border-border-dark">
                <div>
                    <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('pickerLabel')}
                    </h2>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                        {t('pickerHelper')}
                    </p>
                </div>

                <div className="flex flex-wrap gap-2">
                    {KNOWN_PROVIDERS.map((providerId) => (
                        <Checkbox
                            key={providerId}
                            id={`runtime-allowlist-${providerId}`}
                            label={PROVIDER_LABELS[providerId]}
                            checked={draft.has(providerId)}
                            onChange={(e) => toggle(providerId, e.target.checked)}
                            disabled={isPending}
                        />
                    ))}
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-2">
                    <Button onClick={handleSave} loading={isPending} disabled={!isDirty}>
                        <Save className="w-4 h-4" />
                        {t('actions.save')}
                    </Button>
                    <Button
                        variant="ghost"
                        onClick={handleClear}
                        disabled={isPending || saved.providerIds.length === 0}
                    >
                        <Eraser className="w-4 h-4" />
                        {t('actions.clear')}
                    </Button>
                </div>
            </section>

            <section className="space-y-3">
                <h2 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('savedListLabel')}
                </h2>
                {saved.providerIds.length === 0 ? (
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('messages.noProviders')}
                    </p>
                ) : (
                    <ul className="flex flex-wrap gap-2">
                        {saved.providerIds.map((providerId) => (
                            <li
                                key={providerId}
                                className="inline-flex items-center gap-1.5 rounded-full border border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/40 pl-3 pr-1.5 py-1 text-xs text-text dark:text-text-dark"
                            >
                                <span>{PROVIDER_LABELS[providerId] ?? providerId}</span>
                                <button
                                    type="button"
                                    onClick={() => handleDeleteRow(providerId)}
                                    disabled={isPending}
                                    aria-label={t('actions.removeProvider', {
                                        provider: PROVIDER_LABELS[providerId] ?? providerId,
                                    })}
                                    className="inline-flex items-center justify-center w-5 h-5 rounded-full hover:bg-danger/10 hover:text-danger disabled:opacity-50 transition-colors"
                                >
                                    <X className="w-3 h-3" />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}
