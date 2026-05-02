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
    const t = useTranslations('dashboard.workCreation.import');

    return (
        <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
                <button
                    type="button"
                    onClick={() => onSourceMethodChange('url')}
                    className={cn(
                        'p-5 rounded-xl border text-left transition-all cursor-pointer',
                        'bg-card dark:bg-card-primary-dark',
                        sourceMethod === 'url'
                            ? 'border-button-primary dark:border-button-primary-dark shadow-sm'
                            : 'border-card-border dark:border-border-dark hover:border-button-primary dark:hover:border-button-primary-dark',
                    )}
                >
                    <div className="w-9 h-9 rounded-lg bg-primary-500/10 flex items-center justify-center mb-3">
                        <Link className="w-5 h-5 text-primary-500" strokeWidth={1.4} />
                    </div>
                    <h4 className="font-semibold text-text dark:text-text-dark mb-1">
                        {t('sourceMethod.url.title')}
                    </h4>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark leading-relaxed">
                        {t('sourceMethod.url.description')}
                    </p>
                </button>

                <button
                    type="button"
                    onClick={() => onSourceMethodChange('repository')}
                    className={cn(
                        'p-5 rounded-xl border text-left transition-all cursor-pointer',
                        'bg-card dark:bg-card-primary-dark',
                        sourceMethod === 'repository'
                            ? 'border-button-primary dark:border-button-primary-dark shadow-sm'
                            : 'border-card-border dark:border-border-dark hover:border-button-primary dark:hover:border-button-primary-dark',
                    )}
                >
                    <div className="w-9 h-9 rounded-lg bg-accent-indigo/10 flex items-center justify-center mb-3">
                        <FolderGit2 className="w-5 h-5 text-accent-indigo" strokeWidth={1.4} />
                    </div>
                    <h4 className="font-semibold text-text dark:text-text-dark mb-1">
                        {t('sourceMethod.repository.title')}
                    </h4>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark leading-relaxed">
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
