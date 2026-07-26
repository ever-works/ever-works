'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Megaphone } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { PageHeader } from '@/components/common/PageHeader';
import { useRouter } from '@/i18n/navigation';
import { createCampaignWork } from '@/app/actions/dashboard/works';

/** Split a comma-separated channel list into trimmed, deduped entries. */
export function parseChannels(raw: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of raw.split(',')) {
        const trimmed = part.trim().slice(0, 40);
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
        if (out.length >= 10) break;
    }
    return out;
}

/**
 * Campaign brief form — name + objective (+ optional target and channels).
 *
 * Submits to the single activation endpoint, which provisions the Work,
 * the Goal, the go-to-market Agents, the seeded pipeline Tasks and the
 * pipeline preference in one owner-scoped, all-or-nothing call.
 */
export default function CampaignFormClient() {
    const t = useTranslations('dashboard.workCreation.campaign');
    const router = useRouter();

    const [name, setName] = useState('');
    const [objective, setObjective] = useState('');
    const [targetValue, setTargetValue] = useState('');
    const [targetUnit, setTargetUnit] = useState('');
    const [channels, setChannels] = useState('');
    const [pending, startTransition] = useTransition();

    const canSubmit = name.trim().length > 0 && objective.trim().length > 0 && !pending;

    const handleSubmit = (event: React.FormEvent) => {
        event.preventDefault();
        if (!canSubmit) return;

        const parsedTarget = Number(targetValue);
        const target =
            targetValue.trim() && Number.isFinite(parsedTarget) && parsedTarget > 0
                ? {
                      value: parsedTarget,
                      ...(targetUnit.trim() ? { unit: targetUnit.trim() } : {}),
                  }
                : undefined;

        startTransition(async () => {
            const result = await createCampaignWork({
                name: name.trim(),
                objective: objective.trim(),
                target,
                channels: parseChannels(channels),
            });

            if (!result.success) {
                toast.error(result.error || t('failed'));
                return;
            }

            toast.success(t('success', { name: result.campaign.work.name }));
            if (!result.campaign.pipeline.applied) {
                toast.warning(t('pipelineNotPinned'));
            }
            router.push(`/works/${result.campaign.work.id}`);
        });
    };

    return (
        <div className="w-full space-y-6">
            <PageHeader icon={Megaphone} title={t('title')} subtitle={t('subtitle')} tone="work" />

            <form
                onSubmit={handleSubmit}
                className={cn(
                    'rounded-lg border overflow-hidden',
                    'bg-card dark:bg-card-primary-dark/30',
                    'border-card-border dark:border-border-secondary-dark',
                )}
                data-testid="campaign-brief-form"
            >
                <div className="px-5 py-4 space-y-4">
                    <div className="space-y-1.5">
                        <label
                            htmlFor="campaign-name"
                            className="text-xs font-medium text-text dark:text-text-dark"
                        >
                            {t('nameLabel')}
                        </label>
                        <Input
                            id="campaign-name"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={t('namePlaceholder')}
                            maxLength={100}
                            disabled={pending}
                            required
                        />
                    </div>

                    <div className="space-y-1.5">
                        <label
                            htmlFor="campaign-objective"
                            className="text-xs font-medium text-text dark:text-text-dark"
                        >
                            {t('objectiveLabel')}
                        </label>
                        <Textarea
                            id="campaign-objective"
                            value={objective}
                            onChange={(event) => setObjective(event.target.value)}
                            placeholder={t('objectivePlaceholder')}
                            maxLength={500}
                            rows={3}
                            disabled={pending}
                            required
                        />
                    </div>

                    <div className="space-y-1.5">
                        <span className="text-xs font-medium text-text dark:text-text-dark">
                            {t('targetLabel')}
                        </span>
                        <div className="flex items-center gap-2">
                            <Input
                                aria-label={t('targetLabel')}
                                type="number"
                                min={1}
                                value={targetValue}
                                onChange={(event) => setTargetValue(event.target.value)}
                                placeholder={t('targetValuePlaceholder')}
                                disabled={pending}
                            />
                            <Input
                                aria-label={t('targetUnitPlaceholder')}
                                value={targetUnit}
                                onChange={(event) => setTargetUnit(event.target.value)}
                                placeholder={t('targetUnitPlaceholder')}
                                maxLength={32}
                                disabled={pending}
                            />
                        </div>
                    </div>

                    <div className="space-y-1.5">
                        <label
                            htmlFor="campaign-channels"
                            className="text-xs font-medium text-text dark:text-text-dark"
                        >
                            {t('channelsLabel')}
                        </label>
                        <Input
                            id="campaign-channels"
                            value={channels}
                            onChange={(event) => setChannels(event.target.value)}
                            placeholder={t('channelsPlaceholder')}
                            disabled={pending}
                        />
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('channelsHelper')}
                        </p>
                    </div>

                    <div className="rounded-md border border-border dark:border-border-dark px-4 py-3">
                        <h3 className="text-xs font-semibold text-text dark:text-text-dark">
                            {t('provisions.title')}
                        </h3>
                        <ul className="mt-1.5 space-y-1 text-xs text-text-muted dark:text-text-muted-dark list-disc pl-4">
                            <li>{t('provisions.work')}</li>
                            <li>{t('provisions.goal')}</li>
                            <li>{t('provisions.agents')}</li>
                            <li>{t('provisions.tasks')}</li>
                            <li>{t('provisions.pipeline')}</li>
                        </ul>
                    </div>
                </div>

                <div className="flex items-center justify-end gap-2 border-t border-card-border dark:border-border-secondary-dark px-5 py-3.5">
                    <Button type="submit" disabled={!canSubmit} data-testid="campaign-submit">
                        {pending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                        {pending ? t('submitting') : t('submit')}
                    </Button>
                </div>
            </form>
        </div>
    );
}
