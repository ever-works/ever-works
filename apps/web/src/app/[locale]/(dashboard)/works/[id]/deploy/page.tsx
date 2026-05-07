import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { deployAPI, Work, workAPI, type WebsiteTemplateOption } from '@/lib/api';
import { notFound, redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { DeployForm } from '@/components/works/detail/deploy/DeployForm';
import { DeployTokenAlert } from '@/components/works/detail/deploy/DeployTokenAlert';
import { DeployProviderSelector } from '@/components/works/detail/deploy/DeployProviderSelector';
import { SharedWorkNoTokenAlert } from '@/components/works/detail/deploy/SharedWorkNoTokenAlert';
import { DomainManagement } from '@/components/works/detail/deploy/DomainManagement';
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

    let work: Work;
    let deploymentCapability;
    let websiteTemplates: WebsiteTemplateOption[] = [];

    try {
        const [res, capabilityRes] = await Promise.all([
            workAPI.get(id),
            deployAPI.checkDeploymentCapability(id),
        ]);
        work = res.work;
        deploymentCapability = capabilityRes;
    } catch (error) {
        console.error('Failed to fetch Work or deployment capability:', error);
        notFound();
    }

    // Permission & status checks OUTSIDE try-catch so Next.js
    // redirect/notFound errors propagate correctly
    if (!canDeploy(work.userRole)) {
        notFound();
    }

    if (!work.websiteRepositoryInitialized && !work.website) {
        redirect(ROUTES.DASHBOARD_WORK(id));
    }

    // Always fetch providers for the selector
    const providersRes = await deployAPI.getProviders().catch(() => null);
    const providers = providersRes?.providers ?? [];

    try {
        const websiteTemplatesRes = await workAPI.getWebsiteTemplates();
        websiteTemplates = websiteTemplatesRes.templates;
    } catch {
        websiteTemplates = [];
    }

    const providerId = work.deployProvider || '';
    const provider = providers.find((p) => p.id === providerId);
    const providerName = provider?.name;
    const providerHomepage = provider?.homepage;

    // If no provider is selected, show just the selector
    if (!work.deployProvider) {
        return (
            <DeployProviderSelector workId={work.id} providers={providers} currentProviderId="" />
        );
    }

    // Check deployment capability based on shared/owned status
    if (!deploymentCapability.canDeploy) {
        // For shared works, show message about owner needing to configure token
        if (deploymentCapability.isShared) {
            return <SharedWorkNoTokenAlert />;
        }
        // For owned works, show the provider selector + token configuration alert
        return (
            <div className="space-y-4">
                <DeployProviderSelector
                    workId={work.id}
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
    if (!work.website) {
        const lookup = await deployAPI.lookupExistingDeployment(id).catch(() => null);

        if (lookup?.status === 'success' && lookup.website) {
            const refreshed = await workAPI.get(id).catch(() => null);
            if (refreshed?.work) {
                work = refreshed.work;
            }
        }
    }

    return (
        <div className="space-y-4">
            <DeployProviderSelector
                workId={work.id}
                providers={providers}
                currentProviderId={providerId}
            />
            <DeployForm
                work={work}
                isDeploying={isDeploying(work)}
                providerName={providerName}
                websiteTemplates={websiteTemplates}
            />
            {work.website && <DomainManagement work={work} />}
        </div>
    );
}

function isDeploying(work: Work) {
    const hasDeploymentState = ['INITIALIZING', 'QUEUED', 'BUILDING'].includes(
        work.deploymentState as any,
    );

    const hasStartedAt =
        work.deploymentStartedAt &&
        new Date(work.deploymentStartedAt) > new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago

    return Boolean(hasDeploymentState && hasStartedAt);
}
