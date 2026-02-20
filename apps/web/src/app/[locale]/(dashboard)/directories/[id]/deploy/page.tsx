import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { deployAPI, Directory, directoryAPI } from '@/lib/api';
import { notFound, redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { DeployForm } from '@/components/directories/detail/deploy/DeployForm';
import { DeployTokenAlert } from '@/components/directories/detail/deploy/DeployTokenAlert';
import { DeployProviderSelector } from '@/components/directories/detail/deploy/DeployProviderSelector';
import { SharedDirectoryNoTokenAlert } from '@/components/directories/detail/deploy/SharedDirectoryNoTokenAlert';
import { GenerateStatusType } from '@/lib/api/enums';
import { canDeploy } from '@/lib/permissions';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('metadata.pages');
    return { title: t('deploy') };
}

type DeployPageParams = {
    params: Promise<{ id: string }>;
};

export default async function DeployPage({ params }: DeployPageParams) {
    const { id } = await params;

    let directory: Directory;
    let deploymentCapability;

    try {
        const [res, capabilityRes] = await Promise.all([
            directoryAPI.get(id),
            deployAPI.checkDeploymentCapability(id),
        ]);
        directory = res.directory;
        deploymentCapability = capabilityRes;
    } catch (error) {
        console.error('Failed to fetch directory or deployment capability:', error);
        notFound();
    }

    // Permission & status checks OUTSIDE try-catch so Next.js
    // redirect/notFound errors propagate correctly
    if (!canDeploy(directory.userRole)) {
        notFound();
    }

    if (directory.generateStatus?.status !== GenerateStatusType.GENERATED) {
        redirect(ROUTES.DASHBOARD_DIRECTORY(id));
    }

    // Always fetch providers for the selector
    const providersRes = await deployAPI.getProviders().catch(() => null);
    const providers = providersRes?.providers ?? [];

    const providerId = directory.deployProvider || '';
    const provider = providers.find((p) => p.id === providerId);
    const providerName = provider?.name;
    const providerHomepage = provider?.homepage;

    // If no provider is selected, show just the selector
    if (!directory.deployProvider) {
        return (
            <DeployProviderSelector
                directoryId={directory.id}
                providers={providers}
                currentProviderId=""
            />
        );
    }

    // Check deployment capability based on shared/owned status
    if (!deploymentCapability.canDeploy) {
        // For shared directories, show message about owner needing to configure token
        if (deploymentCapability.isShared) {
            return <SharedDirectoryNoTokenAlert />;
        }
        // For owned directories, show the provider selector + token configuration alert
        return (
            <div className="space-y-4">
                <DeployProviderSelector
                    directoryId={directory.id}
                    providers={providers}
                    currentProviderId={providerId}
                />
                <DeployTokenAlert
                    providerId={providerId}
                    providerName={providerName}
                    providerHomepage={providerHomepage}
                />
            </div>
        );
    }

    // Hydrate existing deployment if we don't have the URL stored yet
    if (!directory.website) {
        const lookup = await deployAPI.lookupExistingDeployment(id).catch(() => null);

        if (lookup?.status === 'success' && lookup.website) {
            const refreshed = await directoryAPI.get(id).catch(() => null);
            if (refreshed?.directory) {
                directory = refreshed.directory;
            }
        }
    }

    return (
        <div className="space-y-4">
            <DeployProviderSelector
                directoryId={directory.id}
                providers={providers}
                currentProviderId={providerId}
            />
            <DeployForm
                directory={directory}
                isDeploying={isDeploying(directory)}
                providerName={providerName}
            />
        </div>
    );
}

function isDeploying(directory: Directory) {
    const hasDeploymentState = ['INITIALIZING', 'QUEUED', 'BUILDING'].includes(
        directory.deploymentState as any,
    );

    const hasStartedAt =
        directory.deploymentStartedAt &&
        new Date(directory.deploymentStartedAt) > new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago

    return Boolean(hasDeploymentState && hasStartedAt);
}
