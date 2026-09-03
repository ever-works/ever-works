'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { GitBranch } from 'lucide-react';
import { createWork } from '@/app/actions/dashboard';
import { ROUTES } from '@/lib/constants';
import { useRouter } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
    canonicalRepositoryUrl,
    isCanonicalWorkSlug,
    parseRepositoryUrl,
    slugifyForWork,
} from '@/lib/work-kinds/repository-url';

/**
 * Create form for the `repo` Work kind (self-build slice D, EW-766).
 *
 * A Repository Work wraps an EXISTING code repository — the platform
 * monorepo, a template repo, the website repo — so Tasks, Goals and fleet
 * runs can attach to it. Nothing is generated for it, which is why this is
 * its own small form rather than a mode of `WorkAICreator`: there is no
 * prompt, no website template, no provider/pipeline selection and no
 * deploy target. The one input that matters is the repository URL; name,
 * slug and description are derived from it and stay editable.
 *
 * Submits through the manual `createWork` server action with
 * `kind: 'repo'` + `repositoryUrl`; the API registers the repository as the
 * Work's data repository (`POST /api/works`).
 */

// The parser, the slugifier and the canonicaliser live in
// `@/lib/work-kinds/repository-url` because the composers that route into
// this form need them too — whatever the user typed has to be reduced to
// canonical coordinates before it can go near a URL. Re-exported here so
// callers that already import it from the form keep working.
export { parseRepositoryUrl };

export interface RepositoryWorkFormProps {
    /** Git provider plugin id selected in the sidebar (connection gate on the action). */
    gitProvider?: string;
    /**
     * Seed for the URL field — what the user typed into the composer before
     * picking the Repository chip, when it already looks like a repo URL.
     */
    initialRepositoryUrl?: string;
}

export function RepositoryWorkForm({ gitProvider, initialRepositoryUrl }: RepositoryWorkFormProps) {
    const t = useTranslations('dashboard.workCreation.repo');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();

    const seed =
        initialRepositoryUrl && parseRepositoryUrl(initialRepositoryUrl)
            ? initialRepositoryUrl.trim()
            : '';
    const seedParsed = seed ? parseRepositoryUrl(seed) : null;

    const [repositoryUrl, setRepositoryUrl] = useState(seed);
    const [name, setName] = useState(seedParsed?.repo ?? '');
    const [slug, setSlug] = useState(seedParsed ? slugifyForWork(seedParsed.repo) : '');
    const [description, setDescription] = useState(
        seedParsed ? `${seedParsed.owner}/${seedParsed.repo}` : '',
    );
    // Once the user edits a derived field it stops following the URL.
    const [nameDirty, setNameDirty] = useState(false);
    const [slugDirty, setSlugDirty] = useState(false);
    const [descriptionDirty, setDescriptionDirty] = useState(false);

    const parsed = parseRepositoryUrl(repositoryUrl);
    const urlInvalid = repositoryUrl.trim().length > 0 && !parsed;

    const onUrlChange = (next: string) => {
        setRepositoryUrl(next);
        const coords = parseRepositoryUrl(next);
        if (!coords) return;
        if (!nameDirty) setName(coords.repo);
        if (!slugDirty) setSlug(slugifyForWork(coords.repo));
        if (!descriptionDirty) setDescription(`${coords.owner}/${coords.repo}`);
    };

    // The slug input carries a `pattern`, but this form submits from a
    // button handler rather than a native <form>, so nothing enforces it:
    // `My_Repo` would sail through to the server action and come back a
    // 400. Check it the same way the URL field is checked.
    const slugInvalid = slug.trim().length > 0 && !isCanonicalWorkSlug(slug);
    const canSubmit =
        !isPending && Boolean(parsed) && name.trim().length > 0 && isCanonicalWorkSlug(slug);

    const submit = () => {
        if (!parsed) {
            toast.error(t('invalidUrl'));
            return;
        }
        if (!isCanonicalWorkSlug(slug)) {
            toast.error(t('invalidSlug'));
            return;
        }
        startTransition(async () => {
            const result = await createWork({
                name: name.trim(),
                slug: slug.trim(),
                // The API requires a description; fall back to the
                // repository coordinates so the field is never empty.
                description: description.trim() || `${parsed.owner}/${parsed.repo}`,
                organization: false,
                gitProvider,
                kind: 'repo',
                // Canonical, never the raw field: `parsed` already proved it
                // reduces to owner/repo, and the API stores what we send.
                repositoryUrl: canonicalRepositoryUrl(repositoryUrl) ?? repositoryUrl.trim(),
            });
            if (result.success && result.work) {
                toast.success(t('success'));
                router.push(ROUTES.DASHBOARD_WORK(result.work.id));
                return;
            }
            toast.error(result.error || t('createFailed'));
        });
    };

    return (
        <div className="space-y-6" data-testid="repository-work-form">
            <div>
                <h1 className="text-3xl font-bold text-text dark:text-text-dark mb-2">
                    {t('formTitle')}
                </h1>
                <p className="text-text-secondary dark:text-text-secondary-dark">
                    {t('formSubtitle')}
                </p>
            </div>

            <div
                className={cn(
                    'p-6 rounded-lg space-y-4',
                    'bg-card dark:bg-transparent',
                    'border border-card-border dark:border-border-secondary-dark',
                )}
            >
                <Input
                    label={`${t('urlLabel')} *`}
                    type="url"
                    name="repositoryUrl"
                    value={repositoryUrl}
                    onChange={(e) => onUrlChange(e.target.value)}
                    placeholder={t('urlPlaceholder')}
                    helperText={t('urlHelp')}
                    error={urlInvalid ? t('invalidUrl') : undefined}
                    variant="form"
                    autoFocus
                    data-testid="repository-work-url"
                />

                <Input
                    label={`${t('nameLabel')} *`}
                    type="text"
                    name="name"
                    value={name}
                    onChange={(e) => {
                        setName(e.target.value);
                        setNameDirty(true);
                        if (!slugDirty) setSlug(slugifyForWork(e.target.value));
                    }}
                    variant="form"
                />

                <Input
                    label={`${t('slugLabel')} *`}
                    type="text"
                    name="slug"
                    value={slug}
                    onChange={(e) => {
                        setSlug(e.target.value);
                        setSlugDirty(true);
                    }}
                    pattern="[a-z0-9-]+"
                    helperText={t('slugHelp')}
                    variant="form"
                />

                <Textarea
                    label={t('descriptionLabel')}
                    name="description"
                    value={description}
                    onChange={(e) => {
                        setDescription(e.target.value);
                        setDescriptionDirty(true);
                    }}
                    rows={3}
                    variant="form"
                />
            </div>

            <div className="flex gap-3">
                <Button
                    onClick={submit}
                    disabled={!canSubmit}
                    loading={isPending}
                    variant="primary"
                    size="lg"
                    fullWidth
                    data-testid="repository-work-submit"
                >
                    {isPending ? (
                        t('creatingButton')
                    ) : (
                        <>
                            <GitBranch className="w-5 h-5" />
                            {t('submitButton')}
                        </>
                    )}
                </Button>
                <Button
                    onClick={() => router.back()}
                    disabled={isPending}
                    variant="secondary"
                    size="lg"
                    className="px-6"
                >
                    {t('cancelButton')}
                </Button>
            </div>

            <div
                className={cn(
                    'p-4 rounded-lg',
                    'bg-surface dark:bg-surface-dark',
                    'border border-border dark:border-border-dark',
                )}
            >
                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                    <strong>{t('noteTitle')}</strong> {t('noteText')}
                </p>
            </div>
        </div>
    );
}
