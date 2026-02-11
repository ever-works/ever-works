'use client';

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { OrganizationSelector } from '../OrganizationSelector';
import { ProviderSelector } from '../detail/generator/ProviderSelector';
import { SlugConflictWarning } from './SlugConflictWarning';
import { getGlobalFormSchema } from '@/app/actions/dashboard/generator-form';
import { resolveEffectiveDefault } from '@ever-works/plugin';
import type { GeneratorFormSchema } from '@/lib/api/types-only';
import type { ProviderOption } from '@/lib/api/types-only';
import { Upload, CheckCircle2, FileText, Database, ArrowLeft } from 'lucide-react';

type DetectedType = 'data_repo' | 'awesome_readme' | 'link_existing' | null;

interface AnalysisResult {
    sourceUrl: string;
    owner: string;
    repo: string;
    detectedType: DetectedType;
    isPublic: boolean;
    requiresAuth: boolean;
    structure?: {
        hasConfig: boolean;
        hasDataFolder: boolean;
        hasReadme: boolean;
        isMultiFile?: boolean;
        itemCount?: number;
        categoryCount?: number;
    };
    slugConflict?: {
        hasConflict: boolean;
        conflictingRepos: string[];
        suggestedSlug: string;
    };
}

interface ImportConfigureStepProps {
    analysisResult: AnalysisResult | null;
    sourceUrl: string;
    directoryName: string;
    onDirectoryNameChange: (name: string) => void;
    manualSourceType: 'data_repo' | 'awesome_readme' | null;
    onManualSourceTypeChange: (type: 'data_repo' | 'awesome_readme' | null) => void;
    sync: boolean;
    onSyncChange: (sync: boolean) => void;
    gitProvider?: string;
    isPending: boolean;
    onBack: () => void;
    onImport: (providers?: Record<string, string>) => void;
}

