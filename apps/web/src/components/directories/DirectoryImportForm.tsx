'use client';

import { useState, useTransition } from 'react';
import { AuthUser } from '@/lib/auth';
import { cn } from '@/lib/utils/cn';
import { toast } from 'sonner';
import { ROUTES } from '@/lib/constants';
import { useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { GitRepo } from './RepositorySelector';
import { Loader2, ArrowLeft } from 'lucide-react';
import {
    analyzeRepository,
    importDirectory,
    analyzeForLinking,
} from '@/app/actions/dashboard/directories';
import {
    ImportModeSelector,
    ImportSourceStep,
    ImportConfigureStep,
    LinkExistingConfirm,
    type ImportMode,
} from './import';
import type { AnalyzeForLinkingResponseDto, ImportEnrichmentConfig } from '@/lib/api/directory';

interface DirectoryImportFormProps {
    user: AuthUser;
    gitProvider?: string;
    deployProvider?: string;
}

type ImportStep = 'source' | 'analyzing' | 'choose_mode' | 'configure';
type ImportPath = 'direct' | 'from_choose_mode';

interface AnalysisResult {
    sourceUrl: string;
    owner: string;
    repo: string;
    detectedType: 'data_repo' | 'awesome_readme' | 'link_existing' | null;
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
    relatedDataRepo?: { name: string; owner: string };
    baseSlug?: string;
    slugConflict?: {
        hasConflict: boolean;
        conflictingRepos: string[];
        suggestedSlug: string;
    };
    hasDataRepoWriteAccess?: boolean;
    error?: string;
}

export function DirectoryImportForm({ gitProvider, deployProvider }: DirectoryImportFormProps) {
    const [step, setStep] = useState<ImportStep>('source');
    const [sourceMethod, setSourceMethod] = useState<'url' | 'repository'>('url');
    const [sourceUrl, setSourceUrl] = useState('');
    const [directoryName, setDirectoryName] = useState('');
    const [sync, setSync] = useState(false);
    const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
    const [linkAnalysis, setLinkAnalysis] = useState<AnalyzeForLinkingResponseDto | null>(null);
    const [showLinkConfirm, setShowLinkConfirm] = useState(false);
    const [manualSourceType, setManualSourceType] = useState<'data_repo' | 'awesome_readme' | null>(
        null,
    );
    const [owner, setOwner] = useState('');
    const [organization, setOrganization] = useState(false);
    const [importPath, setImportPath] = useState<ImportPath>('direct');
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
        setDirectoryName('');

        startTransition(async () => {
            const result = await analyzeRepository(sourceUrl, gitProvider);

            if (result.success && result.data) {
                setAnalysisResult(result.data as AnalysisResult);

                if (result.data.error) {
                    toast.error(result.data.error);
                    setStep('source');
                } else {
                    if (result.data.repo) {
                        let repoName = result.data.baseSlug || result.data.repo;
                        if (repoName.endsWith('-data')) {
                            repoName = repoName.slice(0, -5);
                        } else if (repoName.endsWith('-website')) {
                            repoName = repoName.slice(0, -8);
                        }
                        setDirectoryName(
                            repoName
                                .replace(/-/g, ' ')
                                .replace(/\b\w/g, (c: string) => c.toUpperCase()),
                        );
                    }

                    setManualSourceType(null);

                    // Auto-populate owner from source repository
                    if (result.data.owner) {
                        setOwner(result.data.owner);
                        setOrganization(true);
                    }

                    if (result.data.relatedDataRepo) {
                        // data_repo with link_existing option — show mode selector
                        setStep('choose_mode');
                    } else if (!result.data.detectedType) {
                        if (result.data.structure?.hasReadme) {
                            setManualSourceType('awesome_readme');
                        }
                        setStep('configure');
                    } else if (result.data.detectedType === 'data_repo') {
                        // data_repo with potential link option — show mode selector
                        setStep('choose_mode');
                    } else {
                        // awesome_readme and others go directly to configure
                        setStep('configure');
                    }
                }
            } else {
                toast.error(result.error || t('errors.analyzeFailed'));
                setStep('source');
            }
        });
    };

    const buildRelatedRepoUrl = (dataRepo: { owner: string; name: string }): string => {
        if (!analysisResult) return sourceUrl;
        const base = analysisResult.sourceUrl.replace(/\/[^/]+\/[^/]+\/?$/, '');
        return `${base}/${dataRepo.owner}/${dataRepo.name}`;
    };

    const handleModeSelect = async (mode: ImportMode) => {
        if (mode === 'import') {
            // Reset owner to personal account — user picks their destination in configure step
            setOwner('');
            setOrganization(false);
            setImportPath('from_choose_mode');
            setStep('configure');
        } else if (mode === 'link_existing' && analysisResult && gitProvider) {
            startTransition(async () => {
                const linkUrl = analysisResult.relatedDataRepo
                    ? buildRelatedRepoUrl(analysisResult.relatedDataRepo)
                    : analysisResult.sourceUrl;
                const result = await analyzeForLinking(linkUrl, gitProvider);
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

        startTransition(async () => {
            const linkSourceUrl = analysisResult.relatedDataRepo
                ? buildRelatedRepoUrl(analysisResult.relatedDataRepo)
                : sourceUrl;
            const result = await importDirectory({
                sourceUrl: linkSourceUrl,
                sourceType: 'link_existing',
                name: directoryName,
                gitProvider,
                deployProvider,
                createMissingRepos,
                owner: organization ? owner : undefined,
                organization,
            });

            if (result.success) {
                toast.success(result.message || t('success.linked'));
                router.push(
                    result.directoryId
                        ? ROUTES.DASHBOARD_DIRECTORY(result.directoryId)
                        : ROUTES.DASHBOARD_DIRECTORIES,
                );
            } else {
                toast.error(result.error || t('errors.linkFailed'));
            }
        });
    };

    const handleImport = async (
        providers?: Record<string, string>,
        enrichmentConfig?: ImportEnrichmentConfig,
    ) => {
        if (!directoryName.trim()) {
            toast.error(t('errors.nameRequired'));
            return;
        }

        const sourceType = analysisResult?.detectedType || manualSourceType;
        if (!analysisResult || !sourceType) {
            toast.error(t('errors.noAnalysis'));
            return;
        }

        startTransition(async () => {
            const result = await importDirectory({
                sourceUrl,
                sourceType,
                name: directoryName,
                sync,
                gitProvider,
                deployProvider,
                providers,
                owner: organization ? owner : undefined,
                organization,
                enrichmentConfig,
            });

            if (result.success) {
                toast.success(result.message || t('success.started'));
                router.push(
                    result.directoryId
                        ? ROUTES.DASHBOARD_DIRECTORY(result.directoryId)
                        : ROUTES.DASHBOARD_DIRECTORIES,
                );
            } else if (result.requiresGitProvider) {
                toast.error(result.error || 'Git provider connection required');
            } else {
                toast.error(result.error || t('errors.importFailed'));
            }
        });
    };

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
                    'bg-card dark:bg-card-primary-dark',
                    'border border-card-border dark:border-border-secondary-dark',
                )}
            >
                {step === 'source' && (
                    <ImportSourceStep
                        sourceMethod={sourceMethod}
                        onSourceMethodChange={setSourceMethod}
                        sourceUrl={sourceUrl}
                        onSourceUrlChange={setSourceUrl}
                        onRepositorySelect={handleRepositorySelect}
                        onAnalyze={handleAnalyze}
                        onCancel={() => router.back()}
                        gitProvider={gitProvider}
                        isPending={isPending}
                    />
                )}

                {step === 'analyzing' && (
                    <div className="flex flex-col items-center justify-center py-12 space-y-4">
                        <Loader2 className="w-12 h-12 text-primary animate-spin" />
                        <h3 className="text-xl font-semibold text-text dark:text-text-dark">
                            {t('analyzing.title')}
                        </h3>
                        <p className="text-text-secondary dark:text-text-secondary-dark text-center max-w-md">
                            {t('analyzing.subtitle')}
                        </p>
                    </div>
                )}

                {step === 'choose_mode' && (
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
                            hasWriteAccess={analysisResult?.hasDataRepoWriteAccess}
                        />
                        <div className="flex justify-center">
                            <Button
                                onClick={() => {
                                    setStep('source');
                                    setAnalysisResult(null);
                                    setOwner('');
                                    setOrganization(false);
                                }}
                                disabled={isPending}
                                variant="ghost"
                            >
                                <ArrowLeft className="w-4 h-4" />
                                {t('chooseMode.back')}
                            </Button>
                        </div>
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
                )}

                {step === 'configure' && (
                    <ImportConfigureStep
                        analysisResult={analysisResult}
                        sourceUrl={sourceUrl}
                        directoryName={directoryName}
                        onDirectoryNameChange={setDirectoryName}
                        manualSourceType={manualSourceType}
                        onManualSourceTypeChange={setManualSourceType}
                        sync={sync}
                        onSyncChange={setSync}
                        gitProvider={gitProvider}
                        isPending={isPending}
                        owner={owner}
                        onOwnerChange={(value, isOrganization) => {
                            setOwner(value);
                            setOrganization(isOrganization);
                        }}
                        onBack={() => {
                            if (importPath === 'from_choose_mode') {
                                setStep('choose_mode');
                                setImportPath('direct');
                                setManualSourceType(null);
                            } else {
                                setStep('source');
                                setAnalysisResult(null);
                                setManualSourceType(null);
                            }
                            setOwner('');
                            setOrganization(false);
                        }}
                        onImport={handleImport}
                    />
                )}
            </div>
        </div>
    );
}
