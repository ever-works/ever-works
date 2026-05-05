'use client';

import { useMemo, useState, useTransition } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { parseGitHubRepositoryUrl } from '@ever-works/contracts';
import { toast } from 'sonner';
import {
    LayoutTemplate,
    Search,
    Plus,
    Sparkles,
    Github,
    ExternalLink,
    GitFork,
    PencilLine,
    RefreshCw,
    Trash2,
} from 'lucide-react';
import type { TemplateCatalogItem, TemplateKind, TemplateOriginType } from '@/lib/api/templates';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
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
import {
    addCustomTemplate,
    archiveCustomTemplate,
    forkTemplate,
    refreshTemplates,
    setDefaultTemplate,
    updateCustomTemplate,
} from '@/app/actions/dashboard/templates';
import { cn } from '@/lib/utils/cn';

type FilterMode = 'all' | 'built_in' | 'custom';

interface TemplatesCatalogProps {
    kind: TemplateKind;
    templates: TemplateCatalogItem[];
    defaultTemplateId: string | null;
    forkTargets: ForkTarget[];
}

interface ForkTarget {
    login: string;
    label: string;
    kind: 'personal' | 'organization';
}

interface AddTemplateFormState {
    repositoryUrl: string;
    name: string;
    description: string;
    framework: string;
    previewImageUrl: string;
    branch: string;
}

const EMPTY_FORM: AddTemplateFormState = {
    repositoryUrl: '',
    name: '',
    description: '',
    framework: '',
    previewImageUrl: '',
    branch: '',
};

function compareTemplates(a: TemplateCatalogItem, b: TemplateCatalogItem) {
    if (a.sourceType !== b.sourceType) {
        return a.sourceType === 'custom' ? -1 : 1;
    }

    return a.name.localeCompare(b.name);
}

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

function originLabelKey(originType: TemplateOriginType) {
    switch (originType) {
        case 'standard':
            return 'card.standard';
        case 'forked':
            return 'card.forked';
        case 'custom_url':
            return 'card.customUrl';
    }
}

function sourceLabelKey(originType: TemplateOriginType) {
    switch (originType) {
        case 'standard':
            return 'card.standardSource';
        case 'forked':
            return 'card.forkedSource';
        case 'custom_url':
            return 'card.customUrlSource';
    }
}

function getTemplatePreviewUrl(template: TemplateCatalogItem): string | null {
    if (template.previewImageUrl) {
        return template.previewImageUrl;
    }

    if (!template.repositoryOwner || !template.repositoryName) {
        return null;
    }

    const cacheKey = encodeURIComponent(`${template.id}-${template.branch}`);
    const owner = encodeURIComponent(template.repositoryOwner);
    const repository = encodeURIComponent(template.repositoryName);

    return `https://opengraph.githubassets.com/${cacheKey}/${owner}/${repository}`;
}

