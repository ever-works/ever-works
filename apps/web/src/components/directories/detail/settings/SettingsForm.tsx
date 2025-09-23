'use client';

import { useState, useTransition } from 'react';
import { Directory, UpdateDirectoryDto } from '@/lib/api/types-only';
import { DeleteDirectoryDto } from '@/lib/api/directory';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/navigation';
import { updateDirectory, deleteDirectory } from '@/app/actions/dashboard/directories';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';

interface SettingsFormProps {
    directory: Directory;
}

export function SettingsForm({ directory }: SettingsFormProps) {
    const router = useRouter();
    const t = useTranslations('dashboard.directoryDetail.settings');
    const [isPending, startTransition] = useTransition();

    // Check if directory can be edited (not currently generating)
    const isGenerated = directory.generateStatus !== null && directory.generateStatus !== undefined;

    const canEditOrganization = !isGenerated;

    const [formData, setFormData] = useState<UpdateDirectoryDto>({
        name: directory.name,
        description: directory.description,
        organization: directory.organization,
        owner: directory.owner || '',
        readmeConfig: directory.readmeConfig || {
            header: '',
            overwriteDefaultHeader: false,
            footer: '',
            overwriteDefaultFooter: false,
        },
    });

    const handleUpdate = async (e: React.FormEvent) => {
        e.preventDefault();

        startTransition(async () => {
            const result = await updateDirectory(directory.id, formData);

            if (result.success) {
                toast.success(result.message || t('updateSuccess'));
                router.refresh();
            } else {
                toast.error(result.error || t('updateFailed'));
            }
        });
    };

    return (
        <div className="space-y-6">
            {/* General Settings */}
            <div
                className={cn(
                    'rounded-lg border p-6',
                    'bg-card dark:bg-card-dark',
                    'border-card-border dark:border-card-border-dark',
                )}
            >
                <h3 className="text-lg font-semibold text-text dark:text-text-dark mb-4">
                    {t('generalSettings')}
                </h3>

                <form onSubmit={handleUpdate} className="space-y-4">
                    <Input
                        label={t('directoryName')}
                        type="text"
                        value={formData.name}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        variant="form"
                        required
                    />

                    <Textarea
                        label={t('description')}
                        value={formData.description}
                        onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                        rows={3}
                        variant="form"
                        required
                    />

                    {/* Organization fields */}
                    {(directory.organization || canEditOrganization || formData.organization) && (
                        <>
                            <Checkbox
                                checked={formData.organization || false}
                                onChange={(e) => {
                                    const isOrg = e.target.checked;
                                    setFormData({
                                        ...formData,
                                        organization: isOrg,
                                        owner: isOrg ? formData.owner : '',
                                    });
                                }}
                                label={t('organizationRepository')}
                                description={t('organizationHelp')}
                                variant="form"
                                disabled={!canEditOrganization}
                            />

                            {formData.organization && (
                                <Input
                                    label={t('organizationName')}
                                    type="text"
                                    value={formData.owner || ''}
                                    onChange={(e) =>
                                        setFormData({ ...formData, owner: e.target.value })
                                    }
                                    placeholder={t('organizationNamePlaceholder')}
                                    variant="form"
                                    disabled={!canEditOrganization}
                                    required={formData.organization}
                                />
                            )}
                        </>
                    )}

                    <Button
                        type="submit"
                        disabled={isPending}
                        loading={isPending}
                        variant="primary"
                    >
                        {t('saveChanges')}
                    </Button>
                </form>
            </div>

            {/* README Configuration */}
            <div
                className={cn(
                    'rounded-lg border p-6',
                    'bg-card dark:bg-card-dark',
                    'border-card-border dark:border-card-border-dark',
                )}
            >
                <h3 className="text-lg font-semibold text-text dark:text-text-dark mb-4">
                    {t('readmeConfiguration')}
                </h3>

                <div className="space-y-4">
                    <div className="space-y-3">
                        <Textarea
                            label={t('customHeader')}
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
                            placeholder={t('customHeaderPlaceholder')}
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
                            label={t('overwriteDefaultHeader')}
                            variant="form"
                        />
                    </div>

                    <div className="space-y-3">
                        <Textarea
                            label={t('customFooter')}
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
                            placeholder={t('customFooterPlaceholder')}
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
                            label={t('overwriteDefaultFooter')}
                            variant="form"
                        />
                    </div>

                    <Button
                        type="button"
                        onClick={handleUpdate}
                        disabled={isPending}
                        loading={isPending}
                        variant="secondary"
                    >
                        {t('updateReadme')}
                    </Button>
                </div>
            </div>

            {/* Danger Zone */}
            <DeleteComponent directory={directory} />
        </div>
    );
}

