'use client';

import { useState, useTransition } from 'react';
import { AuthUser } from '@/lib/auth';
import { cn } from '@/lib/utils/cn';
import { toast } from 'sonner';
import type { CreateDirectoryDto } from '@/lib/api/directory';
import { createDirectory } from '@/app/actions/dashboard';
import { ROUTES } from '@/lib/constants';
import { useRouter } from '@/i18n/navigation';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { RepositoryOwnerCard } from './RepositoryOwnerCard';
import { Plus } from 'lucide-react';

interface DirectoryManualFormProps {
    user: AuthUser;
    gitProvider?: string;
    gitConnected?: boolean;
    deployProvider?: string;
}

export function DirectoryManualForm({
    user,
    gitProvider,
    gitConnected,
    deployProvider,
}: DirectoryManualFormProps) {
    const [isPending, startTransition] = useTransition();
    const router = useRouter();
    const t = useTranslations('dashboard.directoryCreation.manual');

    // Form state - gitProvider is determined automatically by backend
    const [formData, setFormData] = useState<CreateDirectoryDto>({
        slug: '',
        name: '',
        description: '',
        organization: false,
        owner: '',
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
            const result = await createDirectory({ ...formData, gitProvider, deployProvider });

            if (result.success) {
                toast.success(result.message || t('success.created'));

                if (result.directory) {
                    router.push(ROUTES.DASHBOARD_DIRECTORY(result.directory.id));
                } else {
                    router.push(ROUTES.DASHBOARD_DIRECTORIES);
                }
            } else if (result.requiresGitProvider) {
                toast.error(result.error || 'Git provider connection required');
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

            <form onSubmit={handleSubmit} className="space-y-6" autoComplete="off">
                {/* Basic Fields */}
                <div
                    className={cn(
                        'p-6 rounded-lg',
                        'bg-card dark:bg-transparent',
                        'border border-card-border dark:border-border-secondary-dark',
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

                {/* Repository Owner */}
                <RepositoryOwnerCard
                    gitProvider={gitProvider}
                    gitConnected={gitConnected}
                    owner={formData.owner || ''}
                    onChange={(value, isOrganization) => {
                        setFormData({
                            ...formData,
                            owner: value,
                            organization: isOrganization,
                        });
                    }}
                    disabled={isPending}
                />

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