export function ImportConfigureStep({
    analysisResult,
    sourceUrl,
    directoryName,
    onDirectoryNameChange,
    manualSourceType,
    onManualSourceTypeChange,
    sync,
    onSyncChange,
    gitProvider,
    isPending,
    onBack,
    onImport,
}: ImportConfigureStepProps) {
    const t = useTranslations('dashboard.directoryCreation.import');
    const [owner, setOwner] = useState('');

    // AI provider selection
    const [formSchema, setFormSchema] = useState<GeneratorFormSchema | null>(null);
    const [selectedAiProvider, setSelectedAiProvider] = useState<string | null>(null);

    const effectiveSourceType = analysisResult?.detectedType || manualSourceType;

    useEffect(() => {
        if (effectiveSourceType !== 'awesome_readme') return;
        if (formSchema) return;

        async function loadSchema() {
            try {
                const result = await getGlobalFormSchema();
                if (result.success && result.data) {
                    setFormSchema(result.data);
                }
            } catch (error) {
                console.error('Failed to load form schema:', error);
            }
        }
        loadSchema();
    }, [effectiveSourceType, formSchema]);

    const aiProviders: ProviderOption[] = formSchema?.providers.ai ?? [];

    const handleImport = () => {
        let providers: Record<string, string> | undefined;
        if (effectiveSourceType === 'awesome_readme') {
            if (selectedAiProvider) {
                const selected = aiProviders.find((p) => p.id === selectedAiProvider);
                if (selected && !selected.configured) {
                    toast.error(t('errors.providerNotConfigured', { provider: selected.name }));
                    return;
                }

                providers = { ai: selectedAiProvider };
            } else if (formSchema) {
                const defaultProvider = resolveEffectiveDefault(aiProviders);
                if (defaultProvider && !defaultProvider.configured) {
                    toast.error(
                        t('errors.providerNotConfigured', { provider: defaultProvider.name }),
                    );
                    return;
                }

                if (defaultProvider) {
                    providers = { ai: defaultProvider.id };
                }
            }
        }

        onImport(providers);
    };

    return (
        <div className="space-y-6">
            {/* Analysis Result - Auto-detected */}
            {analysisResult && analysisResult.detectedType && (
                <div
                    className={cn(
                        'p-4 rounded-lg',
                        analysisResult.detectedType === 'data_repo'
                            ? 'bg-primary/5 border border-primary/20'
                            : 'bg-warning/5 border border-warning/20',
                    )}
                >
                    <div className="flex items-start gap-3">
                        <CheckCircle2
                            className={cn(
                                'w-6 h-6 mt-0.5 shrink-0',
                                analysisResult.detectedType === 'data_repo'
                                    ? 'text-primary'
                                    : 'text-warning',
                            )}
                        />
                        <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                                <h4 className="font-medium text-text dark:text-text-dark">
                                    {analysisResult.detectedType === 'data_repo'
                                        ? t('detectedType.dataRepo')
                                        : t('detectedType.awesomeReadme')}
                                </h4>
                                <span
                                    className={cn(
                                        'px-2 py-0.5 rounded-full text-xs font-medium',
                                        analysisResult.detectedType === 'data_repo'
                                            ? 'bg-primary/10 text-primary'
                                            : 'bg-warning/10 text-warning',
                                    )}
                                >
                                    {analysisResult.detectedType === 'data_repo'
                                        ? t('badges.dataRepo')
                                        : t('badges.awesomeReadme')}
                                </span>
                            </div>
                            <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                {analysisResult.owner}/{analysisResult.repo}
                            </p>
                            {analysisResult.structure && (
                                <div className="mt-2 flex gap-4 text-xs text-text-muted dark:text-text-muted-dark">
                                    {analysisResult.structure.itemCount !== undefined && (
                                        <span>
                                            ~{analysisResult.structure.itemCount}{' '}
                                            {t('preview.items')}
                                        </span>
                                    )}
                                    {analysisResult.structure.categoryCount !== undefined && (
                                        <span>
                                            {analysisResult.structure.categoryCount}{' '}
                                            {t('preview.categories')}
                                        </span>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Manual Format Selection - When auto-detection failed */}
            {analysisResult && !analysisResult.detectedType && (
                <div className="space-y-4">
                    <div className="p-4 rounded-lg bg-info/5 border border-info/20">
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('detectionFailed')}
                        </p>
                        <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1">
                            {analysisResult.owner}/{analysisResult.repo}
                        </p>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <button
                            type="button"
                            onClick={() => onManualSourceTypeChange('awesome_readme')}
                            className={cn(
                                'p-4 rounded-lg border-2 text-left transition-all',
                                'bg-card dark:bg-card-dark',
                                manualSourceType === 'awesome_readme'
                                    ? 'border-warning shadow-md'
                                    : 'border-card-border dark:border-card-border-dark hover:border-warning/50',
                            )}
                        >
                            <FileText className="w-6 h-6 text-warning mb-2" />
                            <h4 className="font-medium text-text dark:text-text-dark">
                                {t('supportedFormats.awesomeReadme.title')}
                            </h4>
                            <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                {t('supportedFormats.awesomeReadme.description')}
                            </p>
                        </button>

                        <button
                            type="button"
                            onClick={() => onManualSourceTypeChange('data_repo')}
                            className={cn(
                                'p-4 rounded-lg border-2 text-left transition-all',
                                'bg-card dark:bg-card-dark',
                                manualSourceType === 'data_repo'
                                    ? 'border-primary shadow-md'
                                    : 'border-card-border dark:border-card-border-dark hover:border-primary/50',
                            )}
                        >
                            <Database className="w-6 h-6 text-primary mb-2" />
                            <h4 className="font-medium text-text dark:text-text-dark">
                                {t('supportedFormats.dataRepo.title')}
                            </h4>
                            <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                {t('supportedFormats.dataRepo.description')}
                            </p>
                        </button>
                    </div>
                </div>
            )}

            {/* Directory Name */}
            <Input
                label={`${t('nameLabel')} *`}
                type="text"
                value={directoryName}
                onChange={(e) => onDirectoryNameChange(e.target.value)}
                placeholder={t('namePlaceholder')}
                variant="form"
            />

            {/* Slug Conflict Warning */}
            {analysisResult?.slugConflict?.hasConflict && (
                <SlugConflictWarning
                    conflictingRepos={analysisResult.slugConflict.conflictingRepos}
                    suggestedSlug={analysisResult.slugConflict.suggestedSlug}
                    onAcceptSuggestion={(name) => onDirectoryNameChange(name)}
                />
            )}

            {/* Sync Toggle */}
            <div className="flex items-center justify-between p-4 rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark">
                <div>
                    <h3 className="font-medium text-text dark:text-text-dark">
                        {t('sync.title', { fallback: 'Keep synchronized' })}
                    </h3>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('sync.description', {
                            fallback: 'Automatically pull updates from the source repository.',
                        })}
                    </p>
                </div>
                <Switch checked={sync} onChange={onSyncChange} disabled={isPending} />
            </div>

            {/* AI Provider Selection - only for awesome_readme */}
            {effectiveSourceType === 'awesome_readme' && aiProviders.length > 0 && (
                <div className="p-4 rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark">
                    <ProviderSelector
                        label={t('aiProviderSettings')}
                        providers={aiProviders}
                        value={selectedAiProvider}
                        onChange={setSelectedAiProvider}
                    />
                </div>
            )}

            {/* Advanced Fields */}
            <div className="space-y-4 p-4 rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark">
                <OrganizationSelector
                    value={owner}
                    providerId={gitProvider!}
                    onChange={(value) => {
                        setOwner(value);
                    }}
                    disabled={isPending}
                />
            </div>

            {/* Source Attribution Note */}
            <div
                className={cn(
                    'p-4 rounded-lg',
                    'bg-surface dark:bg-surface-dark',
                    'border border-border dark:border-border-dark',
                )}
            >
                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                    <strong>{t('attribution.title')}</strong>{' '}
                    {t('attribution.text', { url: analysisResult?.sourceUrl || sourceUrl })}
                </p>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3">
                <Button
                    onClick={onBack}
                    disabled={isPending}
                    variant="secondary"
                    size="lg"
                    className="px-6"
                >
                    <ArrowLeft className="w-5 h-5" />
                    {t('backButton')}
                </Button>
                <Button
                    onClick={handleImport}
                    disabled={isPending || !directoryName.trim() || !effectiveSourceType}
                    loading={isPending}
                    variant="primary"
                    size="lg"
                    fullWidth
                >
                    {isPending ? (
                        t('importingButton')
                    ) : (
                        <>
                            <Upload className="w-5 h-5" />
                            {t('importButton')}
                        </>
                    )}
                </Button>
            </div>
        </div>
    );
}