function TemplateCard({
    template,
    isDefault,
    onSetDefault,
    onFork,
    onEdit,
    onArchive,
    loading,
    forkLoading,
    archiveLoading,
}: {
    template: TemplateCatalogItem;
    isDefault: boolean;
    onSetDefault: (templateId: string) => void;
    onFork: (template: TemplateCatalogItem) => void;
    onEdit: (template: TemplateCatalogItem) => void;
    onArchive: (template: TemplateCatalogItem) => void;
    loading: boolean;
    forkLoading: boolean;
    archiveLoading: boolean;
}) {
    const t = useTranslations('dashboard.templates');
    const tone = frameworkTone(template.framework);
    const [previewFailed, setPreviewFailed] = useState(false);
    const previewUrl = previewFailed ? null : getTemplatePreviewUrl(template);
    const sourceLabel = t(sourceLabelKey(template.originType));
    const originLabel = t(originLabelKey(template.originType));

    return (
        <article
            className={cn(
                'group overflow-hidden rounded-xl border bg-card dark:bg-card-primary-dark/30',
                'border-card-border dark:border-border-secondary-dark',
                'shadow-xs transition-colors hover:border-primary/35 dark:hover:border-white/15',
            )}
        >
            <div className="p-4">
                <div className="mb-4 overflow-hidden rounded-lg border border-card-border dark:border-border-dark bg-slate-950">
                    <div className="relative aspect-[1.8]">
                        {previewUrl ? (
                            <Image
                                src={previewUrl}
                                alt={t('card.previewAlt', { name: template.name })}
                                fill
                                sizes="(min-width: 1600px) 30vw, (min-width: 1024px) 44vw, 100vw"
                                className="object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                                onError={() => setPreviewFailed(true)}
                            />
                        ) : (
                            <div
                                className={cn(
                                    'absolute inset-0 bg-gradient-to-br',
                                    tone.shell,
                                    'from-slate-950 via-slate-900 to-slate-800 dark:from-slate-950 dark:via-slate-900 dark:to-black',
                                )}
                            >
                                <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.22),transparent_34%),radial-gradient(circle_at_80%_20%,rgba(255,255,255,0.12),transparent_28%),linear-gradient(135deg,rgba(255,255,255,0.06),transparent_55%)]" />
                                <div className="absolute inset-x-0 bottom-0 top-1/3 bg-[linear-gradient(180deg,transparent,rgba(15,23,42,0.92))]" />
                            </div>
                        )}

                        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(15,23,42,0.12),rgba(15,23,42,0.68))]" />

                        <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-4">
                            <div className="flex flex-wrap gap-2">
                                {template.framework ? (
                                    <span
                                        className={cn(
                                            'rounded-full px-2 py-0.5 text-[11px] font-medium backdrop-blur-sm',
                                            tone.badge,
                                        )}
                                    >
                                        {template.framework}
                                    </span>
                                ) : null}
                                <span className="rounded-full bg-white/12 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm">
                                    {originLabel}
                                </span>
                                {isDefault ? (
                                    <span className="rounded-full bg-primary/85 px-2 py-0.5 text-[11px] font-medium text-primary-foreground">
                                        {t('card.default')}
                                    </span>
                                ) : null}
                            </div>

                            <div
                                className={cn(
                                    'flex h-10 w-10 shrink-0 items-end rounded-xl border px-2 py-1.5 text-white shadow-md backdrop-blur-sm',
                                    'bg-white/10',
                                    tone.accent,
                                )}
                            >
                                <span className="text-sm font-semibold tracking-tight">
                                    {initials(template.name)}
                                </span>
                            </div>
                        </div>

                        <div className="absolute inset-x-0 bottom-0 p-3">
                            <div className="rounded-lg border border-white/12 bg-black/35 p-3 backdrop-blur-md">
                                <p className="text-[11px] uppercase tracking-[0.24em] text-white/62">
                                    {sourceLabel}
                                </p>
                                <h3 className="mt-1.5 text-base font-semibold leading-tight text-white">
                                    {template.name}
                                </h3>
                                <p className="mt-1.5 flex items-center gap-2 text-xs text-white/72">
                                    <Github className="h-3.5 w-3.5" />
                                    <span className="truncate">
                                        {template.repositoryOwner}/{template.repositoryName}
                                    </span>
                                </p>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="space-y-2.5">
                    <div className="flex flex-wrap gap-1.5">
                        {!template.framework ? (
                            <span className="rounded-full bg-surface-secondary px-2 py-0.5 text-[11px] font-medium text-text-secondary dark:bg-white/6 dark:text-text-secondary-dark">
                                {t('card.frameworkAgnostic')}
                            </span>
                        ) : null}
                    </div>
                    <div className="space-y-2.5">
                        <div className="flex flex-wrap gap-1.5">
                            <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] font-medium text-text-secondary dark:border-border-dark dark:bg-white/4 dark:text-text-secondary-dark">
                                {t('card.branch', { branch: template.branch })}
                            </span>
                            <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] font-medium text-text-secondary dark:border-border-dark dark:bg-white/4 dark:text-text-secondary-dark">
                                {t('card.syncBranches', { count: template.syncBranches.length })}
                            </span>
                            {template.betaBranch ? (
                                <span className="rounded-full border border-amber-500/25 bg-amber-500/8 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                                    {t('card.betaBranch', { branch: template.betaBranch })}
                                </span>
                            ) : null}
                        </div>
                        <p className="text-sm leading-6 text-text-secondary dark:text-text-secondary-dark line-clamp-3 min-h-[4.5rem]">
                            {template.description || t('card.noDescription')}
                        </p>
                    </div>
                </div>

                <div className="mt-4 space-y-3 border-t border-card-border pt-3 dark:border-border-secondary-dark">
                    <div className="flex items-center justify-between gap-3">
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
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                        {template.sourceType === 'built_in' ? (
                            <Button
                                variant="ghost"
                                size="sm"
                                loading={forkLoading}
                                disabled={loading || forkLoading}
                                onClick={() => onFork(template)}
                                className="shrink-0"
                            >
                                <GitFork className="h-4 w-4" />
                                {t('card.fork')}
                            </Button>
                        ) : (
                            <>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={loading || archiveLoading}
                                    onClick={() => onEdit(template)}
                                    className="shrink-0"
                                >
                                    <PencilLine className="h-4 w-4" />
                                    {t('card.edit')}
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    loading={archiveLoading}
                                    disabled={loading || archiveLoading}
                                    onClick={() => onArchive(template)}
                                    className="shrink-0 text-destructive hover:text-destructive"
                                >
                                    <Trash2 className="h-4 w-4" />
                                    {t('card.archive')}
                                </Button>
                            </>
                        )}
                        <Button
                            variant={isDefault ? 'secondary' : 'primary'}
                            size="sm"
                            loading={loading}
                            disabled={isDefault || loading}
                            onClick={() => onSetDefault(template.id)}
                            className="shrink-0"
                        >
                            {isDefault ? t('card.defaultSelected') : t('card.makeDefault')}
                        </Button>
                    </div>
                </div>
            </div>
        </article>
    );
}

