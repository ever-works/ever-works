'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Lightbulb } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { CreateIdeaInput, WorkProposal } from '@/lib/api/work-proposals';

type CreateIdeaFn = (input: CreateIdeaInput) => Promise<WorkProposal>;

const MIN_DESCRIPTION_LENGTH = 10;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_TITLE_LENGTH = 120;

/**
 * Dedicated `/ideas/new` manual-create form. The `/ideas` quick-add
 * composer hands prompts to the chat AI; this is the deterministic
 * no-AI path — title (optional) + description (required) typed in by
 * the user, persisted as a `USER_MANUAL` Idea via `createIdea`
 * (→ `POST /api/me/work-proposals`).
 */
export function NewIdeaForm({ createIdea }: { createIdea: CreateIdeaFn }) {
    const t = useTranslations('dashboard.ideasPage.newPage');
    const tToasts = useTranslations('dashboard.ideasPage.toasts');
    const router = useRouter();
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    const trimmedDescription = description.trim();
    const canSubmit = trimmedDescription.length >= MIN_DESCRIPTION_LENGTH && !pending;

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (trimmedDescription.length < MIN_DESCRIPTION_LENGTH) {
            setError(t('minLength'));
            return;
        }
        setError(null);
        const trimmedTitle = title.trim();
        startTransition(() => {
            void (async () => {
                try {
                    await createIdea({
                        description: trimmedDescription,
                        title: trimmedTitle ? trimmedTitle : undefined,
                    });
                    toast.success(tToasts('ideaCreated'));
                    router.push(ROUTES.DASHBOARD_IDEAS);
                } catch {
                    // Security: never surface raw API error text (may carry
                    // internal details). Show a localized generic message.
                    setError(t('error'));
                }
            })();
        });
    };

    return (
        <div className="max-w-xl mx-auto p-6">
            <div className="flex items-center gap-3 mb-6">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-concept-ideas/10 border border-concept-ideas/20 flex items-center justify-center">
                    <Lightbulb className="w-4 h-4 text-concept-ideas" aria-hidden="true" />
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

            <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                    <label
                        htmlFor="new-idea-title"
                        className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1"
                    >
                        {t('nameLabel')}
                    </label>
                    <input
                        id="new-idea-title"
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
                        htmlFor="new-idea-description"
                        className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1"
                    >
                        {t('descriptionLabel')}
                    </label>
                    <textarea
                        id="new-idea-description"
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        rows={6}
                        autoFocus
                        maxLength={MAX_DESCRIPTION_LENGTH}
                        placeholder={t('descriptionPlaceholder')}
                        aria-describedby="new-idea-description-hint"
                        className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-3 text-sm text-text dark:text-text-dark"
                    />
                    <p
                        id="new-idea-description-hint"
                        className="mt-1 text-xs text-text-muted dark:text-text-muted-dark"
                    >
                        {t('descriptionHint')}
                    </p>
                </div>
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
