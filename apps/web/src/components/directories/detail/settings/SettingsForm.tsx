'use client';

import { useState, useTransition } from 'react';
import { Directory, UpdateDirectoryDto } from '@/lib/api/types-only';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/navigation';
import { updateDirectory } from '@/app/actions/dashboard/directories';
import { useTranslations } from 'next-intl';
import { AuthUser } from '@/lib/auth';
import { OrganizationSelector } from '../../OrganizationSelector';
import { DeleteComponent } from './DeleteComponent';

interface SettingsFormProps {
    directory: Directory;
    user: AuthUser;
}

export function SettingsForm({ directory, user }: SettingsFormProps) {
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
                                disabled={isPending || !canEditOrganization}
                            />
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
