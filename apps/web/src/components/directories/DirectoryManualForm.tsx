'use client';

import { useState, useTransition } from 'react';
import { AuthUser } from '@/lib/auth';
import { cn } from '@/lib/utils/cn';
import { toast } from 'sonner';
import type { CreateDirectoryDto } from '@/lib/api/directory';
import { createDirectory } from '@/app/actions/dashboard';
import { ROUTES } from '@/lib/constants';
import { RepoProvider } from '@/lib/api/enums';
import { useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';

interface DirectoryManualFormProps {
    user: AuthUser;
}

export function DirectoryManualForm({ user }: DirectoryManualFormProps) {
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [isPending, startTransition] = useTransition();
    const router = useRouter();
    const t = useTranslations('dashboard.directoryCreation.manual');

    // Form state
    const [formData, setFormData] = useState<CreateDirectoryDto>({
        slug: '',
        name: '',
        description: '',
        organization: false,
        repoProvider: RepoProvider.GITHUB,
        owner: '',
        readmeConfig: {
            header: '',
            overwriteDefaultHeader: false,
            footer: '',
            overwriteDefaultFooter: false,
        },
    });

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        // Basic validation
        if (!formData.name.trim()) {
            toast.error(t('nameRequired'));
            return;
        }
        if (!formData.slug.trim()) {
            toast.error(t('slugRequired'));
            return;
        }
        if (!formData.description.trim()) {
            toast.error(t('descriptionRequired'));
            return;
        }

        startTransition(async () => {
            const result = await createDirectory(formData);

            if (result.success) {
                toast.success(result.message || t('success.created'));
                router.push(ROUTES.DASHBOARD_DIRECTORIES);
            } else if (result.requiresGitHub) {
                toast.error('Please connect your GitHub account first');
                router.push(ROUTES.DASHBOARD_DIRECTORIES_NEW);
            } else {
                toast.error(result.error || 'Failed to create directory');
            }
        });
    };

    const generateSlug = (name: string) => {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
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

            <form onSubmit={handleSubmit} className="space-y-6">
                {/* Basic Fields */}
                <div
                    className={cn(
                        'p-6 rounded-lg',
                        'bg-card dark:bg-card-dark',
                        'border border-card-border dark:border-card-border-dark',
                    )}
                >
                    <h2 className="text-lg font-semibold text-text dark:text-text-dark mb-4">
                        {t('basicInfo')}
                    </h2>

                    <div className="space-y-4">
                        {/* Name */}
                        <div>
                            <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                                {t('nameLabel')}
                            </label>
                            <input
                                type="text"
                                value={formData.name}
                                onChange={(e) => {
                                    setFormData({
                                        ...formData,
                                        name: e.target.value,
                                        slug: generateSlug(e.target.value),
                                    });
                                }}
                                placeholder={t('namePlaceholder')}
                                className={cn(
                                    'w-full px-4 py-2 rounded-lg',
                                    'bg-surface dark:bg-surface-dark',
                                    'border border-border dark:border-border-dark',
                                    'text-text dark:text-text-dark',
                                    'placeholder-text-muted dark:placeholder-text-muted-dark',
                                    'focus:outline-none focus:border-primary',
                                )}
                                required
                            />
                        </div>

                        {/* Slug */}
                        <div>
                            <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                                {t('slugLabel')}
                            </label>
                            <input
                                type="text"
                                value={formData.slug}
                                onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
                                placeholder={t('slugPlaceholder')}
                                pattern="[a-z0-9-]+"
                                className={cn(
                                    'w-full px-4 py-2 rounded-lg',
                                    'bg-surface dark:bg-surface-dark',
                                    'border border-border dark:border-border-dark',
                                    'text-text dark:text-text-dark',
                                    'placeholder-text-muted dark:placeholder-text-muted-dark',
                                    'focus:outline-none focus:border-primary',
                                )}
                                required
                            />
                            <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                                {t('slugHelp')}
                            </p>
                        </div>

                        {/* Description */}
                        <div>
                            <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                                {t('descriptionLabel')}
                            </label>
                            <textarea
                                value={formData.description}
                                onChange={(e) =>
                                    setFormData({ ...formData, description: e.target.value })
                                }
                                placeholder={t('descriptionPlaceholder')}
                                rows={3}
                                className={cn(
                                    'w-full px-4 py-2 rounded-lg resize-none',
                                    'bg-surface dark:bg-surface-dark',
                                    'border border-border dark:border-border-dark',
                                    'text-text dark:text-text-dark',
                                    'placeholder-text-muted dark:placeholder-text-muted-dark',
                                    'focus:outline-none focus:border-primary',
                                )}
                                required
                            />
                        </div>
                    </div>
                </div>

                {/* Advanced Fields Toggle */}
                <button
                    type="button"
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className={cn(
                        'w-full p-4 rounded-lg text-left',
                        'bg-surface dark:bg-surface-dark',
                        'border border-border dark:border-border-dark',
                        'hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark',
                        'transition-colors',
                    )}
                >
                    <div className="flex items-center justify-between">
                        <div>
                            <h3 className="font-medium text-text dark:text-text-dark">
                                {t('advancedSettings')}
                            </h3>
                            <p className="text-sm text-text-muted dark:text-text-muted-dark">
                                {t('advancedSubtitle')}
                            </p>
                        </div>
                        <svg
                            className={cn(
                                'w-5 h-5 text-text-secondary dark:text-text-secondary-dark transition-transform',
                                showAdvanced && 'rotate-180',
                            )}
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M19 9l-7 7-7-7"
                            />
                        </svg>
                    </div>
                </button>

                {/* Advanced Fields */}
                {showAdvanced && (
                    <div
                        className={cn(
                            'p-6 rounded-lg space-y-4',
                            'bg-card dark:bg-card-dark',
                            'border border-card-border dark:border-card-border-dark',
                        )}
                    >
                        {/* Organization */}
                        <div>
                            <label className="flex items-center gap-3">
                                <input
                                    type="checkbox"
                                    checked={formData.organization}
                                    onChange={(e) =>
                                        setFormData({ ...formData, organization: e.target.checked })
                                    }
                                    className="w-4 h-4 rounded border-border dark:border-border-dark text-primary focus:ring-primary"
                                />
                                <div>
                                    <span className="text-sm font-medium text-text dark:text-text-dark">
                                        {t('organizationLabel')}
                                    </span>
                                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {t('organizationHelp')}
                                    </p>
                                </div>
                            </label>
                        </div>

                        {/* Owner */}
                        {formData.organization && (
                            <div>
                                <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                                    {t('organizationNameLabel')}
                                </label>
                                <input
                                    type="text"
                                    value={formData.owner || ''}
                                    onChange={(e) =>
                                        setFormData({ ...formData, owner: e.target.value })
                                    }
                                    placeholder={t('organizationNamePlaceholder')}
                                    className={cn(
                                        'w-full px-4 py-2 rounded-lg',
                                        'bg-surface dark:bg-surface-dark',
                                        'border border-border dark:border-border-dark',
                                        'text-text dark:text-text-dark',
                                        'placeholder-text-muted dark:placeholder-text-muted-dark',
                                        'focus:outline-none focus:border-primary',
                                    )}
                                />
                            </div>
                        )}

                        {/* README Header */}
                        <div>
                            <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                                {t('headerLabel')}
                            </label>
                            <textarea
                                value={formData.readmeConfig?.header || ''}
                                onChange={(e) =>
                                    setFormData({
                                        ...formData,
                                        readmeConfig: {
                                            ...formData.readmeConfig,
                                            header: e.target.value,
                                        },
                                    })
                                }
                                placeholder={t('headerPlaceholder')}
                                rows={3}
                                className={cn(
                                    'w-full px-4 py-2 rounded-lg resize-none',
                                    'bg-surface dark:bg-surface-dark',
                                    'border border-border dark:border-border-dark',
                                    'text-text dark:text-text-dark',
                                    'placeholder-text-muted dark:placeholder-text-muted-dark',
                                    'focus:outline-none focus:border-primary',
                                )}
                            />
                            <label className="flex items-center gap-2 mt-2">
                                <input
                                    type="checkbox"
                                    checked={formData.readmeConfig?.overwriteDefaultHeader || false}
                                    onChange={(e) =>
                                        setFormData({
                                            ...formData,
                                            readmeConfig: {
                                                ...formData.readmeConfig,
                                                overwriteDefaultHeader: e.target.checked,
                                            },
                                        })
                                    }
                                    className="w-4 h-4 rounded border-border dark:border-border-dark text-primary focus:ring-primary"
                                />
                                <span className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                    {t('headerOverwrite')}
                                </span>
                            </label>
                        </div>

                        {/* README Footer */}
                        <div>
                            <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                                Custom README Footer
                            </label>
                            <textarea
                                value={formData.readmeConfig?.footer || ''}
                                onChange={(e) =>
                                    setFormData({
                                        ...formData,
                                        readmeConfig: {
                                            ...formData.readmeConfig,
                                            footer: e.target.value,
                                        },
                                    })
                                }
                                placeholder="Add custom content to the bottom of your README file"
                                rows={3}
                                className={cn(
                                    'w-full px-4 py-2 rounded-lg resize-none',
                                    'bg-surface dark:bg-surface-dark',
                                    'border border-border dark:border-border-dark',
                                    'text-text dark:text-text-dark',
                                    'placeholder-text-muted dark:placeholder-text-muted-dark',
                                    'focus:outline-none focus:border-primary',
                                )}
                            />
                            <label className="flex items-center gap-2 mt-2">
                                <input
                                    type="checkbox"
                                    checked={formData.readmeConfig?.overwriteDefaultFooter || false}
                                    onChange={(e) =>
                                        setFormData({
                                            ...formData,
                                            readmeConfig: {
                                                ...formData.readmeConfig,
                                                overwriteDefaultFooter: e.target.checked,
                                            },
                                        })
                                    }
                                    className="w-4 h-4 rounded border-border dark:border-border-dark text-primary focus:ring-primary"
                                />
                                <span className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                    Replace default footer entirely
                                </span>
                            </label>
                        </div>
                    </div>
                )}

                {/* Action Buttons */}
                <div className="flex gap-3">
                    <button
                        type="submit"
                        disabled={isPending}
                        className={cn(
                            'flex-1 py-3 rounded-lg font-medium transition-colors',
                            'bg-primary hover:bg-primary-hover text-white',
                            'disabled:opacity-50 disabled:cursor-not-allowed',
                            'flex items-center justify-center gap-2',
                        )}
                    >
                        {isPending ? (
                            <>
                                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                {t('creatingButton')}
                            </>
                        ) : (
                            <>
                                <svg
                                    className="w-5 h-5"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M12 4v16m8-8H4"
                                    />
                                </svg>
                                {t('createButton')}
                            </>
                        )}
                    </button>
                    <button
                        type="button"
                        onClick={() => router.back()}
                        disabled={isPending}
                        className={cn(
                            'px-6 py-3 rounded-lg font-medium transition-colors',
                            'bg-surface dark:bg-surface-dark',
                            'border border-border dark:border-border-dark',
                            'text-text dark:text-text-dark',
                            'hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark',
                            'disabled:opacity-50 disabled:cursor-not-allowed',
                        )}
                    >
                        {t('cancelButton')}
                    </button>
                </div>
            </form>
        </div>
    );
}
