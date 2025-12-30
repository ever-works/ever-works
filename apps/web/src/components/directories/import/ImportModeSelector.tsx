'use client';

import { cn } from '@/lib/utils/cn';
import { Copy, LinkIcon, ArrowRight } from 'lucide-react';
import { useTranslations } from 'next-intl';

export type ImportMode = 'import' | 'link_existing';

interface ImportModeSelectorProps {
    repoInfo: {
        owner: string;
        repo: string;
        itemCount?: number;
        categoryCount?: number;
    };
    onSelectMode: (mode: ImportMode) => void;
    disabled?: boolean;
}

interface ModeOptionProps {
    title: string;
    description: string;
    icon: React.ReactNode;
    selected?: boolean;
    onClick: () => void;
    disabled?: boolean;
}

function ModeOption({ title, description, icon, selected, onClick, disabled }: ModeOptionProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
                'flex flex-col items-center gap-4 p-6 rounded-lg border text-center transition-all h-full',
                'hover:border-primary/50 hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark',
                selected && 'border-primary bg-primary/5',
                disabled && 'opacity-50 cursor-not-allowed',
                !selected && 'border-border dark:border-border-dark',
            )}
        >
            <div
                className={cn(
                    'shrink-0 w-12 h-12 rounded-lg flex items-center justify-center',
                    'bg-surface-secondary dark:bg-surface-secondary-dark',
                )}
            >
                {icon}
            </div>
            <div className="flex-1 flex flex-col items-center">
                <div className="flex items-center gap-2 mb-2">
                    <h4 className="font-medium text-foreground dark:text-foreground-dark">
                        {title}
                    </h4>
                    <ArrowRight className="w-4 h-4 text-muted dark:text-muted-dark" />
                </div>
                <p className="text-sm text-muted dark:text-muted-dark">{description}</p>
            </div>
        </button>
    );
}

export function ImportModeSelector({ repoInfo, onSelectMode, disabled }: ImportModeSelectorProps) {
    const t = useTranslations('dashboard.directoryCreation.import.chooseMode');

    const repoDescription =
        repoInfo.itemCount !== undefined
            ? t('repositoryWithItems', {
                  owner: repoInfo.owner,
                  repo: repoInfo.repo,
                  itemCount: repoInfo.itemCount,
              })
            : t('repository', { owner: repoInfo.owner, repo: repoInfo.repo });

    return (
        <div className="space-y-4">
            <div className="text-center mb-6">
                <h3 className="text-lg font-semibold text-foreground dark:text-foreground-dark">
                    {t('title')}
                </h3>
                <p className="text-sm text-muted dark:text-muted-dark mt-1">{repoDescription}</p>
            </div>

            <div className="grid grid-cols-2 gap-4">
                <ModeOption
                    title={t('importCopy.title')}
                    description={t('importCopy.description')}
                    icon={<Copy className="w-6 h-6 text-primary" />}
                    onClick={() => onSelectMode('import')}
                    disabled={disabled}
                />

                <ModeOption
                    title={t('linkExisting.title')}
                    description={t('linkExisting.description')}
                    icon={<LinkIcon className="w-6 h-6 text-primary" />}
                    onClick={() => onSelectMode('link_existing')}
                    disabled={disabled}
                />
            </div>
        </div>
    );
}
