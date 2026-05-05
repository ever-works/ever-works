'use client';

import { useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { LayoutTemplate, Search, Plus, Sparkles, Github, ExternalLink } from 'lucide-react';
import type { TemplateCatalogItem, TemplateKind } from '@/lib/api/templates';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { addCustomTemplate, setDefaultTemplate } from '@/app/actions/dashboard/templates';
import { cn } from '@/lib/utils/cn';

type FilterMode = 'all' | 'built_in' | 'custom';

interface TemplatesCatalogProps {
    kind: TemplateKind;
    templates: TemplateCatalogItem[];
    defaultTemplateId: string | null;
}

interface AddTemplateFormState {
    repositoryUrl: string;
    name: string;
    description: string;
    framework: string;
    branch: string;
}

const EMPTY_FORM: AddTemplateFormState = {
    repositoryUrl: '',
    name: '',
    description: '',
    framework: '',
    branch: '',
};

function frameworkTone(framework?: string | null) {
    const value = framework?.toLowerCase() || '';

    if (value.includes('astro')) {
        return {
            shell: 'from-orange-500/20 via-amber-500/10 to-transparent',
            badge: 'bg-orange-500/12 text-orange-700 dark:text-orange-300',
            accent: 'border-orange-500/30',
        };
    }

    if (value.includes('next')) {
        return {
            shell: 'from-slate-900/20 via-slate-500/10 to-transparent dark:from-white/12 dark:via-white/6',
            badge: 'bg-slate-900/8 text-slate-700 dark:text-slate-200',
            accent: 'border-slate-900/15 dark:border-white/10',
        };
    }

    return {
        shell: 'from-teal-500/18 via-cyan-500/8 to-transparent',
        badge: 'bg-teal-500/12 text-teal-700 dark:text-teal-300',
        accent: 'border-teal-500/20',
    };
}

function initials(name: string): string {
    return name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part.charAt(0).toUpperCase())
        .join('');
}

function TemplateCard({
    template,
    isDefault,
    canSetDefault,
    onSetDefault,
    loading,
}: {
    template: TemplateCatalogItem;
    isDefault: boolean;
    canSetDefault: boolean;
    onSetDefault: (templateId: string) => void;
    loading: boolean;
}) {
    const t = useTranslations('dashboard.templates');
    const tone = frameworkTone(template.framework);

    return (
        <article
            className={cn(
                'group relative overflow-hidden rounded-3xl border bg-white dark:bg-surface-dark',
                'border-border dark:border-border-dark',
                'shadow-[0_20px_50px_-35px_rgba(15,23,42,0.35)] dark:shadow-[0_24px_60px_-40px_rgba(0,0,0,0.7)]',
            )}
        >
            <div
                className={cn(
                    'absolute inset-x-0 top-0 h-32 bg-gradient-to-br opacity-100',
                    tone.shell,
                )}
            />
            <div className="relative p-5">
                <div className="mb-5 flex items-start justify-between gap-3">
                    <div
                        className={cn(
                            'flex h-14 w-14 shrink-0 items-end rounded-2xl border px-3 py-2',
                            'bg-white/90 dark:bg-black/30 backdrop-blur-sm',
                            tone.accent,
                        )}
                    >
                        <span className="text-lg font-semibold tracking-tight text-text dark:text-text-dark">
                            {initials(template.name)}
                        </span>
                    </div>
                    <div className="flex flex-wrap justify-end gap-2">
                        {template.framework ? (
                            <span
                                className={cn(
                                    'rounded-full px-2.5 py-1 text-[11px] font-medium',
                                    tone.badge,
                                )}
                            >
                                {template.framework}
                            </span>
                        ) : null}
                        <span className="rounded-full bg-surface-secondary px-2.5 py-1 text-[11px] font-medium text-text-secondary dark:bg-white/6 dark:text-text-secondary-dark">
                            {template.sourceType === 'built_in'
                                ? t('card.builtIn')
                                : t('card.custom')}
                        </span>
                        {isDefault ? (
                            <span className="rounded-full bg-primary/12 px-2.5 py-1 text-[11px] font-medium text-primary">
                                {t('card.default')}
                            </span>
                        ) : null}
                    </div>
                </div>

                <div className="space-y-2">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <h3 className="text-lg font-semibold leading-tight text-text dark:text-text-dark">
                                {template.name}
                            </h3>
                            <p className="mt-1 flex items-center gap-2 text-xs text-text-muted dark:text-text-muted-dark">
                                <Github className="h-3.5 w-3.5" />
                                <span className="truncate">
                                    {template.repositoryOwner}/{template.repositoryName}
                                </span>
                            </p>
                        </div>
                    </div>

                    <p className="min-h-[44px] text-sm leading-6 text-text-secondary dark:text-text-secondary-dark">
                        {template.description || t('card.noDescription')}
                    </p>
                </div>

                <div className="mt-5 flex flex-wrap gap-2">
                    <span className="rounded-full border border-border bg-white px-2.5 py-1 text-[11px] text-text-secondary dark:border-border-dark dark:bg-white/4 dark:text-text-secondary-dark">
                        {t('card.branch', { branch: template.branch })}
                    </span>
                    <span className="rounded-full border border-border bg-white px-2.5 py-1 text-[11px] text-text-secondary dark:border-border-dark dark:bg-white/4 dark:text-text-secondary-dark">
                        {t('card.syncBranches', { count: template.syncBranches.length })}
                    </span>
                </div>

                <div className="mt-6 flex items-center justify-between gap-3 border-t border-border/70 pt-4 dark:border-border-dark/70">
                    {template.repositoryUrl ? (
                        <a
                            href={template.repositoryUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-sm text-text-secondary transition-colors hover:text-text dark:text-text-secondary-dark dark:hover:text-text-dark"
                        >
                            <ExternalLink className="h-4 w-4" />
                            {t('card.openRepository')}
                        </a>
                    ) : (
                        <span className="text-sm text-text-muted dark:text-text-muted-dark">
                            {t('card.catalogOnly')}
                        </span>
                    )}

                    {canSetDefault ? (
                        <Button
                            variant={isDefault ? 'secondary' : 'primary'}
                            size="sm"
                            loading={loading}
                            disabled={isDefault || loading}
                            onClick={() => onSetDefault(template.id)}
                            className="shrink-0 rounded-xl"
                        >
                            {isDefault ? t('card.defaultSelected') : t('card.makeDefault')}
                        </Button>
                    ) : (
                        <span className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('card.customCatalogHint')}
                        </span>
                    )}
                </div>
            </div>
        </article>
    );
}

