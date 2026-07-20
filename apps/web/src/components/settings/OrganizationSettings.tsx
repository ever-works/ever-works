'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import type { OrganizationResponse } from '@ever-works/contracts/api';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ShowDateTime } from '@/components/ui/show-datetime';
import { useOrganizations } from '@/lib/hooks/use-organizations';

/**
 * PR-6 (domain-model evolution, review §23.5) — Organization settings
 * surface. First (and so far only) concern: the company **Vision**, a
 * plain-text field on the Organization that — when set — is injected as
 * a fenced, untrusted-content segment into Idea generation, agent-run
 * prompt assembly, and Mission tick context so every agent knows the
 * company vision.
 *
 * Saves via the existing `PATCH /api/organizations/:id` path (proxied
 * by `apps/web/src/app/api/organizations/[id]/route.ts`).
 */

/**
 * Matches the server-side storage cap on `Organization.vision` (see
 * `UpdateOrganizationRequest` in `@ever-works/contracts/api`). Prompt
 * consumers apply their own tighter ~2000-char injection cap. Kept in
 * sync manually — a UI cap below the storage cap would silently
 * truncate a longer previously-stored vision on save.
 */
const MAX_VISION_LENGTH = 5000;

export function OrganizationSettings() {
    const t = useTranslations('organizations.settings');
    const { organizations: orgs, isLoading, mutate } = useOrganizations();

    const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
    const [vision, setVision] = useState('');
    const [saveError, setSaveError] = useState<string | null>(null);
    const [justSaved, setJustSaved] = useState(false);
    const [saving, startTransition] = useTransition();
    /**
     * Server-confirmed vision for the selected org, so the dirty check
     * survives a `mutate()` race (the shared store may briefly lag the
     * PATCH response).
     */
    const [savedByOrg, setSavedByOrg] = useState<
        Record<string, { vision: string; visionUpdatedAt: string | null }>
    >({});

    const selectedOrg = useMemo(
        () => orgs.find((org) => org.id === selectedOrgId) ?? null,
        [orgs, selectedOrgId],
    );

    // Default the selection to the first org once the list arrives.
    useEffect(() => {
        if (!selectedOrgId && orgs.length > 0) {
            setSelectedOrgId(orgs[0].id);
        }
    }, [orgs, selectedOrgId]);

    const savedState = selectedOrg
        ? (savedByOrg[selectedOrg.id] ?? {
              vision: selectedOrg.vision ?? '',
              visionUpdatedAt: selectedOrg.visionUpdatedAt ?? null,
          })
        : null;

    // Re-seed the textarea whenever the selection (or its saved value)
    // changes. Keyed on the org id so switching orgs never leaks one
    // org's draft into another.
    useEffect(() => {
        if (selectedOrg) {
            setVision(savedByOrg[selectedOrg.id]?.vision ?? selectedOrg.vision ?? '');
            setSaveError(null);
            setJustSaved(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedOrgId]);

    const isDirty = savedState !== null && vision.trim() !== savedState.vision.trim();

    const handleSave = useCallback(() => {
        if (!selectedOrg) return;
        const orgId = selectedOrg.id;
        const trimmed = vision.trim().slice(0, MAX_VISION_LENGTH);
        setSaveError(null);
        setJustSaved(false);
        startTransition(() => {
            void (async () => {
                try {
                    const res = await fetch(`/api/organizations/${encodeURIComponent(orgId)}`, {
                        method: 'PATCH',
                        credentials: 'include',
                        cache: 'no-store',
                        headers: { 'Content-Type': 'application/json' },
                        // Empty textarea = clear the vision (explicit null —
                        // the column is nullable and NULL means "never set /
                        // no vision context for agents").
                        body: JSON.stringify({ vision: trimmed.length > 0 ? trimmed : null }),
                    });
                    if (!res.ok) {
                        setSaveError(t('errors.generic'));
                        return;
                    }
                    const updated = (await res.json()) as OrganizationResponse;
                    setSavedByOrg((prev) => ({
                        ...prev,
                        [orgId]: {
                            vision: updated.vision ?? '',
                            visionUpdatedAt: updated.visionUpdatedAt ?? null,
                        },
                    }));
                    setVision(updated.vision ?? '');
                    setJustSaved(true);
                    // Best-effort refresh of the shared org store (switcher
                    // etc.). The PATCH already succeeded — a transient
                    // failure here must not surface as a save error.
                    try {
                        await mutate();
                    } catch {
                        // Swallow — see comment above.
                    }
                } catch {
                    setSaveError(t('errors.generic'));
                }
            })();
        });
    }, [selectedOrg, vision, mutate, t]);

    const visionUpdatedAt = savedState?.visionUpdatedAt ?? null;

    return (
        <div className="space-y-6" data-testid="organization-settings">
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h2>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1">
                    {t('subtitle')}
                </p>
            </div>

            {isLoading && orgs.length === 0 ? (
                <p className="text-sm text-text-muted dark:text-text-muted-dark">{t('loading')}</p>
            ) : orgs.length === 0 ? (
                <div
                    className="rounded-lg border border-border dark:border-border-dark p-6 text-center"
                    data-testid="organization-settings-empty"
                >
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {t('empty.title')}
                    </p>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1">
                        {t('empty.description')}
                    </p>
                </div>
            ) : (
                <div className="space-y-4 max-w-2xl">
                    {orgs.length > 1 && (
                        <div>
                            <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                                {t('selectLabel')}
                            </label>
                            <Select
                                value={selectedOrgId ?? undefined}
                                onValueChange={(value) => setSelectedOrgId(value)}
                                data-testid="organization-settings-org-select"
                            >
                                {orgs.map((org) => (
                                    <option key={org.id} value={org.id}>
                                        {org.displayName ?? org.slug}
                                    </option>
                                ))}
                            </Select>
                        </div>
                    )}

                    <Textarea
                        label={t('visionLabel')}
                        value={vision}
                        onChange={(e) => setVision(e.target.value)}
                        placeholder={t('visionPlaceholder')}
                        helperText={t('visionHelp')}
                        error={saveError ?? undefined}
                        maxLength={MAX_VISION_LENGTH}
                        rows={5}
                        disabled={saving || !selectedOrg}
                        data-testid="organization-settings-vision-input"
                    />

                    <div className="flex items-center gap-3">
                        <Button
                            onClick={handleSave}
                            loading={saving}
                            disabled={saving || !selectedOrg || !isDirty}
                            data-testid="organization-settings-vision-save"
                        >
                            {t('save')}
                        </Button>
                        {justSaved && !isDirty && (
                            <span className="text-sm text-success" data-testid="vision-saved-flash">
                                {t('saved')}
                            </span>
                        )}
                        {visionUpdatedAt && (
                            <span
                                className="text-xs text-text-muted dark:text-text-muted-dark"
                                data-testid="vision-updated-at"
                            >
                                {t('lastUpdated')} <ShowDateTime value={visionUpdatedAt} />
                            </span>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
