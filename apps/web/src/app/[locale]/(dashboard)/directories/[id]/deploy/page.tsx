import { authAPI, deployAPI, Directory, directoryAPI } from '@/lib/api';
import { notFound, redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { DeployForm } from '@/components/directories/detail/deploy/DeployForm';
import { VercelTokenAlert } from '@/components/directories/detail/deploy/VercelTokenAlert';
import { GenerateStatusType } from '@/lib/api/enums';

type DeployPageParams = {
    params: Promise<{ id: string }>;
};

export default async function DeployPage({ params }: DeployPageParams) {
    const { id } = await params;

    let directory: Directory;
    let userProfile;

    try {
        let [res, userProfileRes] = await Promise.all([
            directoryAPI.get(id),
            authAPI.getFreshProfile(),
        ]);
        directory = res.directory;
        userProfile = userProfileRes;

        // Only allow deploy if directory is generated
        if (directory.generateStatus?.status !== GenerateStatusType.GENERATED) {
            redirect(ROUTES.DASHBOARD_DIRECTORY(id));
        }
    } catch (error) {
        console.error('Failed to fetch directory or user profile:', error);
        notFound();
    }

    // Check if user has vercel token configured
    const hasVercelToken = !!userProfile?.vercelToken;

    if (!hasVercelToken) {
        return <VercelTokenAlert />;
    }

    // Get vercel teams
    const vercelTeamsResponse = await deployAPI.getVercelTeams().catch(() => null);

    return (
        <DeployForm
            directory={directory}
            isDeploying={isDeploying(directory)}
            vercelTeams={vercelTeamsResponse?.teams || []}
        />
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