export function TemplatesCatalog({
    kind,
    templates: initialTemplates,
    defaultTemplateId,
}: TemplatesCatalogProps) {
    const t = useTranslations('dashboard.templates');
    const [templates, setTemplates] = useState(initialTemplates);
    const [currentDefaultTemplateId, setCurrentDefaultTemplateId] = useState(defaultTemplateId);
    const [searchQuery, setSearchQuery] = useState('');
    const [filterMode, setFilterMode] = useState<FilterMode>('all');
    const [dialogOpen, setDialogOpen] = useState(false);
    const [formState, setFormState] = useState<AddTemplateFormState>(EMPTY_FORM);
    const [isSavingDefault, startSavingDefault] = useTransition();
    const [isAddingTemplate, startAddingTemplate] = useTransition();

    const filteredTemplates = useMemo(() => {
        const normalizedQuery = searchQuery.trim().toLowerCase();

        return templates.filter((template) => {
            if (filterMode !== 'all' && template.sourceType !== filterMode) {
                return false;
            }

            if (!normalizedQuery) {
                return true;
            }

            const haystack = [
                template.name,
                template.description || '',
                template.framework || '',
                template.repositoryOwner,
                template.repositoryName,
            ]
                .join(' ')
                .toLowerCase();

            return haystack.includes(normalizedQuery);
        });
    }, [filterMode, searchQuery, templates]);

    const builtInCount = templates.filter((template) => template.sourceType === 'built_in').length;
    const customCount = templates.filter((template) => template.sourceType === 'custom').length;
    const activeDefaultTemplate = templates.find(
        (template) => template.id === currentDefaultTemplateId,
    );

    const resetDialog = () => {
        setFormState(EMPTY_FORM);
        setDialogOpen(false);
    };

    const handleSetDefault = (templateId: string) => {
        startSavingDefault(() => {
            void (async () => {
                const result = await setDefaultTemplate({ kind, templateId });

                if (!result.success || !result.defaultTemplateId) {
                    toast.error(result.error || t('messages.defaultFailed'));
                    return;
                }

                setCurrentDefaultTemplateId(result.defaultTemplateId);
                setTemplates((current) =>
                    current.map((template) => ({
                        ...template,
                        isDefault: template.id === result.defaultTemplateId,
                    })),
                );
                toast.success(t('messages.defaultUpdated'));
            })();
        });
    };

    const handleAddTemplate = () => {
        const repositoryUrl = formState.repositoryUrl.trim();
        if (!repositoryUrl) {
            toast.error(t('messages.repositoryUrlRequired'));
            return;
        }

        startAddingTemplate(() => {
            void (async () => {
                const result = await addCustomTemplate({
                    kind,
                    repositoryUrl,
                    name: formState.name.trim() || undefined,
                    description: formState.description.trim() || undefined,
                    framework: formState.framework.trim() || undefined,
                    branch: formState.branch.trim() || undefined,
                });

                if (!result.success || !result.template) {
                    toast.error(result.error || t('messages.addFailed'));
                    return;
                }

                setTemplates((current) => {
                    const next = [...current, result.template];
                    return next.sort((a, b) => {
                        if (a.sourceType !== b.sourceType) {
                            return a.sourceType.localeCompare(b.sourceType);
                        }
                        return a.name.localeCompare(b.name);
                    });
                });
                toast.success(t('messages.addSuccess'));
                resetDialog();
            })();
        });
    };

    return (
        <div className="space-y-8">
            <section className="overflow-hidden rounded-[2rem] border border-border bg-white dark:border-border-dark dark:bg-surface-dark">
                <div className="grid gap-6 px-6 py-6 lg:grid-cols-[1.35fr_0.95fr] lg:px-8 lg:py-8">
                    <div className="space-y-4">
                        <div className="inline-flex items-center gap-2 rounded-full border border-border bg-surface-secondary px-3 py-1 text-xs font-medium text-text-secondary dark:border-border-dark dark:bg-white/6 dark:text-text-secondary-dark">
                            <Sparkles className="h-3.5 w-3.5" />
                            {t('hero.eyebrow')}
                        </div>
                        <div className="space-y-3">
                            <h1 className="text-3xl font-semibold tracking-tight text-text dark:text-text-dark">
                                {t('title')}
                            </h1>
                            <p className="max-w-2xl text-sm leading-7 text-text-secondary dark:text-text-secondary-dark">
                                {t('subtitle')}
                            </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                            <Button
                                size="sm"
                                className="rounded-xl"
                                onClick={() => setDialogOpen(true)}
                            >
                                <Plus className="h-4 w-4" />
                                {t('actions.addTemplate')}
                            </Button>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('hero.catalogHint')}
                            </p>
                        </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
                        <div className="rounded-3xl border border-border bg-surface px-4 py-4 dark:border-border-dark dark:bg-white/4">
                            <p className="text-xs uppercase tracking-[0.18em] text-text-muted dark:text-text-muted-dark">
                                {t('stats.defaultLabel')}
                            </p>
                            <p className="mt-3 text-lg font-semibold text-text dark:text-text-dark">
                                {activeDefaultTemplate?.name || t('stats.none')}
                            </p>
                            <p className="mt-1 text-xs text-text-secondary dark:text-text-secondary-dark">
                                {t('stats.defaultHint')}
                            </p>
                        </div>
                        <div className="rounded-3xl border border-border bg-surface px-4 py-4 dark:border-border-dark dark:bg-white/4">
                            <p className="text-xs uppercase tracking-[0.18em] text-text-muted dark:text-text-muted-dark">
                                {t('stats.builtInLabel')}
                            </p>
                            <p className="mt-3 text-2xl font-semibold text-text dark:text-text-dark">
                                {builtInCount}
                            </p>
                            <p className="mt-1 text-xs text-text-secondary dark:text-text-secondary-dark">
                                {t('stats.builtInHint')}
                            </p>
                        </div>
                        <div className="rounded-3xl border border-border bg-surface px-4 py-4 dark:border-border-dark dark:bg-white/4">
                            <p className="text-xs uppercase tracking-[0.18em] text-text-muted dark:text-text-muted-dark">
                                {t('stats.customLabel')}
                            </p>
                            <p className="mt-3 text-2xl font-semibold text-text dark:text-text-dark">
                                {customCount}
                            </p>
                            <p className="mt-1 text-xs text-text-secondary dark:text-text-secondary-dark">
                                {t('stats.customHint')}
                            </p>
                        </div>
                    </div>
                </div>
            </section>

            <section className="flex flex-col gap-4 rounded-[2rem] border border-border bg-white px-5 py-5 dark:border-border-dark dark:bg-surface-dark lg:flex-row lg:items-center lg:justify-between">
                <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted dark:text-text-muted-dark" />
                    <Input
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder={t('filters.searchPlaceholder')}
                        className="rounded-2xl pl-11"
                    />
                </div>
                <div className="flex flex-wrap gap-2">
                    {(['all', 'built_in', 'custom'] as const).map((mode) => (
                        <Button
                            key={mode}
                            variant={filterMode === mode ? 'primary' : 'ghost'}
                            size="sm"
                            className="rounded-full"
                            onClick={() => setFilterMode(mode)}
                        >
                            {mode === 'all'
                                ? t('filters.all')
                                : mode === 'built_in'
                                  ? t('filters.builtIn')
                                  : t('filters.custom')}
                        </Button>
                    ))}
                </div>
            </section>

            {filteredTemplates.length === 0 ? (
                <section className="rounded-[2rem] border border-dashed border-border bg-white px-6 py-16 text-center dark:border-border-dark dark:bg-surface-dark">
                    <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-secondary dark:bg-white/6">
                        <LayoutTemplate className="h-6 w-6 text-text-muted dark:text-text-muted-dark" />
                    </div>
                    <h2 className="mt-5 text-lg font-semibold text-text dark:text-text-dark">
                        {t('empty.title')}
                    </h2>
                    <p className="mx-auto mt-2 max-w-md text-sm leading-7 text-text-secondary dark:text-text-secondary-dark">
                        {searchQuery ? t('empty.search') : t('empty.default')}
                    </p>
                </section>
            ) : (
                <section className="grid grid-cols-1 gap-5 @3xl/main:grid-cols-2">
                    {filteredTemplates.map((template) => (
                        <TemplateCard
                            key={template.id}
                            template={template}
                            isDefault={template.id === currentDefaultTemplateId}
                            canSetDefault={template.sourceType === 'built_in'}
                            onSetDefault={handleSetDefault}
                            loading={isSavingDefault}
                        />
                    ))}
                </section>
            )}

            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogContent className="max-w-2xl rounded-[2rem] p-0">
                    <div className="relative overflow-hidden rounded-[2rem] border border-border bg-white dark:border-border-dark dark:bg-surface-dark">
                        <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-br from-cyan-500/14 via-teal-500/8 to-transparent" />
                        <div className="relative p-6">
                            <DialogClose onClose={resetDialog} />
                            <DialogHeader className="mb-6 pr-8">
                                <DialogTitle className="text-xl font-semibold text-text dark:text-text-dark">
                                    {t('dialog.title')}
                                </DialogTitle>
                                <DialogDescription className="mt-2 max-w-xl leading-6">
                                    {t('dialog.description')}
                                </DialogDescription>
                            </DialogHeader>

                            <div className="space-y-4">
                                <Input
                                    label={t('dialog.repositoryUrlLabel')}
                                    placeholder={t('dialog.repositoryUrlPlaceholder')}
                                    value={formState.repositoryUrl}
                                    onChange={(event) =>
                                        setFormState((current) => ({
                                            ...current,
                                            repositoryUrl: event.target.value,
                                        }))
                                    }
                                />

                                <div className="grid gap-4 md:grid-cols-2">
                                    <Input
                                        label={t('dialog.nameLabel')}
                                        placeholder={t('dialog.namePlaceholder')}
                                        value={formState.name}
                                        onChange={(event) =>
                                            setFormState((current) => ({
                                                ...current,
                                                name: event.target.value,
                                            }))
                                        }
                                    />
                                    <Input
                                        label={t('dialog.frameworkLabel')}
                                        placeholder={t('dialog.frameworkPlaceholder')}
                                        value={formState.framework}
                                        onChange={(event) =>
                                            setFormState((current) => ({
                                                ...current,
                                                framework: event.target.value,
                                            }))
                                        }
                                    />
                                </div>

                                <Textarea
                                    rows={4}
                                    label={t('dialog.descriptionLabel')}
                                    placeholder={t('dialog.descriptionPlaceholder')}
                                    value={formState.description}
                                    onChange={(event) =>
                                        setFormState((current) => ({
                                            ...current,
                                            description: event.target.value,
                                        }))
                                    }
                                />

                                <Input
                                    label={t('dialog.branchLabel')}
                                    placeholder={t('dialog.branchPlaceholder')}
                                    value={formState.branch}
                                    onChange={(event) =>
                                        setFormState((current) => ({
                                            ...current,
                                            branch: event.target.value,
                                        }))
                                    }
                                    helperText={t('dialog.branchHelp')}
                                />
                            </div>

                            <DialogFooter className="mt-8">
                                <Button
                                    variant="ghost"
                                    onClick={resetDialog}
                                    disabled={isAddingTemplate}
                                >
                                    {t('dialog.cancel')}
                                </Button>
                                <Button
                                    onClick={handleAddTemplate}
                                    loading={isAddingTemplate}
                                    className="rounded-xl"
                                >
                                    {t('dialog.submit')}
                                </Button>
                            </DialogFooter>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
