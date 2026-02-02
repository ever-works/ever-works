import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { useSettings } from './SettingsContext';
import { Textarea } from '@/components/ui/textarea';
import { OrganizationSelector } from '../../OrganizationSelector';
import { Button } from '@/components/ui/button';

export function GeneralSettings() {
    const t = useTranslations('dashboard.directoryDetail.settings');

    const { context, handleUpdate, isPending, canEditOrganization } = useSettings();
    const { directory, formData, setFormData, user } = context;

    return (
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
                            providerId={directory.repoProvider}
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

                <Button type="submit" disabled={isPending} loading={isPending} variant="primary">
                    {t('saveChanges')}
                </Button>
            </form>
        </div>
    );
}
