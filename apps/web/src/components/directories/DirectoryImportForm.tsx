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
import { OrganizationSelector } from './OrganizationSelector';
import { RepositorySelector, GitHubRepo } from './RepositorySelector';
import {
    ChevronDown,
    Upload,
    Link,
    FolderGit2,
    Loader2,
    AlertCircle,
    CheckCircle2,
    FileText,
    Database,
    ArrowLeft,
    ArrowRight,
} from 'lucide-react';
import { analyzeRepository, importDirectory } from '@/app/actions/dashboard/directories';

interface DirectoryImportFormProps {
    user: AuthUser;
}

type ImportStep = 'source' | 'analyzing' | 'configure' | 'importing';
type SourceMethod = 'url' | 'repository';
type DetectedType = 'data_repo' | 'awesome_readme' | null;

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
        itemCount?: number;
        categoryCount?: number;
    };
    error?: string;
}

export function DirectoryImportForm({ user }: DirectoryImportFormProps) {
    const [step, setStep] = useState<ImportStep>('source');
    const [sourceMethod, setSourceMethod] = useState<SourceMethod>('url');
    const [sourceUrl, setSourceUrl] = useState('');
    const [directoryName, setDirectoryName] = useState('');
    const [organization, setOrganization] = useState(false);
    const [owner, setOwner] = useState('');
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
    const [isPending, startTransition] = useTransition();
    const router = useRouter();
    const t = useTranslations('dashboard.directoryCreation.import');

    const handleRepositorySelect = (repo: GitHubRepo) => {
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
            const result = await analyzeRepository(sourceUrl);

            if (result.success && result.data) {
                setAnalysisResult(result.data);

                if (result.data.error) {
                    toast.error(result.data.error);
                    setStep('source');
                } else if (!result.data.detectedType) {
                    toast.error(t('errors.unsupportedFormat'));
                    setStep('source');
                } else {
                    // Pre-fill directory name from repo name
                    if (!directoryName && result.data.repo) {
                        setDirectoryName(
                            result.data.repo
                                .replace(/-/g, ' ')
                                .replace(/\b\w/g, (c) => c.toUpperCase()),
                        );
                    }
                    setStep('configure');
                }
            } else {
                toast.error(result.error || t('errors.analyzeFailed'));
                setStep('source');
            }
        });
    };

    const handleImport = async () => {
        if (!directoryName.trim()) {
            toast.error(t('errors.nameRequired'));
            return;
        }

        if (!analysisResult || !analysisResult.detectedType) {
            toast.error(t('errors.noAnalysis'));
            return;
        }

        setStep('importing');

        startTransition(async () => {
            const result = await importDirectory({
                sourceUrl,
                sourceType: analysisResult.detectedType!,
                name: directoryName,
                organization,
                owner: organization ? owner : undefined,
            });

            if (result.success) {
                toast.success(result.message || t('success.started'));

                if (result.directoryId) {
                    router.push(ROUTES.DASHBOARD_DIRECTORY(result.directoryId));
                } else {
                    router.push(ROUTES.DASHBOARD_DIRECTORIES);
                }
            } else if (result.requiresGitHub) {
                toast.error(result.error || t('errors.githubRequired'));
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
                    authId={user.sub}
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

    const renderConfigureStep = () => (
        <div className="space-y-6">
            {/* Analysis Result */}
            {analysisResult && (
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

            {/* Directory Name */}
            <Input
                label={`${t('nameLabel')} *`}
                type="text"
                value={directoryName}
                onChange={(e) => setDirectoryName(e.target.value)}
                placeholder={t('namePlaceholder')}
                variant="form"
            />

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
                        authId={user.sub}
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
                    disabled={isPending || !directoryName.trim()}
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
                {step === 'configure' && renderConfigureStep()}
                {step === 'importing' && renderImportingStep()}
            </div>
        </div>
    );
}
