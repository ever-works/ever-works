'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import type { Directory, WebsiteTemplateOption } from '@/lib/api';
import { cn } from '@/lib/utils/cn';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Link, useRouter } from '@/i18n/navigation';
import {
    deploy,
    getDeploymentTeams,
    lookupExistingDeployment,
    switchWebsiteTemplate,
    updateWebsiteRepository,
    updateWebsiteTemplateSettings,
} from '@/app/actions/dashboard/deploy';
import { RefreshCw, Info, Loader2, Triangle, Settings2, AlertCircle } from 'lucide-react';
import { useDirectoryDetail } from '../DirectoryDetailContext';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { pageIntervalRefresh } from '@/lib/utils';
import { TeamSelectionDialog, type DeployTeam } from './TeamSelectionDialog';
import { DeployConfigDialog, type DeployConfigData } from './DeployConfigDialog';
import { updateWebsiteSettings } from '@/app/actions/dashboard/directories';
import { formatDistanceToNow } from 'date-fns';
import { WebsiteTemplateSelector } from '@/components/directories/shared/WebsiteTemplateSelector';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

interface DeployFormProps {
    directory: Directory;
    isDeploying?: boolean;
    providerName?: string;
    websiteTemplates?: WebsiteTemplateOption[];
}

export function DeployForm({
    directory,
    isDeploying,
    providerName,
    websiteTemplates = [],
}: DeployFormProps) {
    const t = useTranslations('dashboard.directoryDetail.deploy');
    const [isPending, startTransition] = useTransition();
    const router = useRouter();
    const [isConfigDialogOpen, setIsConfigDialogOpen] = useState(false);
    const [isTeamDialogOpen, setIsTeamDialogOpen] = useState(false);
    const [deployTeams, setDeployTeams] = useState<DeployTeam[]>([]);

    const hasDeployTeams = deployTeams.length > 0;
    const setHasCheckedExisting = useRef(false);

    useEffect(() => {
        if (isDeploying) {
            const cleanup = pageIntervalRefresh(router);
            return cleanup;
        }
    }, [isDeploying, router]);

    useEffect(() => {
        // Fetch teams using the directory-specific endpoint
        // This uses the user's plugin settings token
        getDeploymentTeams(directory.id).then((res) => {
            setDeployTeams(res.teams || []);
        });
    }, [directory.id]);

    useEffect(() => {
        if (directory.website || setHasCheckedExisting.current) {
            return;
        }

        setHasCheckedExisting.current = true;
        startTransition(async () => {
            const result = await lookupExistingDeployment(directory.id).catch(() => null);
            if (result?.success && result.website) {
                router.refresh();
            }
        });
    }, [directory.id, directory.website, router]);

    const runDeploy = (teamScope?: string) => {
        startTransition(async () => {
            try {
                const result = await deploy(directory.id, teamScope);

                if (result.success && result.data) {
                    if (result.data.status === 'pending') {
                        toast.info(t('form.messages.deployPending'));
                        setTimeout(() => router.refresh(), 3000);
                    } else if (result.data.status === 'success') {
                        toast.success(t('form.messages.deploySuccess'));
                    }
                } else {
                    toast.error(result.error || t('form.messages.deployFailed'));
                }
            } catch (error) {
                console.error('Deployment failed:', error);
                toast.error(t('form.messages.deployError'));
            }
        });
    };

    const handleDeployClick = () => {
        if (isPending || isDeploying) {
            return;
        }

        // Show config dialog first
        setIsConfigDialogOpen(true);
    };

    const handleConfigConfirm = async (settings: DeployConfigData | null) => {
        setIsConfigDialogOpen(false);

        // Save settings if provided (user clicked "Save & Deploy")
        if (settings) {
            startTransition(async () => {
                try {
                    const result = await updateWebsiteSettings(directory.id, {
                        company_name: settings.company_name,
                        company_website: settings.company_website,
                        ...settings.settings,
                        custom_menu: settings.custom_menu,
                    });

                    if (!result.success) {
                        toast.error(result.error || t('form.messages.saveSettingsFailed'));
                        return;
                    }
                } catch (error) {
                    console.error('Failed to save settings:', error);
                    toast.error(t('form.messages.saveSettingsBeforeDeploymentFailed'));
                    return;
                }

                // Proceed to team selection or direct deploy
                proceedToDeploy();
            });
        } else {
            // User clicked "Skip & Deploy" - proceed without saving
            proceedToDeploy();
        }
    };

    const proceedToDeploy = () => {
        if (hasDeployTeams) {
            setIsTeamDialogOpen(true);
        } else {
            runDeploy();
        }
    };

    const handleConfirmDeploy = (teamScope: string) => {
        setIsTeamDialogOpen(false);
        runDeploy(teamScope);
    };

    return (
        <div className="space-y-6">
            <DeployConfigDialog
                open={isConfigDialogOpen}
                directoryId={directory.id}
                isSubmitting={isPending || isDeploying}
                onConfirm={handleConfigConfirm}
                onCancel={() => setIsConfigDialogOpen(false)}
            />

            <TeamSelectionDialog
                open={isTeamDialogOpen}
                teams={deployTeams}
                isSubmitting={isPending || isDeploying}
                providerName={providerName}
                onConfirm={handleConfirmDeploy}
                onCancel={() => setIsTeamDialogOpen(false)}
            />

            {/* Deploy Section */}
            <div className="rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark p-6">
                <div className="flex items-start gap-4">
                    <div
                        className={cn(
                            'shrink-0 w-10 h-10 rounded-full flex items-center justify-center',
                            'bg-primary/10 dark:bg-primary-dark/10',
                        )}
                    >
                        <Triangle className="w-5 h-5 text-primary dark:text-primary-dark fill-current" />
                    </div>

                    <div className="flex-1">
                        <h3 className="text-lg font-semibold text-text dark:text-text-dark mb-2">
                            {t('form.deployment.title')}
                        </h3>
                        <p className="text-text-secondary dark:text-text-secondary-dark mb-4">
                            {t('form.deployment.description')}
                        </p>

                        {directory.website && (
                            <div className="mb-4 p-4 rounded-lg bg-success/10 dark:bg-success-dark/10 border border-success/20 dark:border-success-dark/20">
                                {directory.deploymentState === 'READY' && (
                                    <p className="text-sm text-success dark:text-success-dark mb-2">
                                        {t('form.deployment.successMessage')}
                                    </p>
                                )}

                                <a
                                    href={directory.website}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-sm text-primary dark:text-primary-dark hover:underline break-all"
                                >
                                    {directory.website}
                                </a>
                            </div>
                        )}

                        <Button
                            onClick={handleDeployClick}
                            disabled={isPending || isDeploying}
                            size="lg"
                        >
                            {isPending || isDeploying ? (
                                <span className="flex items-center gap-2 capitalize">
                                    <Loader2 className="animate-spin h-4 w-4" />

                                    {isDeploying
                                        ? t('form.deployment.deployingStateButton', {
                                              state: (
                                                  directory.deploymentState || 'INITIALIZING'
                                              ).toLowerCase(),
                                          })
                                        : t('form.deployment.deployButton', {
                                              provider: providerName || 'Provider',
                                          })}
                                </span>
                            ) : (
                                t('form.deployment.deployButton', {
                                    provider: providerName || 'Provider',
                                })
                            )}
                        </Button>
                    </div>
                </div>
            </div>

            {/* Update Repository Section */}
            <UpdateWebsiteRepository directory={directory} />

            {/* Website Template Settings Section */}
            <WebsiteTemplateSettings directory={directory} websiteTemplates={websiteTemplates} />

            {/* Info Section */}
            <div className="p-6 rounded-lg bg-info/5 dark:bg-info-dark/5 border border-info/20 dark:border-info-dark/20 hidden">
                <div className="flex gap-3">
                    <Info className="shrink-0 w-5 h-5 text-info dark:text-info-dark mt-0.5" />
                    <div className="space-y-2 text-sm text-text-secondary dark:text-text-secondary-dark">
                        <p>{t('form.info.deployInfo')}</p>
                        <p>{t('form.info.updateInfo')}</p>
                    </div>
                </div>
            </div>
        </div>
    );
}

