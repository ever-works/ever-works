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
                'rounded-lg border overflow-hidden',
                'bg-card dark:bg-card-primary-dark/30',
                'border-card-border dark:border-card-border-dark',
            )}
        >
            <div className="px-5 py-3.5 border-b border-card-border dark:border-card-border-dark">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('generalSettings')}
                </h3>
            </div>

            <form onSubmit={handleUpdate} className="px-5 py-4 space-y-4">
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
                            providerId={directory.gitProvider}
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
                    size="sm"
                    disabled={isPending}
                    loading={isPending}
                    variant="primary"
                >
                    {t('saveChanges')}
                </Button>
            </form>
        </div>
    );
}
