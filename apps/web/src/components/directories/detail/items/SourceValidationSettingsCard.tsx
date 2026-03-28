'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { FieldCard } from '@/components/directories/detail/shared';
import { DirectoryScheduleCadence } from '@/lib/api/enums';
import { updateSourceValidationSettings } from '@/app/actions/dashboard/items';
import type { SourceValidationSettingsDto } from '@/lib/api/types-only';

const allCadences = [
    DirectoryScheduleCadence.HOURLY,
    DirectoryScheduleCadence.DAILY,
    DirectoryScheduleCadence.WEEKLY,
    DirectoryScheduleCadence.MONTHLY,
];

export function SourceValidationSettingsCard({
    directoryId,
    settings,
}: {
    directoryId: string;
    settings: SourceValidationSettingsDto;
}) {
    const t = useTranslations('dashboard.directoryDetail.items.sourceValidationSettings');
    const tCadence = useTranslations('dashboard.directoryDetail.schedule.card');
    const [enabled, setEnabled] = useState(settings.enabled);
    const availableCadences =
        settings.allowedCadences.length > 0
            ? allCadences.filter((c) => settings.allowedCadences.some((a) => a.cadence === c))
            : allCadences;

    const defaultCadence =
        (settings.cadence as DirectoryScheduleCadence) ??
        availableCadences[availableCadences.length - 1] ??
        DirectoryScheduleCadence.WEEKLY;

    const [cadence, setCadence] = useState<DirectoryScheduleCadence>(defaultCadence);
    const [dirty, setDirty] = useState(false);
    const [isSaving, startSaving] = useTransition();

    const updateForm = (updates: { enabled?: boolean; cadence?: DirectoryScheduleCadence }) => {
        setDirty(true);
        if (updates.enabled !== undefined) setEnabled(updates.enabled);
        if (updates.cadence !== undefined) setCadence(updates.cadence);
    };

    const save = () => {
        startSaving(async () => {
            const result = await updateSourceValidationSettings(directoryId, {
                enabled,
                cadence,
            });

            if (result.status === 'error') {
                toast.error(result.message || t('saveFailed'));
                return;
            }

            setDirty(false);
            toast.success(t('saveSuccess'));
        });
    };

    return (
        <section className="rounded-2xl border border-card-border dark:border-border-secondary-dark bg-card dark:bg-transparent p-6 shadow-sm space-y-4">
            <div className="space-y-1">
                <p className="text-base font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </p>
                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                    {t('subtitle')}
                </p>
            </div>

            <div className="grid gap-4 @lg/main:grid-cols-2">
                <FieldCard label={t('enableLabel')} helper={t('enableHelp')}>
                    <Switch
                        checked={enabled}
                        onChange={(checked) => updateForm({ enabled: checked })}
                    />
                </FieldCard>

                {enabled && (
                    <FieldCard label={t('cadenceLabel')} helper={t('cadenceHelp')}>
                        <Select
                            value={cadence}
                            onValueChange={(val: string) =>
                                updateForm({ cadence: val as DirectoryScheduleCadence })
                            }
                        >
                            {availableCadences.map((c) => (
                                <option key={c} value={c}>
                                    {tCadence(`cadence.${c}`)}
                                </option>
                            ))}
                        </Select>
                    </FieldCard>
                )}
            </div>

            {dirty && (
                <div className="flex justify-end">
                    <Button onClick={save} disabled={isSaving}>
                        {isSaving ? t('saving') : t('save')}
                    </Button>
                </div>
            )}
        </section>
    );
}