export function TemplatesCatalog({
    kind,
    templates: initialTemplates,
    defaultTemplateId,
    forkTargets,
}: TemplatesCatalogProps) {
    const t = useTranslations('dashboard.templates');
    const [templates, setTemplates] = useState(initialTemplates);
    const [currentDefaultTemplateId, setCurrentDefaultTemplateId] = useState(defaultTemplateId);
    const [searchQuery, setSearchQuery] = useState('');
    const [filterMode, setFilterMode] = useState<FilterMode>('all');
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingTemplate, setEditingTemplate] = useState<TemplateCatalogItem | null>(null);
    const [forkDialogTemplate, setForkDialogTemplate] = useState<TemplateCatalogItem | null>(null);
    const [archiveDialogTemplate, setArchiveDialogTemplate] = useState<TemplateCatalogItem | null>(
        null,
    );
    const [formState, setFormState] = useState<AddTemplateFormState>(EMPTY_FORM);
    const [forkTargetOwner, setForkTargetOwner] = useState(forkTargets[0]?.login || '');
    const [isSavingDefault, startSavingDefault] = useTransition();
    const [isAddingTemplate, startAddingTemplate] = useTransition();
    const [isForkingTemplate, startForkingTemplate] = useTransition();
    const [isArchivingTemplate, startArchivingTemplate] = useTransition();
    const [isRefreshingTemplates, startRefreshingTemplates] = useTransition();

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
        setEditingTemplate(null);
        setDialogOpen(false);
    };

    const resetForkDialog = () => {
        setForkDialogTemplate(null);
        setForkTargetOwner(forkTargets[0]?.login || '');
    };

    const resetArchiveDialog = () => {
        setArchiveDialogTemplate(null);
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

    const handleSaveTemplate = () => {
        const repositoryUrl = formState.repositoryUrl.trim();
        if (!editingTemplate && !repositoryUrl) {
            toast.error(t('messages.repositoryUrlRequired'));
            return;
        }

        if (!editingTemplate && !parseGitHubRepositoryUrl(repositoryUrl)) {
            toast.error(t('messages.repositoryUrlInvalid'));
            return;
        }

        startAddingTemplate(() => {
            void (async () => {
                const result = editingTemplate
                    ? await updateCustomTemplate(editingTemplate.id, {
                          kind,
                          name: formState.name.trim() || undefined,
                          description: formState.description.trim() || undefined,
                          framework: formState.framework.trim() || undefined,
                          previewImageUrl: formState.previewImageUrl.trim() || null,
                          branch: formState.branch.trim() || undefined,
                      })
                    : await addCustomTemplate({
                          kind,
                          repositoryUrl,
                          name: formState.name.trim() || undefined,
                          description: formState.description.trim() || undefined,
                          framework: formState.framework.trim() || undefined,
                          previewImageUrl: formState.previewImageUrl.trim() || undefined,
                          branch: formState.branch.trim() || undefined,
                      });

                if (!result.success || !result.template) {
                    toast.error(
                        result.error ||
                            (editingTemplate
                                ? t('messages.updateFailed')
                                : t('messages.addFailed')),
                    );
                    return;
                }

                setTemplates((current) => {
                    const next = current
                        .filter((template) => template.id !== result.template?.id)
                        .concat(result.template);
                    return next.sort(compareTemplates);
                });
                toast.success(
                    editingTemplate ? t('messages.updateSuccess') : t('messages.addSuccess'),
                );
                resetDialog();
            })();
        });
    };

    const handleForkTemplate = () => {
        if (!forkDialogTemplate) {
            return;
        }

        if (!forkTargetOwner) {
            toast.error(t('messages.forkTargetRequired'));
            return;
        }

        startForkingTemplate(() => {
            void (async () => {
                const result = await forkTemplate({
                    kind,
                    templateId: forkDialogTemplate.id,
                    targetOwner: forkTargetOwner,
                });

                if (!result.success || !result.template || !result.defaultTemplateId) {
                    toast.error(result.error || t('messages.forkFailed'));
                    return;
                }

                setCurrentDefaultTemplateId(result.defaultTemplateId);
                setTemplates((current) => {
                    const withoutPrevious = current.filter(
                        (template) => template.id !== result.template?.id,
                    );
                    const next = [...withoutPrevious, result.template];

                    return next.sort(compareTemplates).map((template) => ({
                        ...template,
                        isDefault: template.id === result.defaultTemplateId,
                    }));
                });

                toast.success(
                    result.created
                        ? t('messages.forkSuccess', {
                              repository: result.repository?.fullName || forkDialogTemplate.name,
                          })
                        : t('messages.forkExisting', {
                              repository: result.repository?.fullName || forkDialogTemplate.name,
                          }),
                );
                resetForkDialog();
            })();
        });
    };

    const handleArchiveTemplate = () => {
        if (!archiveDialogTemplate) {
            return;
        }

        startArchivingTemplate(() => {
            void (async () => {
                const result = await archiveCustomTemplate(archiveDialogTemplate.id, { kind });

                if (!result.success || !result.templateId) {
                    toast.error(result.error || t('messages.archiveFailed'));
                    return;
                }

                const refreshed = await refreshTemplates({ kind });
                if (refreshed.success) {
                    setTemplates(refreshed.templates.sort(compareTemplates));
                    setCurrentDefaultTemplateId(refreshed.defaultTemplateId);
                } else {
                    setTemplates((current) =>
                        current.filter((template) => template.id !== result.templateId),
                    );
                }
                toast.success(t('messages.archiveSuccess'));
                resetArchiveDialog();
            })();
        });
    };

    const handleRefreshTemplates = () => {
        startRefreshingTemplates(() => {
            void (async () => {
                const result = await refreshTemplates({ kind });

                if (!result.success) {
                    toast.error(result.error || t('messages.refreshFailed'));
                    return;
                }

                setTemplates(result.templates.sort(compareTemplates));
                setCurrentDefaultTemplateId(result.defaultTemplateId);
                toast.success(t('messages.refreshSuccess'));
            })();
        });
    };

    return (
        <div className="space-y-6">
            <section className="overflow-hidden rounded-xl border border-card-border bg-card dark:border-border-secondary-dark dark:bg-card-primary-dark/30">
                <div className="grid gap-5 px-5 py-5 lg:grid-cols-[1.35fr_0.95fr] lg:px-6 lg:py-6">
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
                            <Button
                                size="sm"
                                variant="ghost"
                                className="rounded-xl"
                                onClick={handleRefreshTemplates}
                                loading={isRefreshingTemplates}
                            >
                                <RefreshCw className="h-4 w-4" />
                                {t('actions.refreshTemplates')}
                            </Button>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('hero.catalogHint')}
                            </p>
                        </div>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3">
                        <div className="rounded-lg border border-card-border bg-surface px-3 py-3 dark:border-border-dark dark:bg-white/4">
                            <p className="text-[11px] uppercase tracking-[0.14em] text-text-muted dark:text-text-muted-dark">
                                {t('stats.defaultLabel')}
                            </p>
                            <p className="mt-2 text-sm font-semibold text-text dark:text-text-dark line-clamp-1">
                                {activeDefaultTemplate?.name || t('stats.none')}
                            </p>
                            <p className="mt-1 text-xs leading-5 text-text-secondary dark:text-text-secondary-dark">
                                {t('stats.defaultHint')}
                            </p>
                        </div>
                        <div className="rounded-lg border border-card-border bg-surface px-3 py-3 dark:border-border-dark dark:bg-white/4">
                            <p className="text-[11px] uppercase tracking-[0.14em] text-text-muted dark:text-text-muted-dark">
                                {t('stats.builtInLabel')}
                            </p>
                            <p className="mt-2 text-lg font-semibold text-text dark:text-text-dark">
                                {builtInCount}
                            </p>
                            <p className="mt-1 text-xs leading-5 text-text-secondary dark:text-text-secondary-dark">
                                {t('stats.builtInHint')}
                            </p>
                        </div>
                        <div className="rounded-lg border border-card-border bg-surface px-3 py-3 dark:border-border-dark dark:bg-white/4">
                            <p className="text-[11px] uppercase tracking-[0.14em] text-text-muted dark:text-text-muted-dark">
                                {t('stats.customLabel')}
                            </p>
                            <p className="mt-2 text-lg font-semibold text-text dark:text-text-dark">
                                {customCount}
                            </p>
                            <p className="mt-1 text-xs leading-5 text-text-secondary dark:text-text-secondary-dark">
                                {t('stats.customHint')}
                            </p>
                        </div>
                    </div>
                </div>
            </section>

            <section className="flex flex-col gap-4 rounded-xl border border-card-border bg-card px-5 py-5 dark:border-border-secondary-dark dark:bg-card-primary-dark/30 lg:flex-row lg:items-center lg:justify-between">
                <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted dark:text-text-muted-dark" />
                    <Input
                        value={searchQuery}
                        onChange={(event) => setSearchQuery(event.target.value)}
                        placeholder={t('filters.searchPlaceholder')}
                        className="rounded-xl pl-11"
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
                <section className="rounded-xl border border-dashed border-card-border bg-card px-6 py-16 text-center dark:border-border-secondary-dark dark:bg-card-primary-dark/30">
                    <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-secondary dark:bg-white/6">
                        <LayoutTemplate className="h-6 w-6 text-text-muted dark:text-text-muted-dark" />
                    </div>
                    <h2 className="mt-5 text-lg font-semibold text-text dark:text-text-dark">
                        {t('empty.title')}
                    </h2>
                    <p className="mx-auto mt-2 max-w-md text-sm leading-7 text-text-secondary dark:text-text-secondary-dark">
                        {searchQuery ? t('empty.search') : t('empty.default')}
                    </p>
                    {(searchQuery || filterMode !== 'all') && (
                        <Button
                            variant="ghost"
                            className="mt-5"
                            onClick={() => {
                                setSearchQuery('');
                                setFilterMode('all');
                            }}
                        >
                            {t('empty.resetFilters')}
                        </Button>
                    )}
                </section>
            ) : (
                <section className="grid grid-cols-1 gap-4 @3xl/main:grid-cols-2 @5xl/main:grid-cols-3">
                    {filteredTemplates.map((template) => (
                        <TemplateCard
                            key={template.id}
                            template={template}
                            isDefault={template.id === currentDefaultTemplateId}
                            onSetDefault={handleSetDefault}
                            onFork={(selectedTemplate) => {
                                setForkDialogTemplate(selectedTemplate);
                                setForkTargetOwner(forkTargets[0]?.login || '');
                            }}
                            onEdit={(selectedTemplate) => {
                                setEditingTemplate(selectedTemplate);
                                setFormState({
                                    repositoryUrl: selectedTemplate.repositoryUrl || '',
                                    name: selectedTemplate.name,
                                    description: selectedTemplate.description || '',
                                    framework: selectedTemplate.framework || '',
                                    previewImageUrl: selectedTemplate.previewImageUrl || '',
                                    branch: selectedTemplate.branch || '',
                                });
                                setDialogOpen(true);
                            }}
                            onArchive={(selectedTemplate) =>
                                setArchiveDialogTemplate(selectedTemplate)
                            }
                            loading={isSavingDefault}
                            forkLoading={
                                isForkingTemplate && forkDialogTemplate?.id === template.id
                            }
                            archiveLoading={
                                isArchivingTemplate && archiveDialogTemplate?.id === template.id
                            }
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
                                    {editingTemplate ? t('dialog.editTitle') : t('dialog.title')}
                                </DialogTitle>
                                <DialogDescription className="mt-2 max-w-xl leading-6">
                                    {editingTemplate
                                        ? t('dialog.editDescription')
                                        : t('dialog.description')}
                                </DialogDescription>
                            </DialogHeader>

                            <div className="space-y-4">
                                {!editingTemplate ? (
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
                                ) : (
                                    <Input
                                        label={t('dialog.repositoryUrlLabel')}
                                        value={formState.repositoryUrl}
                                        disabled
                                        helperText={t('dialog.repositoryUrlLockedHelp')}
                                    />
                                )}

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

                                <Input
                                    label={t('dialog.previewImageLabel')}
                                    placeholder={t('dialog.previewImagePlaceholder')}
                                    value={formState.previewImageUrl}
                                    onChange={(event) =>
                                        setFormState((current) => ({
                                            ...current,
                                            previewImageUrl: event.target.value,
                                        }))
                                    }
                                    helperText={t('dialog.previewImageHelp')}
                                />

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
                                    onClick={handleSaveTemplate}
                                    loading={isAddingTemplate}
                                    className="rounded-xl"
                                >
                                    {editingTemplate ? t('dialog.saveChanges') : t('dialog.submit')}
                                </Button>
                            </DialogFooter>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog open={!!forkDialogTemplate} onOpenChange={(open) => !open && resetForkDialog()}>
                <DialogContent className="max-w-xl rounded-[2rem] p-0">
                    <div className="relative overflow-hidden rounded-[2rem] border border-border bg-white dark:border-border-dark dark:bg-surface-dark">
                        <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-br from-slate-900/14 via-slate-500/8 to-transparent dark:from-white/10 dark:via-white/5" />
                        <div className="relative p-6">
                            <DialogClose onClose={resetForkDialog} />
                            <DialogHeader className="mb-6 pr-8">
                                <DialogTitle className="text-xl font-semibold text-text dark:text-text-dark">
                                    {t('forkDialog.title')}
                                </DialogTitle>
                                <DialogDescription className="mt-2 max-w-xl leading-6">
                                    {t('forkDialog.description')}
                                </DialogDescription>
                            </DialogHeader>

                            <div className="space-y-5">
                                <div className="rounded-2xl border border-border bg-surface px-4 py-4 dark:border-border-dark dark:bg-white/4">
                                    <p className="text-xs uppercase tracking-[0.18em] text-text-muted dark:text-text-muted-dark">
                                        {t('forkDialog.sourceLabel')}
                                    </p>
                                    <p className="mt-2 text-base font-semibold text-text dark:text-text-dark">
                                        {forkDialogTemplate?.name}
                                    </p>
                                    <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                                        {forkDialogTemplate
                                            ? `${forkDialogTemplate.repositoryOwner}/${forkDialogTemplate.repositoryName}`
                                            : ''}
                                    </p>
                                </div>

                                <div className="space-y-2">
                                    <label className="block text-sm font-medium text-text dark:text-text-dark">
                                        {t('forkDialog.targetLabel')}
                                    </label>
                                    <Select
                                        value={forkTargetOwner}
                                        onValueChange={setForkTargetOwner}
                                        placeholder={t('forkDialog.targetPlaceholder')}
                                        disabled={forkTargets.length === 0 || isForkingTemplate}
                                    >
                                        {forkTargets.map((target) => (
                                            <option key={target.login} value={target.login}>
                                                {target.kind === 'personal'
                                                    ? t('forkDialog.personalTarget', {
                                                          login: target.login,
                                                      })
                                                    : t('forkDialog.organizationTarget', {
                                                          login: target.login,
                                                      })}
                                            </option>
                                        ))}
                                    </Select>
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {forkTargets.length > 0
                                            ? t('forkDialog.targetHelp', {
                                                  target: forkTargetOwner || t('forkDialog.none'),
                                              })
                                            : t('forkDialog.noTargets')}
                                    </p>
                                </div>

                                <div className="rounded-2xl border border-dashed border-border px-4 py-4 dark:border-border-dark">
                                    <p className="text-xs uppercase tracking-[0.18em] text-text-muted dark:text-text-muted-dark">
                                        {t('forkDialog.resultLabel')}
                                    </p>
                                    <p className="mt-2 text-sm text-text-secondary dark:text-text-secondary-dark">
                                        {forkDialogTemplate
                                            ? `${forkTargetOwner || '...'}/${forkDialogTemplate.repositoryName}`
                                            : ''}
                                    </p>
                                </div>
                            </div>

                            <DialogFooter className="mt-8">
                                <Button
                                    variant="ghost"
                                    onClick={resetForkDialog}
                                    disabled={isForkingTemplate}
                                >
                                    {t('forkDialog.cancel')}
                                </Button>
                                <Button
                                    onClick={handleForkTemplate}
                                    loading={isForkingTemplate}
                                    disabled={forkTargets.length === 0}
                                    className="rounded-xl"
                                >
                                    {t('forkDialog.submit')}
                                </Button>
                            </DialogFooter>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog
                open={!!archiveDialogTemplate}
                onOpenChange={(open) => !open && resetArchiveDialog()}
            >
                <DialogContent className="max-w-lg rounded-[2rem] p-0">
                    <div className="relative overflow-hidden rounded-[2rem] border border-border bg-white dark:border-border-dark dark:bg-surface-dark">
                        <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-br from-red-500/14 via-orange-500/8 to-transparent" />
                        <div className="relative p-6">
                            <DialogClose onClose={resetArchiveDialog} />
                            <DialogHeader className="mb-6 pr-8">
                                <DialogTitle className="text-xl font-semibold text-text dark:text-text-dark">
                                    {t('archiveDialog.title')}
                                </DialogTitle>
                                <DialogDescription className="mt-2 max-w-xl leading-6">
                                    {t('archiveDialog.description')}
                                </DialogDescription>
                            </DialogHeader>

                            <div className="rounded-2xl border border-border bg-surface px-4 py-4 dark:border-border-dark dark:bg-white/4">
                                <p className="text-xs uppercase tracking-[0.18em] text-text-muted dark:text-text-muted-dark">
                                    {t('archiveDialog.templateLabel')}
                                </p>
                                <p className="mt-2 text-base font-semibold text-text dark:text-text-dark">
                                    {archiveDialogTemplate?.name}
                                </p>
                                <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                                    {archiveDialogTemplate
                                        ? `${archiveDialogTemplate.repositoryOwner}/${archiveDialogTemplate.repositoryName}`
                                        : ''}
                                </p>
                            </div>

                            <DialogFooter className="mt-8">
                                <Button
                                    variant="ghost"
                                    onClick={resetArchiveDialog}
                                    disabled={isArchivingTemplate}
                                >
                                    {t('archiveDialog.cancel')}
                                </Button>
                                <Button
                                    variant="danger"
                                    onClick={handleArchiveTemplate}
                                    loading={isArchivingTemplate}
                                    className="rounded-xl"
                                >
                                    {t('archiveDialog.submit')}
                                </Button>
                            </DialogFooter>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