function DeleteComponent({ directory }: { directory: Directory }) {
    const t = useTranslations('dashboard.directoryDetail.settings');
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [deleteOptions, setDeleteOptions] = useState<DeleteDirectoryDto>({
        delete_data_repository: false,
        delete_markdown_repository: false,
        delete_website_repository: false,
    });

    const handleDelete = async () => {
        if (!showDeleteConfirm) {
            setShowDeleteConfirm(true);
            return;
        }

        startTransition(async () => {
            const result = await deleteDirectory(directory.id, deleteOptions);

            if (result.success) {
                toast.success(result.message || t('deleteSuccess'));
                router.push(ROUTES.DASHBOARD_DIRECTORIES);
            } else {
                toast.error(result.error || t('deleteFailed'));
            }
        });
    };
    return (
        <div
            className={cn(
                'rounded-lg border-2 p-6',
                'bg-red-50 dark:bg-red-950/30',
                'border-red-200 dark:border-red-900',
            )}
        >
            <div className="mb-4">
                <h3 className="text-lg font-semibold text-red-800 dark:text-red-200 mb-2">
                    {t('dangerZone')}
                </h3>
                <p className="text-sm text-red-700 dark:text-red-300">{t('deleteWarning')}</p>
            </div>

            {showDeleteConfirm ? (
                <div className="space-y-4">
                    {/* Repository deletion options */}
                    <div className="bg-card dark:bg-card-dark border border-card-border dark:border-card-border-dark rounded-lg p-4">
                        <p className="text-sm font-medium text-red-800 dark:text-red-200 mb-3">
                            {t('deleteOptions')}
                        </p>
                        <div className="space-y-2">
                            <Checkbox
                                checked={deleteOptions.delete_data_repository || false}
                                onChange={(e) =>
                                    setDeleteOptions({
                                        ...deleteOptions,
                                        delete_data_repository: e.target.checked,
                                    })
                                }
                                label={t('deleteDataRepository')}
                                description={t('deleteDataRepositoryDescription')}
                                variant="form"
                            />
                            <Checkbox
                                checked={deleteOptions.delete_markdown_repository || false}
                                onChange={(e) =>
                                    setDeleteOptions({
                                        ...deleteOptions,
                                        delete_markdown_repository: e.target.checked,
                                    })
                                }
                                label={t('deleteMarkdownRepository')}
                                description={t('deleteMarkdownRepositoryDescription')}
                                variant="form"
                            />
                            <Checkbox
                                checked={deleteOptions.delete_website_repository || false}
                                onChange={(e) =>
                                    setDeleteOptions({
                                        ...deleteOptions,
                                        delete_website_repository: e.target.checked,
                                    })
                                }
                                label={t('deleteWebsiteRepository')}
                                description={t('deleteWebsiteRepositoryDescription')}
                                variant="form"
                            />
                        </div>
                    </div>

                    {/* Confirmation section */}
                    <div className="bg-red-200/50 dark:bg-red-900/30 border border-red-300 dark:border-red-800 rounded-lg p-4">
                        <p className="text-sm font-medium text-red-900 dark:text-red-100 mb-2">
                            {t('deleteConfirm')}
                        </p>
                        <p className="text-xs text-red-800 dark:text-red-200 mb-4">
                            {t('deleteConfirmDetail')}
                        </p>
                        <div className="flex items-center gap-3">
                            <Button
                                onClick={handleDelete}
                                disabled={isPending}
                                loading={isPending}
                                variant="danger"
                                className="bg-red-600 hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-800"
                            >
                                {t('deleteConfirmButton')}
                            </Button>
                            <Button
                                onClick={() => {
                                    setShowDeleteConfirm(false);
                                    setDeleteOptions({
                                        delete_data_repository: false,
                                        delete_markdown_repository: false,
                                        delete_website_repository: false,
                                    });
                                }}
                                disabled={isPending}
                                variant="ghost"
                                className="bg-white dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-300 dark:border-gray-600"
                            >
                                {t('cancel')}
                            </Button>
                        </div>
                    </div>
                </div>
            ) : (
                <Button
                    onClick={handleDelete}
                    disabled={isPending}
                    variant="danger"
                    className="bg-red-600 hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-800"
                >
                    {t('deleteButton')}
                </Button>
            )}
        </div>
    );
}
