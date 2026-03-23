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
    hasWriteAccess?: boolean;
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
                    <h4 className="font-medium text-foreground">{title}</h4>
                    <ArrowRight className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                </div>
                <p className="text-sm text-text-muted dark:text-text-muted-dark">{description}</p>
            </div>
        </button>
    );
}

export function ImportModeSelector({
    repoInfo,
    onSelectMode,
    disabled,
    hasWriteAccess,
}: ImportModeSelectorProps) {
    const t = useTranslations('dashboard.directoryCreation.import.chooseMode');
    const showLinkOption = hasWriteAccess !== false;

    const repoDescription =
        repoInfo.itemCount !== undefined
            ? t('repositoryWithItems', {
                  owner: repoInfo.owner,
                  repo: repoInfo.repo,
                  itemCount: repoInfo.itemCount,
              })
            : t('repository', { owner: repoInfo.owner, repo: repoInfo.repo });

    const optionCount = 1 + (showLinkOption ? 1 : 0);

    return (
        <div className="space-y-4">
            <div className="text-center mb-6">
                <h3 className="text-lg font-semibold text-foreground">{t('title')}</h3>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1">
                    {repoDescription}
                </p>
            </div>

            <div
                className={cn(
                    'grid gap-4',
                    optionCount === 2 ? 'grid-cols-2' : 'grid-cols-1 max-w-sm mx-auto',
                )}
            >
                <ModeOption
                    title={t('importCopy.title')}
                    description={t('importCopy.description')}
                    icon={<Copy className="w-6 h-6 text-primary" />}
                    onClick={() => onSelectMode('import')}
                    disabled={disabled}
                />

                {showLinkOption && (
                    <ModeOption
                        title={t('linkExisting.title')}
                        description={t('linkExisting.description')}
                        icon={<LinkIcon className="w-6 h-6 text-primary" />}
                        onClick={() => onSelectMode('link_existing')}
                        disabled={disabled}
                    />
                )}
            </div>
        </div>
    );
}
