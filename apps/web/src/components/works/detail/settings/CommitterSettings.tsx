'use client';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { useSettings } from './SettingsContext';
import { Button } from '@/components/ui/button';
import { updateCommitterSettings } from '@/app/actions/dashboard/works';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';

export function CommitterSettings() {
    const t = useTranslations('dashboard.workDetail.settings');
    const { context } = useSettings();
    const { work, user } = context;

    const [committerName, setCommitterName] = useState(work.committerName || '');
    const [committerEmail, setCommitterEmail] = useState(work.committerEmail || '');
    const [isPending, startTransition] = useTransition();

    const handleSave = (e: React.FormEvent) => {
        e.preventDefault();
        startTransition(async () => {
            const result = await updateCommitterSettings(work.id, {
                committerName: committerName.trim() || null,
                committerEmail: committerEmail.trim() || null,
            });
            if (result?.success) {
                toast.success(t('committer.saved'));
            } else {
                toast.error(result?.error || t('committer.saveFailed'));
            }
        });
    };

    // Placeholders show the auth defaults (actual fallback includes user-level settings)
    const defaultName = user.username;
    const defaultEmail = user.email;

    return (
        <div
            className={cn(
                'rounded-lg border overflow-hidden',
                'bg-card dark:bg-card-primary-dark/30',
                'border-card-border dark:border-border-secondary-dark',
            )}
        >
            <div className="px-5 py-3.5 border-b border-card-border dark:border-border-secondary-dark">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('committer.title')}
                </h3>
            </div>

            <form onSubmit={handleSave} className="px-5 py-4 space-y-4">
                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                    {t('committer.description')}
                </p>

                <Input
                    label={t('committer.nameLabel')}
                    type="text"
                    value={committerName}
                    onChange={(e) => setCommitterName(e.target.value)}
                    placeholder={defaultName}
                    variant="form"
                />

                <Input
                    label={t('committer.emailLabel')}
                    type="email"
                    value={committerEmail}
                    onChange={(e) => setCommitterEmail(e.target.value)}
                    placeholder={defaultEmail || undefined}
                    variant="form"
                />

                <Button
                    type="submit"
                    disabled={isPending}
                    loading={isPending}
                    variant="primary"
                    className="text-sm"
                >
                    {t('committer.save')}
                </Button>
            </form>
        </div>
    );
}
