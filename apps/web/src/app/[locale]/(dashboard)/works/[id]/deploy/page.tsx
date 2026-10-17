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
import { RuntimeEnvManagement } from '@/components/works/detail/deploy/RuntimeEnvManagement';
import { SubdomainManagement } from '@/components/works/detail/deploy/SubdomainManagement';
import { DeployProgressPanel } from '@/components/works/detail/deploy/DeployProgressPanel';
import { canDeploy } from '@/lib/permissions';
import { isAppWorkKind } from '@ever-works/contracts';
import { appRuntimeAPI } from '@/lib/api/app-runtime';
import { deriveAppTargetFromProvider, type AppTargetView } from '@/lib/api/app-runtime.types';
import { AppDeployPage } from '@/components/works/detail/deploy/app/AppDeployPage';

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
        // The website capability check means nothing for an App Work (it has
        // no website deploy provider or token), so its failure must not 404
        // the App branch. For every other kind it still fails the page exactly
        // as before: the settled error is rethrown into this same catch.
        const [res, capabilitySettled] = await Promise.all([
            workAPI.get(id),
            deployAPI.checkDeploymentCapability(id).then(
                (value) => ({ ok: true as const, value }),
                (error: unknown) => ({ ok: false as const, error }),
            ),
        ]);
        work = res.work;
        if (capabilitySettled.ok) {
            deploymentCapability = capabilitySettled.value;
        } else if (!isAppWorkKind(work.kind)) {
            throw capabilitySettled.error;
        }
    } catch (error) {
        console.error('Failed to fetch Work or deployment capability:', error);
        notFound();
    }

    // Permission & status checks OUTSIDE try-catch so Next.js
    // redirect/notFound errors propagate correctly
    if (!canDeploy(work.userRole)) {
        notFound();
    }

    // APW-06 T37 — an App Work deploys its built image to a cluster, not a
    // generated website: it has no website repository to wait for, no website
    // deploy provider and no provider token. Its own branch renders here,
    // before the website-repository redirect, and every other kind continues
    // below exactly as before.
    if (isAppWorkKind(work.kind)) {
        // A failed read never 404s the tab: the target falls back to the one
        // derived from `deployProvider`, and the status to "not running".
        const [appTarget, appStatus] = await Promise.all([
            appRuntimeAPI.getAppTarget(id, work.deployProvider).catch(
                (): AppTargetView => ({
                    target: deriveAppTargetFromProvider(work.deployProvider),
                    settings: null,
                    namespace: null,
                    clusterCheck: null,
                    clusterCheckedAt: null,
                    eligibility: null,
                    routeAvailable: false,
                }),
            ),
            appRuntimeAPI.getAppStatus(id).catch(() => null),
        ]);
        return (
            <AppDeployPage
                work={{ id: work.id, slug: work.slug, name: work.name }}
                initialTarget={appTarget}
                status={appStatus}
                canEdit={canDeploy(work.userRole)}
            />
        );
    }

    // Only an App Work may arrive here without a capability answer, and it
    // returned above; this keeps the website path's invariant explicit.
    if (!deploymentCapability) {
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
            <DeployProgressPanel workId={work.id} isDeploying={isDeploying(work)} />
            {/*
             * EW-740 — Managed subdomain card. Per spec section 4.6 the
             * managed `*.ever.works` subdomain is the primary/default
             * address, so it renders ABOVE `DomainManagement` (which lists
             * additional custom domains). Only relevant for the
             * managed-subdomain providers (`ever-works`, `k8s`); for
             * Vercel/etc the API returns `editable=false` + null state,
             * which the component handles, but we skip the card entirely
             * to avoid wasted requests + UI noise.
             */}
            {work.id && (work.deployProvider === 'ever-works' || work.deployProvider === 'k8s') && (
                <SubdomainManagement work={work} />
            )}
            {work.website && <DomainManagement work={work} />}
            {work.website && <RuntimeEnvManagement work={work} />}
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
