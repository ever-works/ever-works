'use client';

import { useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { OrganizationSelector } from '../OrganizationSelector';
import { ProviderSelectionSection } from '../shared/ProviderSelectionSection';
import { SlugConflictWarning } from './SlugConflictWarning';
import { getGlobalFormSchema } from '@/app/actions/dashboard/generator-form';
import { useProviderSelection } from '@/lib/hooks/use-provider-selection';
import type { GeneratorFormSchema } from '@/lib/api/types-only';
import type { ImportEnrichmentConfig } from '@/lib/api/directory';
import {
    Upload,
    CheckCircle2,
    FileText,
    Database,
    ArrowLeft,
    Sparkles,
    GitPullRequest,
    Tags,
} from 'lucide-react';

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
    owner: string;
    onOwnerChange: (value: string, isOrganization: boolean) => void;
    onBack: () => void;
    onImport: (
        providers?: Record<string, string>,
        enrichmentConfig?: ImportEnrichmentConfig,
    ) => void;
}

const EXPANSION_OPTIONS = [
    { value: 1.5, label: '1.5x' },
    { value: 2, label: '2x' },
    { value: 2.5, label: '2.5x (recommended)' },
    { value: 3, label: '3x' },
    { value: 5, label: '5x' },
];

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
    owner,
    onOwnerChange,
    onBack,
    onImport,
}: ImportConfigureStepProps) {
    const t = useTranslations('dashboard.directoryCreation.import');

    // Pipeline plugins allowed for import enrichment
    const ALLOWED_IMPORT_PIPELINES = ['agent-pipeline', 'claude-code'];

    // Provider/pipeline selection state
    const [formSchema, setFormSchema] = useState<GeneratorFormSchema | null>(null);
    const {
        providers: selectedProviders,
        handleProviderChange,
        buildSelectedProviders,
        getUnconfiguredProviders,
        syncResolvedPipeline,
    } = useProviderSelection();
    const fetchVersionRef = useRef(0);
    const lastFetchedPipelineRef = useRef<string | undefined>(undefined);

    // Enrichment config (for awesome_readme)
    const [expansionFactor, setExpansionFactor] = useState(2.5);
    const [parsePullRequests, setParsePullRequests] = useState(false);
    const [enrichDescriptions, setEnrichDescriptions] = useState(true);
    const [expandTaxonomy, setExpandTaxonomy] = useState(true);

    const effectiveSourceType = analysisResult?.detectedType || manualSourceType;
    const isAwesomeReadme = effectiveSourceType === 'awesome_readme';

    // Load form schema when pipeline changes (same pattern as DirectoryAICreator)
    useEffect(() => {
        if (!isAwesomeReadme) return;

        const pipelineId = selectedProviders.pipeline || undefined;
        if (pipelineId === lastFetchedPipelineRef.current && formSchema) return;

        const version = ++fetchVersionRef.current;

        async function loadSchema() {
            try {
                const result = await getGlobalFormSchema(pipelineId);
                if (version !== fetchVersionRef.current) return;
                if (result.success && result.data) {
                    lastFetchedPipelineRef.current = result.data.resolvedPipelineId || pipelineId;
                    // Filter pipelines to only allowed ones for import
                    const filtered = {
                        ...result.data,
                        providers: {
                            ...result.data.providers,
                            pipeline: result.data.providers.pipeline?.filter((p) =>
                                ALLOWED_IMPORT_PIPELINES.includes(p.id),
                            ),
                        },
                    };
                    setFormSchema(filtered);
                    syncResolvedPipeline(filtered);
                }
            } catch (error) {
                if (version !== fetchVersionRef.current) return;
                console.error('Failed to load form schema:', error);
            }
        }
        loadSchema();
    }, [isAwesomeReadme, selectedProviders.pipeline, syncResolvedPipeline]);

    const seedCount = analysisResult?.structure?.itemCount ?? 0;
    const targetCount = Math.ceil(seedCount * expansionFactor);
    const newItemsTarget = targetCount - seedCount;

    const handleImport = () => {
        if (isAwesomeReadme) {
            const unconfigured = getUnconfiguredProviders(formSchema);
            if (unconfigured.length > 0) {
                toast.error(
                    t('errors.providerNotConfigured', { provider: unconfigured.join(', ') }),
                );
                return;
            }

            const providers = buildSelectedProviders(formSchema);

            const enrichmentConfig: ImportEnrichmentConfig = {
                expansionFactor,
                maxImportProportion: 1 / expansionFactor,
                parsePullRequests,
                parseIssues: parsePullRequests,
                enrichDescriptions,
                expandTaxonomy,
            };

            onImport(providers, enrichmentConfig);
        } else {
            onImport();
        }
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
                            : 'bg-primary/5 border border-primary/20',
                    )}
                >
                    <div className="flex items-start gap-3">
                        <CheckCircle2 className="w-6 h-6 mt-0.5 shrink-0 text-primary" />
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
                                        'bg-primary/10 text-primary',
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
                                    ? 'border-primary shadow-md'
                                    : 'border-card-border dark:border-card-border-dark hover:border-primary/50',
                            )}
                        >
                            <FileText className="w-6 h-6 text-primary mb-2" />
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

            {/* Enrichment Config — for awesome_readme imports */}
            {isAwesomeReadme && (
                <>
                    {/* Research Mode Banner */}
                    <div className="p-4 rounded-lg bg-primary/5 border border-primary/20">
                        <div className="flex items-start gap-3">
                            <Sparkles className="w-6 h-6 mt-0.5 shrink-0 text-primary" />
                            <div className="flex-1">
                                <h4 className="font-medium text-text dark:text-text-dark">
                                    {t('research.title')}
                                </h4>
                                <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1">
                                    {t('research.description')}
                                </p>
                                {seedCount > 0 && (
                                    <div className="mt-2 flex gap-4 text-xs text-text-muted dark:text-text-muted-dark">
                                        <span>
                                            {t('research.seedDetected', { count: seedCount })}
                                        </span>
                                        <span>
                                            {analysisResult?.owner}/{analysisResult?.repo}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Expansion Factor */}
                    <div className="p-4 rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark space-y-3">
                        <div className="flex items-center gap-2">
                            <Sparkles className="w-4 h-4 text-primary" />
                            <h3 className="font-medium text-text dark:text-text-dark">
                                {t('research.expansionFactor')}
                            </h3>
                        </div>
                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                            {t('research.expansionDescription')}
                        </p>
                        <div className="flex flex-wrap gap-2">
                            {EXPANSION_OPTIONS.map((option) => (
                                <button
                                    key={option.value}
                                    type="button"
                                    onClick={() => setExpansionFactor(option.value)}
                                    className={cn(
                                        'px-3 py-1.5 rounded-md text-sm font-medium transition-all',
                                        expansionFactor === option.value
                                            ? 'bg-primary text-white'
                                            : 'bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark hover:bg-primary/10',
                                    )}
                                >
                                    {option.label}
                                </button>
                            ))}
                        </div>
                        {seedCount > 0 && (
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('research.preview', {
                                    seedCount,
                                    targetCount,
                                    newItems: newItemsTarget,
                                })}
                            </p>
                        )}
                    </div>

                    {/* Enrichment Options */}
                    <div className="p-4 rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark space-y-4">
                        <h3 className="font-medium text-text dark:text-text-dark">
                            {t('research.enrichmentOptions')}
                        </h3>

                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <FileText className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                                <div>
                                    <span className="text-sm font-medium text-text dark:text-text-dark">
                                        {t('research.enrichDescriptions')}
                                    </span>
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {t('research.enrichDescriptionsHint')}
                                    </p>
                                </div>
                            </div>
                            <Switch
                                checked={enrichDescriptions}
                                onChange={setEnrichDescriptions}
                                disabled={isPending}
                            />
                        </div>

                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <Tags className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                                <div>
                                    <span className="text-sm font-medium text-text dark:text-text-dark">
                                        {t('research.expandTaxonomy')}
                                    </span>
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {t('research.expandTaxonomyHint')}
                                    </p>
                                </div>
                            </div>
                            <Switch
                                checked={expandTaxonomy}
                                onChange={setExpandTaxonomy}
                                disabled={isPending}
                            />
                        </div>

                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <GitPullRequest className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                                <div>
                                    <span className="text-sm font-medium text-text dark:text-text-dark">
                                        {t('research.parsePrIssues')}
                                    </span>
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {t('research.parsePrIssuesHint')}
                                    </p>
                                </div>
                            </div>
                            <Switch
                                checked={parsePullRequests}
                                onChange={setParsePullRequests}
                                disabled={isPending}
                            />
                        </div>
                    </div>
                </>
            )}

            {/* Sync Toggle — only relevant for awesome_readme imports */}
            {isAwesomeReadme && (
                <div className="flex items-center justify-between p-4 rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark">
                    <div>
                        <h3 className="font-medium text-text dark:text-text-dark">
                            {t('sync.title')}
                        </h3>
                        <p className="text-sm text-text-muted dark:text-text-muted-dark">
                            {t('sync.description')}
                        </p>
                    </div>
                    <Switch checked={sync} onChange={onSyncChange} disabled={isPending} />
                </div>
            )}

            {/* Provider & Pipeline Selection - only for awesome_readme */}
            {isAwesomeReadme && formSchema && (
                <ProviderSelectionSection
                    formSchema={formSchema}
                    providers={selectedProviders}
                    onProviderChange={handleProviderChange}
                />
            )}

            {/* Destination Account */}
            <div className="space-y-4 p-4 rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark">
                <OrganizationSelector
                    value={owner}
                    providerId={gitProvider!}
                    onChange={onOwnerChange}
                    disabled={isPending}
                    suggestedOwner={
                        effectiveSourceType === 'data_repo' ? undefined : analysisResult?.owner
                    }
                />
            </div>

            {/* Source Attribution / Legal Note */}
            <div
                className={cn(
                    'p-4 rounded-lg',
                    'bg-surface dark:bg-surface-dark',
                    'border border-border dark:border-border-dark',
                )}
            >
                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                    {isAwesomeReadme ? (
                        <>
                            <strong>{t('research.legalNote')}</strong>{' '}
                            {t('research.legalDescription')}
                        </>
                    ) : (
                        <>
                            <strong>{t('attribution.title')}</strong>{' '}
                            {t('attribution.text', { url: analysisResult?.sourceUrl || sourceUrl })}
                        </>
                    )}
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
                        isAwesomeReadme ? (
                            t('research.importingButton')
                        ) : (
                            t('importingButton')
                        )
                    ) : isAwesomeReadme ? (
                        <>
                            <Sparkles className="w-5 h-5" />
                            {t('research.importButton')}
                        </>
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
