'use client';

import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { RepositorySelector, GitRepo } from '../RepositorySelector';
import { Link, FolderGit2, Database, FileText, ArrowRight } from 'lucide-react';

type SourceMethod = 'url' | 'repository';

interface ImportSourceStepProps {
    sourceMethod: SourceMethod;
    onSourceMethodChange: (method: SourceMethod) => void;
    sourceUrl: string;
    onSourceUrlChange: (url: string) => void;
    onRepositorySelect: (repo: GitRepo) => void;
    onAnalyze: () => void;
    onCancel: () => void;
    gitProvider?: string;
    isPending: boolean;
}

export function ImportSourceStep({
    sourceMethod,
    onSourceMethodChange,
    sourceUrl,
    onSourceUrlChange,
    onRepositorySelect,
    onAnalyze,
    onCancel,
    gitProvider,
    isPending,
}: ImportSourceStepProps) {
    const t = useTranslations('dashboard.directoryCreation.import');

    return (
        <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
                <button
                    type="button"
                    onClick={() => onSourceMethodChange('url')}
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
                    onClick={() => onSourceMethodChange('repository')}
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

            {sourceMethod === 'url' ? (
                <Input
                    label={t('urlLabel')}
                    type="url"
                    value={sourceUrl}
                    onChange={(e) => onSourceUrlChange(e.target.value)}
                    placeholder={t('urlPlaceholder')}
                    helperText={t('urlHelp')}
                    variant="form"
                />
            ) : (
                <RepositorySelector
                    providerId={gitProvider!}
                    onSelect={onRepositorySelect}
                    selectedUrl={sourceUrl}
                />
            )}

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

            <div className="flex gap-3">
                <Button
                    onClick={onAnalyze}
                    disabled={!sourceUrl.trim() || isPending}
                    variant="primary"
                    size="lg"
                    fullWidth
                >
                    <ArrowRight className="w-5 h-5" />
                    {t('analyzeButton')}
                </Button>
                <Button
                    onClick={onCancel}
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
}
