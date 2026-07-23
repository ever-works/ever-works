'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Target } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { CreateMissionInput, Mission } from '@/lib/api/missions';

type CreateMissionFn = (input: CreateMissionInput) => Promise<Mission>;

const MIN_DESCRIPTION_LENGTH = 10;
const MAX_DESCRIPTION_LENGTH = 10000;
const MAX_TITLE_LENGTH = 200;
const MAX_SCHEDULE_LENGTH = 64;

/**
 * Dedicated `/missions/new` manual-create form.
 *
 * The `/missions` quick-add composer hands the prompt to the chat AI and
 * relies on the model calling the `createMission` tool. That makes Mission
 * creation depend on an LLM being reachable, on per-turn tool gating keeping
 * `createMission` active, and on the model choosing to call it — when any of
 * those fails the user sees the assistant ask a question, answers it, and
 * nothing happens, with no way to recover.
 *
 * This form is the deterministic no-AI path: it posts straight through the
 * existing `createMissionAction` server action to `POST /me/missions`. It
 * sits ALONGSIDE the composer, exactly as `/ideas/new` does for Ideas.
 *
 * The `type` / `schedule` pairing mirrors the server contract enforced by
 * `MissionsService.assertScheduleConsistency`: a `scheduled` Mission must
 * carry a cron expression, a `one-shot` Mission must not.
 */
export function NewMissionForm({ createMission }: { createMission: CreateMissionFn }) {
    const t = useTranslations('dashboard.missionsPage.newPage');
    const router = useRouter();
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [type, setType] = useState<'one-shot' | 'scheduled'>('one-shot');
    const [schedule, setSchedule] = useState('');
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    const trimmedDescription = description.trim();
    const trimmedSchedule = schedule.trim();
    const scheduleMissing = type === 'scheduled' && trimmedSchedule.length === 0;
    const canSubmit =
        trimmedDescription.length >= MIN_DESCRIPTION_LENGTH && !scheduleMissing && !pending;

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (trimmedDescription.length < MIN_DESCRIPTION_LENGTH) {
            setError(t('minLength'));
            return;
        }
        if (scheduleMissing) {
            setError(t('scheduleRequired'));
            return;
        }
        setError(null);
        const trimmedTitle = title.trim();
        startTransition(() => {
            void (async () => {
                try {
                    const mission = await createMission({
                        description: trimmedDescription,
                        type,
                        // The server rejects a schedule on a one-shot Mission,
                        // so send `null` rather than an empty string.
                        schedule: type === 'scheduled' ? trimmedSchedule : null,
                        ...(trimmedTitle ? { title: trimmedTitle } : {}),
                    });
                    toast.success(t('created'));
                    router.push(`${ROUTES.DASHBOARD_MISSIONS}/${mission.id}`);
                } catch {
                    // Security: never surface raw API error text (it may carry
                    // internal details). Show a localized generic message.
                    setError(t('error'));
                }
            })();
        });
    };

    return (
        <div className="max-w-xl mx-auto p-6">
            <div className="flex items-center gap-3 mb-6">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-concept-missions/10 border border-concept-missions/20 flex items-center justify-center">
                    <Target className="w-4 h-4 text-concept-missions" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                    <h1 className="text-xl font-semibold text-text dark:text-text-dark">
                        {t('title')}
                    </h1>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5">
                        {t('subtitle')}
                    </p>
                </div>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4" data-testid="new-mission-form">
                <div>
                    <label
                        htmlFor="new-mission-title"
                        className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1"
                    >
                        {t('nameLabel')}
                    </label>
                    <input
                        id="new-mission-title"
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder={t('namePlaceholder')}
                        maxLength={MAX_TITLE_LENGTH}
                        className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-9 text-sm text-text dark:text-text-dark"
                    />
                </div>

                <div>
                    <label
                        htmlFor="new-mission-description"
                        className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1"
                    >
                        {t('descriptionLabel')}
                    </label>
                    <textarea
                        id="new-mission-description"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        rows={6}
                        autoFocus
                        maxLength={MAX_DESCRIPTION_LENGTH}
                        placeholder={t('descriptionPlaceholder')}
                        aria-describedby="new-mission-description-hint"
                        className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-3 text-sm text-text dark:text-text-dark"
                    />
                    <p
                        id="new-mission-description-hint"
                        className="mt-1 text-xs text-text-muted dark:text-text-muted-dark"
                    >
                        {t('descriptionHint')}
                    </p>
                </div>

                <div>
                    <label
                        htmlFor="new-mission-type"
                        className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1"
                    >
                        {t('typeLabel')}
                    </label>
                    <select
                        id="new-mission-type"
                        value={type}
                        onChange={(e) => setType(e.target.value as 'one-shot' | 'scheduled')}
                        className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-9 text-sm text-text dark:text-text-dark"
                    >
                        <option value="one-shot">{t('typeOneShot')}</option>
                        <option value="scheduled">{t('typeScheduled')}</option>
                    </select>
                </div>

                {type === 'scheduled' && (
                    <div>
                        <label
                            htmlFor="new-mission-schedule"
                            className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1"
                        >
                            {t('scheduleLabel')}
                        </label>
                        <input
                            id="new-mission-schedule"
                            type="text"
                            value={schedule}
                            onChange={(e) => setSchedule(e.target.value)}
                            placeholder={t('schedulePlaceholder')}
                            maxLength={MAX_SCHEDULE_LENGTH}
                            aria-describedby="new-mission-schedule-hint"
                            className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-9 font-mono text-sm text-text dark:text-text-dark"
                        />
                        <p
                            id="new-mission-schedule-hint"
                            className="mt-1 text-xs text-text-muted dark:text-text-muted-dark"
                        >
                            {t('scheduleHint')}
                        </p>
                    </div>
                )}

                {error && (
                    <p className="text-xs text-danger" role="alert">
                        {error}
                    </p>
                )}

                <div className="flex items-center justify-end gap-2">
                    <Button type="button" variant="ghost" size="sm" onClick={() => router.back()}>
                        {t('cancel')}
                    </Button>
                    <Button type="submit" size="sm" disabled={!canSubmit}>
                        {pending ? t('creating') : t('create')}
                    </Button>
                </div>
            </form>
        </div>
    );
}
