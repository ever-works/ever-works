import { deployAPI, Directory, directoryAPI } from '@/lib/api';
import { notFound, redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { DeployForm } from '@/components/directories/detail/deploy/DeployForm';
import { DeployTokenAlert } from '@/components/directories/detail/deploy/DeployTokenAlert';
import { SharedDirectoryNoTokenAlert } from '@/components/directories/detail/deploy/SharedDirectoryNoTokenAlert';
import { GenerateStatusType } from '@/lib/api/enums';
import { canDeploy } from '@/lib/permissions';

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

        // Server-side permission check: only editors+ can deploy
        if (!canDeploy(directory.userRole)) {
            notFound();
        }

        // Only allow deploy if directory is generated
        if (directory.generateStatus?.status !== GenerateStatusType.GENERATED) {
            redirect(ROUTES.DASHBOARD_DIRECTORY(id));
        }
    } catch (error) {
        console.error('Failed to fetch directory or deployment capability:', error);
        notFound();
    }

    // Check deployment capability based on shared/owned status
    if (!deploymentCapability.canDeploy) {
        // For shared directories, show message about owner needing to configure token
        if (deploymentCapability.isShared) {
            return <SharedDirectoryNoTokenAlert />;
        }
        // For owned directories, show the regular token configuration alert
        // Pass the directory's deploy provider if set, default to 'vercel'
        return <DeployTokenAlert providerId={directory.deployProvider || 'vercel'} />;
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

    return <DeployForm directory={directory} isDeploying={isDeploying(directory)} />;
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
