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
    Github,
    ExternalLink,
    GitFork,
    PencilLine,
    RefreshCw,
    Trash2,
    Star,
} from 'lucide-react';
import type { TemplateCatalogItem, TemplateKind } from '@/lib/api/templates';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/common/EmptyState';
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

const FRAMEWORK_OPTIONS = ['Next.js', 'Astro'] as const;

function compareTemplates(a: TemplateCatalogItem, b: TemplateCatalogItem) {
    if (a.sourceType !== b.sourceType) {
        return a.sourceType === 'custom' ? -1 : 1;
    }

    return a.name.localeCompare(b.name);
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
    const [previewFailed, setPreviewFailed] = useState(false);
    const previewUrl = previewFailed ? null : getTemplatePreviewUrl(template);

    return (
        <article
            className={cn(
                'group relative flex flex-col rounded-lg shadow-xs overflow-hidden',
                'bg-card dark:bg-card-primary-dark/70',
                'border border-card-border dark:border-white/9',
                'hover:border-primary-500/50 dark:hover:border-white/20',
                'transition-colors',
                isDefault && 'border-primary/40 dark:border-primary/40',
            )}
        >
            <div className="relative aspect-[2.4/1] bg-surface-secondary dark:bg-white/5 overflow-hidden">
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
                    <div className="flex h-full w-full items-center justify-center">
                        <LayoutTemplate
                            strokeWidth={1}
                            className="h-8 w-8 text-text-muted dark:text-text-muted-dark"
                        />
                    </div>
                )}
                {isDefault && (
                    <span className="absolute top-2 right-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-normal bg-primary/90 text-primary-foreground backdrop-blur-sm">
                        <Star className="w-3 h-3 fill-current" />
                        {t('card.default')}
                    </span>
                )}
            </div>

            <div className="flex flex-col flex-1 p-4">
                <div className="flex items-start justify-between gap-2 mb-1.5">
                    <h3 className="text-sm font-semibold text-text dark:text-text-dark line-clamp-1">
                        {template.name}
                    </h3>
                    {template.framework ? (
                        <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-700 dark:bg-white/8 dark:text-gray-200">
                            {template.framework}
                        </span>
                    ) : null}
                </div>

                {template.repositoryOwner && template.repositoryName ? (
                    <div className="inline-flex items-center gap-1 mb-2 bg-primary-400/10 dark:bg-white/10 self-start max-w-full px-1.5 py-0.5 rounded-full">
                        <Github className="w-3 h-3 shrink-0 text-gray-600 dark:text-gray-200" />
                        <span className="text-[11px] text-gray-600 dark:text-gray-200 truncate">
                            <span className="text-gray-400 dark:text-gray-400">
                                {template.repositoryOwner}/
                            </span>
                            {template.repositoryName}
                        </span>
                    </div>
                ) : null}

                <p className="text-xs leading-4.5 line-clamp-2 mb-3">
                    {template.description ? (
                        <span className="text-text-secondary dark:text-text-secondary-dark">
                            {template.description}
                        </span>
                    ) : (
                        <span className="text-text-muted dark:text-text-muted-dark italic">
                            {t('card.noDescription')}
                        </span>
                    )}
                </p>

                <div className="flex items-center justify-between gap-2 pt-3 border-t border-border dark:border-border-dark mt-auto">
                    {template.repositoryUrl ? (
                        <a
                            href={template.repositoryUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text dark:text-text-muted-dark dark:hover:text-text-dark transition-colors"
                            title={t('card.openRepository')}
                        >
                            <ExternalLink className="h-3.5 w-3.5" />
                            <span className="truncate">{template.branch}</span>
                        </a>
                    ) : (
                        <span className="text-[11px] text-text-muted dark:text-text-muted-dark">
                            {template.branch}
                        </span>
                    )}

                    <div className="flex items-center gap-1 shrink-0">
                        {template.sourceType === 'built_in' ? (
                            <Button
                                variant="ghost"
                                size="sm"
                                loading={forkLoading}
                                disabled={loading || forkLoading}
                                onClick={() => onFork(template)}
                                className="whitespace-nowrap"
                            >
                                <GitFork className="h-3.5 w-3.5" />
                                {t('card.fork')}
                            </Button>
                        ) : (
                            <>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={loading || archiveLoading}
                                    onClick={() => onEdit(template)}
                                    title={t('card.edit')}
                                >
                                    <PencilLine className="h-3.5 w-3.5" />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    loading={archiveLoading}
                                    disabled={loading || archiveLoading}
                                    onClick={() => onArchive(template)}
                                    title={t('card.archive')}
                                    className="text-destructive hover:text-destructive"
                                >
                                    <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                            </>
                        )}
                        <Button
                            variant={isDefault ? 'secondary' : 'primary'}
                            size="sm"
                            loading={loading}
                            disabled={isDefault || loading}
                            onClick={() => onSetDefault(template.id)}
                            className="whitespace-nowrap"
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
        <div className="w-full">
            <div className="mb-8 flex flex-col gap-4 @lg/main:flex-row @lg/main:items-start @lg/main:justify-between">
                <div>
                    <h1 className="text-3xl font-bold text-text dark:text-text-dark">
                        {t('title')}
                    </h1>
                    <p className="mt-2 text-text-secondary dark:text-text-secondary-dark">
                        {t('subtitle')}
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-primary/10 text-primary border border-primary/20 max-w-[220px]">
                        <Star className="w-3 h-3 fill-current shrink-0" />
                        <span className="truncate">
                            {activeDefaultTemplate?.name || t('stats.none')}
                        </span>
                    </span>
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs bg-surface dark:bg-white/5 text-text-secondary dark:text-text-secondary-dark border border-border dark:border-border-dark">
                        {t('stats.builtInLabel')}
                        <span className="font-semibold text-text dark:text-text-dark">
                            {builtInCount}
                        </span>
                    </span>
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs bg-surface dark:bg-white/5 text-text-secondary dark:text-text-secondary-dark border border-border dark:border-border-dark">
                        {t('stats.customLabel')}
                        <span className="font-semibold text-text dark:text-text-dark">
                            {customCount}
                        </span>
                    </span>
                </div>
            </div>

            <div className="flex flex-col @sm/main:flex-row gap-4 mb-6">
                <div className="flex-1">
                    <div className="relative">
                        <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-text-muted dark:text-text-muted-dark" />
                        <Input
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            placeholder={t('filters.searchPlaceholder')}
                            className="pl-10"
                        />
                    </div>
                </div>

                <div className="flex flex-wrap gap-2">
                    {(['all', 'built_in', 'custom'] as const).map((mode) => (
                        <Button
                            key={mode}
                            variant={filterMode === mode ? 'primary' : 'ghost'}
                            size="sm"
                            onClick={() => setFilterMode(mode)}
                        >
                            {mode === 'all'
                                ? t('filters.all')
                                : mode === 'built_in'
                                  ? t('filters.builtIn')
                                  : t('filters.custom')}
                        </Button>
                    ))}
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleRefreshTemplates}
                        loading={isRefreshingTemplates}
                        title={t('actions.refreshTemplates')}
                    >
                        <RefreshCw className="h-4 w-4" />
                    </Button>
                    <Button size="sm" onClick={() => setDialogOpen(true)}>
                        <Plus className="h-4 w-4" />
                        {t('actions.addTemplate')}
                    </Button>
                </div>
            </div>

            {filteredTemplates.length === 0 ? (
                <EmptyState
                    icon={
                        <div className="p-4 bg-surface dark:bg-surface-dark rounded-full mb-4">
                            <LayoutTemplate
                                strokeWidth={1.5}
                                className="w-12 h-12 text-text-muted dark:text-text-muted-dark"
                            />
                        </div>
                    }
                    title={t('empty.title')}
                    description={searchQuery ? t('empty.search') : t('empty.default')}
                    action={
                        searchQuery || filterMode !== 'all'
                            ? {
                                  label: t('empty.resetFilters'),
                                  onClick: () => {
                                      setSearchQuery('');
                                      setFilterMode('all');
                                  },
                              }
                            : undefined
                    }
                />
            ) : (
                <section className="grid grid-cols-1 gap-4 @lg/main:grid-cols-2 @4xl/main:grid-cols-3">
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
                <DialogContent className="max-w-2xl">
                    <DialogClose onClose={resetDialog} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {editingTemplate ? t('dialog.editTitle') : t('dialog.title')}
                        </DialogTitle>
                        <DialogDescription>
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
                            <div className="space-y-2">
                                <label className="block text-sm font-medium text-text dark:text-text-dark">
                                    {t('dialog.frameworkLabel')}
                                </label>
                                <Select
                                    value={formState.framework}
                                    onValueChange={(value) =>
                                        setFormState((current) => ({
                                            ...current,
                                            framework: value,
                                        }))
                                    }
                                    placeholder={t('dialog.frameworkSelectPlaceholder')}
                                    className="w-full"
                                >
                                    <option value="">{t('dialog.frameworkUnspecified')}</option>
                                    {FRAMEWORK_OPTIONS.map((framework) => (
                                        <option key={framework} value={framework}>
                                            {framework}
                                        </option>
                                    ))}
                                </Select>
                            </div>
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

                    <DialogFooter>
                        <Button variant="ghost" onClick={resetDialog} disabled={isAddingTemplate}>
                            {t('dialog.cancel')}
                        </Button>
                        <Button onClick={handleSaveTemplate} loading={isAddingTemplate}>
                            {editingTemplate ? t('dialog.saveChanges') : t('dialog.submit')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={!!forkDialogTemplate} onOpenChange={(open) => !open && resetForkDialog()}>
                <DialogContent className="max-w-xl">
                    <DialogClose onClose={resetForkDialog} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('forkDialog.title')}
                        </DialogTitle>
                        <DialogDescription>{t('forkDialog.description')}</DialogDescription>
                    </DialogHeader>

                    <div className="space-y-4">
                        <div className="rounded-lg border border-border bg-surface px-4 py-3 dark:border-border-dark dark:bg-white/4">
                            <p className="text-[11px] uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                                {t('forkDialog.sourceLabel')}
                            </p>
                            <p className="mt-1 text-sm font-semibold text-text dark:text-text-dark">
                                {forkDialogTemplate?.name}
                            </p>
                            <p className="mt-0.5 text-xs text-text-secondary dark:text-text-secondary-dark">
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

                        <div className="rounded-lg border border-dashed border-border px-4 py-3 dark:border-border-dark">
                            <p className="text-[11px] uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                                {t('forkDialog.resultLabel')}
                            </p>
                            <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                                {forkDialogTemplate
                                    ? `${forkTargetOwner || '...'}/${forkDialogTemplate.repositoryName}`
                                    : ''}
                            </p>
                        </div>
                    </div>

                    <DialogFooter>
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
                        >
                            {t('forkDialog.submit')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog
                open={!!archiveDialogTemplate}
                onOpenChange={(open) => !open && resetArchiveDialog()}
            >
                <DialogContent>
                    <DialogClose onClose={resetArchiveDialog} />
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('archiveDialog.title')}
                        </DialogTitle>
                        <DialogDescription>{t('archiveDialog.description')}</DialogDescription>
                    </DialogHeader>

                    <div className="rounded-lg border border-border bg-surface px-4 py-3 dark:border-border-dark dark:bg-white/4">
                        <p className="text-[11px] uppercase tracking-wide text-text-muted dark:text-text-muted-dark">
                            {t('archiveDialog.templateLabel')}
                        </p>
                        <p className="mt-1 text-sm font-semibold text-text dark:text-text-dark">
                            {archiveDialogTemplate?.name}
                        </p>
                        <p className="mt-0.5 text-xs text-text-secondary dark:text-text-secondary-dark">
                            {archiveDialogTemplate
                                ? `${archiveDialogTemplate.repositoryOwner}/${archiveDialogTemplate.repositoryName}`
                                : ''}
                        </p>
                    </div>

                    <DialogFooter>
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
                        >
                            {t('archiveDialog.submit')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