function UpdateWebsiteRepository({ directory }: DeployFormProps) {
    const t = useTranslations('dashboard.directoryDetail.deploy');
    const { repoLinks } = useDirectoryDetail();
    const [isPending, startTransition] = useTransition();
    const router = useRouter();

    const handleUpdateRepository = () => {
        startTransition(async () => {
            try {
                const result = await updateWebsiteRepository(directory.id);

                if (result.success) {
                    toast.success(t('form.messages.updateSuccess'));
                    router.refresh();
                } else {
                    toast.error(result.error || t('form.messages.updateFailed'));
                }
            } catch (error) {
                console.error('Update repository failed:', error);
                toast.error(t('form.messages.updateError'));
            }
        });
    };

    return (
        <div className="rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark p-6">
            <div className="flex items-start gap-4">
                <div
                    className={cn(
                        'shrink-0 w-10 h-10 rounded-full flex items-center justify-center',
                        'bg-info/10 dark:bg-info-dark/10',
                    )}
                >
                    <RefreshCw className="w-5 h-5 text-info dark:text-info-dark" />
                </div>
                <div className="flex-1">
                    <h3 className="text-lg font-semibold text-text dark:text-text-dark mb-2">
                        {t('form.updateRepository.title')}
                    </h3>
                    <p className="text-text-secondary dark:text-text-secondary-dark mb-4">
                        {t('form.updateRepository.description')}{' '}
                        <Link
                            href={repoLinks?.websiteRepo || '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:text-primary-hover"
                        >
                            {t('form.updateRepository.websiteRepository')}
                        </Link>
                    </p>

                    <Button
                        onClick={handleUpdateRepository}
                        disabled={isPending}
                        variant="secondary"
                    >
                        {isPending
                            ? t('form.updateRepository.updatingButton')
                            : t('form.updateRepository.updateButton')}
                    </Button>
                </div>
            </div>
        </div>
    );
}

function WebsiteTemplateSettings({
    directory,
    websiteTemplates = [],
}: Pick<DeployFormProps, 'directory' | 'websiteTemplates'>) {
    const t = useTranslations('dashboard.directoryDetail.deploy');
    const [isPending, startTransition] = useTransition();
    const router = useRouter();
    const [autoUpdate, setAutoUpdate] = useState(directory.websiteTemplateAutoUpdate ?? false);
    const [useBeta, setUseBeta] = useState(directory.websiteTemplateUseBeta ?? false);
    const [selectedTemplateId, setSelectedTemplateId] = useState(
        directory.websiteTemplateId ||
            websiteTemplates.find((template) => template.isDefault)?.id ||
            '',
    );
    const [confirmSwitchOpen, setConfirmSwitchOpen] = useState(false);

    const handleAutoUpdateChange = (checked: boolean) => {
        setAutoUpdate(checked);
        startTransition(async () => {
            try {
                const result = await updateWebsiteTemplateSettings(directory.id, {
                    websiteTemplateAutoUpdate: checked,
                });

                if (result.success) {
                    toast.success(t('form.websiteTemplate.updateSuccess'));
                    router.refresh();
                } else if ('requiresGitProvider' in result && result.requiresGitProvider) {
                    setAutoUpdate(!checked); // Revert on failure
                    toast.error(result.error || 'Git provider connection required');
                } else {
                    setAutoUpdate(!checked); // Revert on failure
                    toast.error(result.error || t('form.websiteTemplate.updateFailed'));
                }
            } catch (error) {
                setAutoUpdate(!checked); // Revert on failure
                console.error('Update auto-update setting failed:', error);
                toast.error(t('form.websiteTemplate.updateFailed'));
            }
        });
    };

    const handleUseBetaChange = (checked: boolean) => {
        setUseBeta(checked);
        startTransition(async () => {
            try {
                const result = await updateWebsiteTemplateSettings(directory.id, {
                    websiteTemplateUseBeta: checked,
                });

                if (result.success) {
                    toast.success(t('form.websiteTemplate.updateSuccess'));
                    router.refresh();
                } else {
                    setUseBeta(!checked); // Revert on failure
                    toast.error(result.error || t('form.websiteTemplate.updateFailed'));
                }
            } catch (error) {
                setUseBeta(!checked); // Revert on failure
                console.error('Update use beta setting failed:', error);
                toast.error(t('form.websiteTemplate.updateFailed'));
            }
        });
    };

    const formatDate = (dateString: string | null | undefined) => {
        if (!dateString) return null;
        try {
            return formatDistanceToNow(new Date(dateString), { addSuffix: true });
        } catch {
            return null;
        }
    };

    const lastUpdated = formatDate(directory.websiteTemplateLastUpdatedAt);
    const lastChecked = formatDate(directory.websiteTemplateLastCheckedAt);
    const hasError = Boolean(directory.websiteTemplateLastError);
    const selectedTemplate =
        websiteTemplates.find((template) => template.id === selectedTemplateId) ||
        websiteTemplates.find((template) => template.isDefault);
    const currentTemplate =
        websiteTemplates.find((template) => template.id === directory.websiteTemplateId) ||
        websiteTemplates.find((template) => template.isDefault);
    const hasTemplateChange =
        Boolean(selectedTemplateId) && selectedTemplateId !== directory.websiteTemplateId;

    const handleSwitchTemplate = () => {
        if (!hasTemplateChange || !selectedTemplateId) {
            return;
        }

        startTransition(async () => {
            try {
                const result = await switchWebsiteTemplate(directory.id, selectedTemplateId);

                if (result.success && result.data) {
                    toast.success(result.data.message || t('form.websiteTemplate.updateSuccess'));
                    setConfirmSwitchOpen(false);
                    router.refresh();
                } else {
                    toast.error(result.error || t('form.websiteTemplate.updateFailed'));
                }
            } catch (error) {
                console.error('Switch website template failed:', error);
                toast.error(t('form.websiteTemplate.updateFailed'));
            }
        });
    };

    return (
        <div className="rounded-lg bg-surface dark:bg-surface-dark border border-border dark:border-border-dark p-6">
            <Dialog open={confirmSwitchOpen} onOpenChange={setConfirmSwitchOpen}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle>
                            {t('form.websiteTemplate.switchConfirmTitle', {
                                defaultValue: 'Switch website template?',
                            })}
                        </DialogTitle>
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('form.websiteTemplate.switchConfirmDescription', {
                                defaultValue:
                                    'If the website repository already exists, its contents will be replaced from the selected template. Any custom code in that repository will be lost.',
                            })}
                        </p>
                    </DialogHeader>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => setConfirmSwitchOpen(false)}
                            disabled={isPending}
                        >
                            {t('form.websiteTemplate.switchCancel', { defaultValue: 'Cancel' })}
                        </Button>
                        <Button
                            type="button"
                            variant="danger"
                            size="sm"
                            onClick={handleSwitchTemplate}
                            disabled={isPending}
                            loading={isPending}
                        >
                            {t('form.websiteTemplate.switchConfirmButton', {
                                defaultValue: 'Switch template',
                            })}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <div className="flex items-start gap-4">
                <div
                    className={cn(
                        'shrink-0 w-10 h-10 rounded-full flex items-center justify-center',
                        'bg-accent/10 dark:bg-accent-dark/10',
                    )}
                >
                    <Settings2 className="w-5 h-5 text-accent dark:text-accent-dark" />
                </div>
                <div className="flex-1">
                    <h3 className="text-lg font-semibold text-text dark:text-text-dark mb-2">
                        {t('form.websiteTemplate.title')}
                    </h3>
                    <p className="text-text-secondary dark:text-text-secondary-dark mb-4">
                        {t('form.websiteTemplate.description')}
                    </p>

                    <div className="space-y-4">
                        <WebsiteTemplateSelector
                            templates={websiteTemplates}
                            value={selectedTemplateId}
                            onChange={setSelectedTemplateId}
                            disabled={isPending}
                            label={t('form.websiteTemplate.selectorLabel', {
                                defaultValue: 'Website template',
                            })}
                            helperText={
                                hasTemplateChange
                                    ? t('form.websiteTemplate.switchHelperText', {
                                          defaultValue:
                                              'Applying a new template will reset the existing website repository from the selected template if it already exists.',
                                      })
                                    : t('form.websiteTemplate.currentHelperText', {
                                          defaultValue:
                                              'The selected template controls how the website repository is initialized and updated.',
                                      })
                            }
                        />

                        <div className="rounded-lg border border-border dark:border-border-dark p-4 bg-card dark:bg-card-primary-dark/20">
                            <p className="text-sm font-medium text-text dark:text-text-dark">
                                {t('form.websiteTemplate.currentTemplateLabel', {
                                    defaultValue: 'Current template',
                                })}
                            </p>
                            <p className="mt-1 text-sm text-text dark:text-text-dark">
                                {currentTemplate?.name || directory.websiteTemplateId}
                            </p>
                            <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                                {currentTemplate?.description}
                            </p>
                        </div>

                        <div className="flex justify-end">
                            <Button
                                type="button"
                                variant={hasTemplateChange ? 'danger' : 'secondary'}
                                size="sm"
                                disabled={!hasTemplateChange || isPending}
                                onClick={() => setConfirmSwitchOpen(true)}
                            >
                                {hasTemplateChange
                                    ? t('form.websiteTemplate.switchAction', {
                                          defaultValue: 'Apply template to website repository',
                                      })
                                    : t('form.websiteTemplate.switchActionIdle', {
                                          defaultValue: 'Template is up to date',
                                      })}
                            </Button>
                        </div>

                        <Switch
                            checked={autoUpdate}
                            onChange={handleAutoUpdateChange}
                            disabled={isPending}
                            label={t('form.websiteTemplate.autoUpdate')}
                            helperText={t('form.websiteTemplate.autoUpdateDescription')}
                        />

                        <Switch
                            checked={useBeta}
                            onChange={handleUseBetaChange}
                            disabled={isPending}
                            label={t('form.websiteTemplate.useBeta')}
                            helperText={t('form.websiteTemplate.useBetaDescription')}
                        />

                        {/* Status display */}
                        {(lastUpdated || lastChecked) && (
                            <div className="mt-4 pt-4 border-t border-border dark:border-border-dark">
                                <div className="text-sm text-text-secondary dark:text-text-secondary-dark space-y-1">
                                    {lastUpdated && (
                                        <p>
                                            <span className="font-medium">
                                                {t('form.websiteTemplate.lastUpdated')}:
                                            </span>{' '}
                                            {lastUpdated}
                                        </p>
                                    )}
                                    {lastChecked && (
                                        <p>
                                            <span className="font-medium">
                                                {t('form.websiteTemplate.lastChecked')}:
                                            </span>{' '}
                                            {lastChecked}
                                        </p>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Error display */}
                        {hasError && (
                            <div className="mt-4 p-3 rounded-lg bg-error/10 dark:bg-error-dark/10 border border-error/20 dark:border-error-dark/20">
                                <div className="flex gap-2 items-start">
                                    <AlertCircle className="shrink-0 w-4 h-4 text-error dark:text-error-dark mt-0.5" />
                                    <div>
                                        <p className="text-sm font-medium text-error dark:text-error-dark">
                                            {t('form.websiteTemplate.lastError')}
                                        </p>
                                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1">
                                            {directory.websiteTemplateLastError}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
