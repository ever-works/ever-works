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
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { OrganizationSelector } from './OrganizationSelector';
import { ChevronDown, Plus } from 'lucide-react';

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

                if (result.directory) {
                    router.push(ROUTES.DASHBOARD_DIRECTORY(result.directory.id));
                } else {
                    router.push(ROUTES.DASHBOARD_DIRECTORIES);
                }
            } else if (result.requiresGitHub) {
                toast.error(result.error || t('githubRequired'));
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
                        <Input
                            label={t('nameLabel')}
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
                            variant="form"
                            required
                        />

                        {/* Slug */}
                        <Input
                            label={t('slugLabel')}
                            type="text"
                            value={formData.slug}
                            onChange={(e) => setFormData({ ...formData, slug: e.target.value })}
                            placeholder={t('slugPlaceholder')}
                            pattern="[a-z0-9-]+"
                            helperText={t('slugHelp')}
                            variant="form"
                            required
                        />

                        {/* Description */}
                        <Textarea
                            label={t('descriptionLabel')}
                            value={formData.description}
                            onChange={(e) =>
                                setFormData({ ...formData, description: e.target.value })
                            }
                            placeholder={t('descriptionPlaceholder')}
                            rows={3}
                            variant="form"
                            required
                        />
                    </div>
                </div>

                {/* Advanced Fields Toggle */}
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
                    <div
                        className={cn(
                            'p-6 rounded-lg space-y-4',
                            'bg-card dark:bg-card-dark',
                            'border border-card-border dark:border-card-border-dark',
                        )}
                    >
                        {/* Organization Selector */}
                        <OrganizationSelector
                            value={formData.owner || ''}
                            authId={user.sub}
                            onChange={(value, isOrganization) => {
                                setFormData({
                                    ...formData,
                                    owner: value,
                                    organization: isOrganization,
                                });
                            }}
                            disabled={isPending}
                        />

                        {/* README Header */}
                        <div className="space-y-3">
                            <Textarea
                                label={t('headerLabel')}
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
                                variant="form"
                            />
                            <Checkbox
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
                                label={t('headerOverwrite')}
                                variant="form"
                            />
                        </div>

                        {/* README Footer */}
                        <div className="space-y-3">
                            <Textarea
                                label={t('footerLabel')}
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
                                placeholder={t('footerPlaceholder')}
                                rows={3}
                                variant="form"
                            />
                            <Checkbox
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
                                label={t('footerOverwrite')}
                                variant="form"
                            />
                        </div>
                    </div>
                )}

                {/* Action Buttons */}
                <div className="flex gap-3">
                    <Button
                        type="submit"
                        disabled={isPending}
                        loading={isPending}
                        variant="primary"
                        size="lg"
                        fullWidth
                    >
                        {isPending ? (
                            t('creatingButton')
                        ) : (
                            <>
                                <Plus className="w-5 h-5" />
                                {t('createButton')}
                            </>
                        )}
                    </Button>
                    <Button
                        type="button"
                        onClick={() => router.back()}
                        disabled={isPending}
                        variant="secondary"
                        size="lg"
                        className="px-6"
                    >
                        {t('cancelButton')}
                    </Button>
                </div>
            </form>
        </div>
    );
}
