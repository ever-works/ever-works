'use client';

import { useState, useTransition } from 'react';
import { AuthUser } from '@/lib/auth';
import { cn } from '@/lib/utils/cn';
import { toast } from 'sonner';
import { ROUTES } from '@/lib/constants';
import { useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { OrganizationSelector } from './OrganizationSelector';
import { RepositorySelector, GitRepo } from './RepositorySelector';
import {
    ChevronDown,
    Upload,
    Link,
    FolderGit2,
    Loader2,
    CheckCircle2,
    FileText,
    Database,
    ArrowLeft,
    ArrowRight,
} from 'lucide-react';
import {
    analyzeRepository,
    importDirectory,
    analyzeForLinking,
} from '@/app/actions/dashboard/directories';
import { ImportModeSelector, LinkExistingConfirm, type ImportMode } from './import';
import type { AnalyzeForLinkingResponseDto } from '@/lib/api/directory';

interface DirectoryImportFormProps {
    user: AuthUser;
    gitProvider?: string;
    deployProvider?: string;
}

type ImportStep = 'source' | 'analyzing' | 'choose_mode' | 'configure' | 'importing';
type SourceMethod = 'url' | 'repository';
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
    error?: string;
}

export function DirectoryImportForm({ gitProvider, deployProvider }: DirectoryImportFormProps) {
    const [step, setStep] = useState<ImportStep>('source');
    const [sourceMethod, setSourceMethod] = useState<SourceMethod>('url');
    const [sourceUrl, setSourceUrl] = useState('');
    const [directoryName, setDirectoryName] = useState('');
    const [organization, setOrganization] = useState(false);
    const [owner, setOwner] = useState('');
    const [sync, setSync] = useState(true);
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
    const [linkAnalysis, setLinkAnalysis] = useState<AnalyzeForLinkingResponseDto | null>(null);
    const [showLinkConfirm, setShowLinkConfirm] = useState(false);
    const [manualSourceType, setManualSourceType] = useState<'data_repo' | 'awesome_readme' | null>(
        null,
    );
    const [isPending, startTransition] = useTransition();
    const router = useRouter();
    const t = useTranslations('dashboard.directoryCreation.import');

    const handleRepositorySelect = (repo: GitRepo) => {
        setSourceUrl(repo.html_url);
        setDirectoryName(repo.name);
    };

    const handleAnalyze = async () => {
        if (!sourceUrl.trim()) {
            toast.error(t('errors.urlRequired'));
            return;
        }

        setStep('analyzing');

        startTransition(async () => {
            const result = await analyzeRepository(sourceUrl, gitProvider);

            if (result.success && result.data) {
                setAnalysisResult(result.data);

                if (result.data.error) {
                    toast.error(result.data.error);
                    setStep('source');
                } else {
                    // Pre-fill directory name from repo name
                    if (!directoryName && result.data.repo) {
                        let repoName = result.data.repo;
                        // Strip -data suffix for data repos to avoid naming conflicts
                        if (repoName.endsWith('-data')) {
                            repoName = repoName.slice(0, -5);
                        }
                        setDirectoryName(
                            repoName.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
                        );
                    }

                    // Reset manual source type when detection succeeds
                    setManualSourceType(null);

                    if (!result.data.detectedType) {
                        // Format not auto-detected, allow manual selection
                        // Default to awesome_readme if there's a README
                        if (result.data.structure?.hasReadme) {
                            setManualSourceType('awesome_readme');
                        }
                        setStep('configure');
                    } else if (result.data.detectedType === 'data_repo') {
                        // For data_repo, show mode selection
                        setStep('choose_mode');
                    } else {
                        setStep('configure');
                    }
                }
            } else {
                toast.error(result.error || t('errors.analyzeFailed'));
                setStep('source');
            }
        });
    };

    const handleModeSelect = async (mode: ImportMode) => {
        if (mode === 'import') {
            setStep('configure');
        } else if (mode === 'link_existing' && analysisResult && gitProvider) {
            startTransition(async () => {
                const result = await analyzeForLinking(analysisResult.sourceUrl, gitProvider);
                if (result.success && result.data) {
                    setLinkAnalysis(result.data);
                    setShowLinkConfirm(true);
                } else {
                    toast.error(result.error || t('errors.analyzeForLinkingFailed'));
                    setStep('choose_mode');
                }
            });
        }
    };

    const handleLinkConfirm = async (createMissingRepos: boolean) => {
        if (!analysisResult) return;

        setShowLinkConfirm(false);
        setStep('importing');

        startTransition(async () => {
            const result = await importDirectory({
                sourceUrl,
                sourceType: 'link_existing',
                name: directoryName,
                organization,
                owner: organization ? owner : undefined,
                createMissingRepos,
                gitProvider,
                deployProvider,
            });

            if (result.success) {
                toast.success(result.message || t('success.linked'));
                if (result.directoryId) {
                    router.push(ROUTES.DASHBOARD_DIRECTORY(result.directoryId));
                } else {
                    router.push(ROUTES.DASHBOARD_DIRECTORIES);
                }
            } else {
                toast.error(result.error || t('errors.linkFailed'));
                setStep('choose_mode');
            }
        });
    };

    const handleImport = async () => {
        if (!directoryName.trim()) {
            toast.error(t('errors.nameRequired'));
            return;
        }

        const sourceType = analysisResult?.detectedType || manualSourceType;
        if (!analysisResult || !sourceType) {
            toast.error(t('errors.noAnalysis'));
            return;
        }

        setStep('importing');

        startTransition(async () => {
            const result = await importDirectory({
                sourceUrl,
                sourceType,
                name: directoryName,
                organization,
                owner: organization ? owner : undefined,
                sync,
                gitProvider,
                deployProvider,
            });

            if (result.success) {
                toast.success(result.message || t('success.started'));

                if (result.directoryId) {
                    router.push(ROUTES.DASHBOARD_DIRECTORY(result.directoryId));
                } else {
                    router.push(ROUTES.DASHBOARD_DIRECTORIES);
                }
            } else if (result.requiresGitProvider) {
                toast.error(result.error || 'Git provider connection required');
                setStep('configure');
            } else {
                toast.error(result.error || t('errors.importFailed'));
                setStep('configure');
            }
        });
    };

    const renderSourceStep = () => (
        <div className="space-y-6">
            {/* Source Method Selection */}
            <div className="grid grid-cols-2 gap-4">
                <button
                    type="button"
                    onClick={() => setSourceMethod('url')}
                    className={cn(
                        'p-4 rounded-lg border-2 text-left transition-all',
                        'bg-card dark:bg-card-dark',
                        sourceMethod === 'url'
                            ? 'border-primary shadow-md'
                            : 'border-card-border dark:border-card-border-dark hover:border-primary/50',
                    )}
                >
                    <Link className="w-6 h-6 text-primary mb-2" />
                    <h4 className="font-medium text-text dark:text-text-dark">
                        {t('sourceMethod.url.title')}
                    </h4>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('sourceMethod.url.description')}
                    </p>
                </button>

                <button
                    type="button"
                    onClick={() => setSourceMethod('repository')}
                    className={cn(
                        'p-4 rounded-lg border-2 text-left transition-all',
                        'bg-card dark:bg-card-dark',
                        sourceMethod === 'repository'
                            ? 'border-primary shadow-md'
                            : 'border-card-border dark:border-card-border-dark hover:border-primary/50',
                    )}
                >
                    <FolderGit2 className="w-6 h-6 text-primary mb-2" />
                    <h4 className="font-medium text-text dark:text-text-dark">
                        {t('sourceMethod.repository.title')}
                    </h4>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('sourceMethod.repository.description')}
                    </p>
                </button>
            </div>

            {/* URL Input or Repository Selector */}
            {sourceMethod === 'url' ? (
                <Input
                    label={t('urlLabel')}
                    type="url"
                    value={sourceUrl}
                    onChange={(e) => setSourceUrl(e.target.value)}
                    placeholder={t('urlPlaceholder')}
                    helperText={t('urlHelp')}
                    variant="form"
                />
            ) : (
                <RepositorySelector
                    providerId={gitProvider!}
                    onSelect={handleRepositorySelect}
                    selectedUrl={sourceUrl}
                />
            )}

            {/* Supported Formats Info */}
            <div
                className={cn(
                    'p-4 rounded-lg',
                    'bg-surface dark:bg-surface-dark',
                    'border border-border dark:border-border-dark',
                )}
            >
                <h4 className="text-sm font-medium text-text dark:text-text-dark mb-3">
                    {t('supportedFormats.title')}
                </h4>
                <div className="space-y-3">
                    <div className="flex items-start gap-3">
                        <Database className="w-5 h-5 text-primary mt-0.5 shrink-0" />
                        <div>
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {t('supportedFormats.dataRepo.title')}
                            </p>
                            <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                {t('supportedFormats.dataRepo.description')}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-start gap-3">
                        <FileText className="w-5 h-5 text-warning mt-0.5 shrink-0" />
                        <div>
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {t('supportedFormats.awesomeReadme.title')}
                            </p>
                            <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                {t('supportedFormats.awesomeReadme.description')}
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3">
                <Button
                    onClick={handleAnalyze}
                    disabled={!sourceUrl.trim() || isPending}
                    variant="primary"
                    size="lg"
                    fullWidth
                >
                    <ArrowRight className="w-5 h-5" />
                    {t('analyzeButton')}
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
        </div>
    );

    const renderAnalyzingStep = () => (
        <div className="flex flex-col items-center justify-center py-12 space-y-4">
            <Loader2 className="w-12 h-12 text-primary animate-spin" />
            <h3 className="text-xl font-semibold text-text dark:text-text-dark">
                {t('analyzing.title')}
            </h3>
            <p className="text-text-secondary dark:text-text-secondary-dark text-center max-w-md">
                {t('analyzing.subtitle')}
            </p>
        </div>
    );

    const renderChooseModeStep = () => (
        <div className="space-y-6">
            <ImportModeSelector
                repoInfo={{
                    owner: analysisResult?.owner || '',
                    repo: analysisResult?.repo || '',
                    itemCount: analysisResult?.structure?.itemCount,
                    categoryCount: analysisResult?.structure?.categoryCount,
                }}
                onSelectMode={handleModeSelect}
                disabled={isPending}
            />
            <div className="flex justify-center">
                <Button
                    onClick={() => {
                        setStep('source');
                        setAnalysisResult(null);
                    }}
                    disabled={isPending}
                    variant="ghost"
                >
                    <ArrowLeft className="w-4 h-4" />
                    {t('chooseMode.back')}
                </Button>
            </div>

            {/* Link Existing Confirm Dialog */}
            {linkAnalysis && (
                <LinkExistingConfirm
                    open={showLinkConfirm}
                    onOpenChange={setShowLinkConfirm}
                    repoStatus={linkAnalysis.relatedRepos}
                    onConfirm={handleLinkConfirm}
                    isLoading={isPending}
                />
            )}
        </div>
    );

    const effectiveSourceType = analysisResult?.detectedType || manualSourceType;

    const renderConfigureStep = () => (
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
                            onClick={() => setManualSourceType('awesome_readme')}
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
                            onClick={() => setManualSourceType('data_repo')}
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
                onChange={(e) => setDirectoryName(e.target.value)}
                placeholder={t('namePlaceholder')}
                variant="form"
            />

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
                <Switch checked={sync} onChange={setSync} disabled={isPending} />
            </div>

            {/* Advanced Settings Toggle */}
            <Button
                type="button"
                variant="ghost"
                onClick={() => setShowAdvanced(!showAdvanced)}
                fullWidth
                className={cn(
                    'p-4 text-left justify-between',
                    'bg-surface dark:bg-surface-dark',
                    'border border-border dark:border-border-dark',
                    'hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark',
                )}
            >
                <div>
                    <h3 className="font-medium text-text dark:text-text-dark">
                        {t('advancedSettings')}
                    </h3>
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('advancedSubtitle')}
                    </p>
                </div>
                <ChevronDown
                    className={cn(
                        'w-5 h-5 text-text-secondary dark:text-text-secondary-dark transition-transform',
                        showAdvanced && 'rotate-180',
                    )}
                />
            </Button>

            {/* Advanced Fields */}
            {showAdvanced && (
                <div className="space-y-4 p-4 rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark">
                    <OrganizationSelector
                        value={owner}
                        providerId={gitProvider!}
                        onChange={(value, isOrganization) => {
                            setOwner(value);
                            setOrganization(isOrganization);
                        }}
                        disabled={isPending}
                    />
                </div>
            )}

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
                    onClick={() => {
                        setStep('source');
                        setAnalysisResult(null);
                        setManualSourceType(null);
                    }}
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

    const renderImportingStep = () => (
        <div className="flex flex-col items-center justify-center py-12 space-y-4">
            <Loader2 className="w-12 h-12 text-primary animate-spin" />
            <h3 className="text-xl font-semibold text-text dark:text-text-dark">
                {t('importing.title')}
            </h3>
            <p className="text-text-secondary dark:text-text-secondary-dark text-center max-w-md">
                {t('importing.subtitle')}
            </p>
        </div>
    );

    return (
        <div className="space-y-6">
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
                    'p-6 rounded-lg',
                    'bg-card dark:bg-card-dark',
                    'border border-card-border dark:border-card-border-dark',
                )}
            >
                {step === 'source' && renderSourceStep()}
                {step === 'analyzing' && renderAnalyzingStep()}
                {step === 'choose_mode' && renderChooseModeStep()}
                {step === 'configure' && renderConfigureStep()}
                {step === 'importing' && renderImportingStep()}
            </div>
        </div>
    );
}
