'use server';

import { workAPI, websiteAPI, deployAPI } from '@/lib/api';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { getTranslations } from 'next-intl/server';
import { checkGitProviderConnection } from './oauth';
import { revalidatePath } from 'next/cache';

export async function deploy(workId: string, teamScope?: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('actions.deploy');
    const tWorks = await getTranslations('actions.works');

    try {
        const { work } = await workAPI.get(workId);

        // Check git provider connection
        const connectionCheck = await checkGitProviderConnection(work.gitProvider);
        if (!connectionCheck.connected) {
            return {
                success: false,
                error: tWorks('oauthRequired', { provider: work.gitProvider }),
                requiresGitProvider: true,
            };
        }

        const response = await deployAPI.deploy(workId, {
            teamScope,
        });

        revalidatePath(ROUTES.DASHBOARD_WORK_DEPLOY(workId));

        return {
            success: response.status === 'success' || response.status === 'pending',
            data: response,
            error: response.status === 'error' ? response.message : null,
        };
    } catch (error) {
        console.error('Deploy error:', error);
        return {
            success: false,
            data: null,
            error: error instanceof Error ? error.message : t('deployFailed'),
        };
    }
}

export async function updateWebsiteRepository(workId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('actions.deploy');

    try {
        const response = await websiteAPI.updateRepository(workId);
        return {
            success: response.status === 'success',
            data: response,
            error: response.status === 'error' ? response.message : null,
        };
    } catch (error) {
        console.error('Update repository error:', error);
        return {
            success: false,
            data: null,
            error: error instanceof Error ? error.message : t('updateRepositoryFailed'),
        };
    }
}

export async function switchWebsiteTemplate(workId: string, websiteTemplateId: string | null) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('actions.deploy');

    try {
        const normalizedTemplateId = websiteTemplateId?.trim() || null;
        const response = await websiteAPI.switchTemplate(workId, normalizedTemplateId);
        revalidatePath(ROUTES.DASHBOARD_WORK_DEPLOY(workId));

        return {
            success: response.status === 'success',
            data: response,
            error: response.status === 'error' ? response.message : null,
        };
    } catch (error) {
        console.error('Switch website template error:', error);
        return {
            success: false,
            data: null,
            error: error instanceof Error ? error.message : t('updateRepositoryFailed'),
        };
    }
}

export async function getDeploymentTeams(workId?: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        // If workId is provided, use the work-specific endpoint
        // which retrieves the token from plugin settings
        const response = workId
            ? await deployAPI.getTeamsForWork(workId)
            : await deployAPI.getDeploymentTeams();
        return {
            success: response.status === 'success',
            teams: response.status === 'success' ? response.teams : [],
        };
    } catch (error) {
        console.error('Get deployment teams error:', error);
        return {
            success: false,
            teams: [],
            error: error instanceof Error ? error.message : 'Failed to get deployment teams',
        };
    }
}

export async function lookupExistingDeployment(workId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await deployAPI.lookupExistingDeployment(workId);

        // Ensure the page revalidates when we discover a deployment
        if (response.status === 'success' && response.website) {
            revalidatePath(ROUTES.DASHBOARD_WORK_DEPLOY(workId));
        }

        return {
            success: response.status === 'success',
            website: response.website,
            deploymentState: response.deploymentState,
            found: response.found ?? false,
            error: response.status === 'error' ? response.message || undefined : null,
        };
    } catch (error) {
        console.error('Lookup existing deployment error:', error);
        return {
            success: false,
            website: undefined,
            deploymentState: undefined,
            found: false,
            error: error instanceof Error ? error.message : 'Failed to lookup deployment',
        };
    }
}

export async function getDomains(workId: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await deployAPI.getDomains(workId);
        return {
            success: response.status === 'success',
            domains: response.domains ?? [],
        };
    } catch (error) {
        console.error('Get domains error:', error);
        return {
            success: false,
            domains: [] as { name: string; verified: boolean; verification?: any[] }[],
            error: error instanceof Error ? error.message : 'Failed to get domains',
        };
    }
}

export async function addDomain(workId: string, domain: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await deployAPI.addDomain(workId, domain);
        revalidatePath(ROUTES.DASHBOARD_WORK_DEPLOY(workId));
        return {
            success: response.status === 'success',
            domain: response.domain,
            verified: response.verified ?? false,
        };
    } catch (error) {
        console.error('Add domain error:', error);
        return {
            success: false,
            domain: undefined,
            verified: false,
            error: error instanceof Error ? error.message : 'Failed to add domain',
        };
    }
}

export async function removeDomain(workId: string, domain: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await deployAPI.removeDomain(workId, domain);
        revalidatePath(ROUTES.DASHBOARD_WORK_DEPLOY(workId));
        return {
            success: response.status === 'success',
        };
    } catch (error) {
        console.error('Remove domain error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to remove domain',
        };
    }
}

export async function verifyDomain(workId: string, domain: string) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    try {
        const response = await deployAPI.verifyDomain(workId, domain);
        revalidatePath(ROUTES.DASHBOARD_WORK_DEPLOY(workId));
        return {
            success: response.status === 'success',
            domain: response.domain,
        };
    } catch (error) {
        console.error('Verify domain error:', error);
        return {
            success: false,
            domain: undefined,
            error: error instanceof Error ? error.message : 'Failed to verify domain',
        };
    }
}

export async function updateWebsiteTemplateSettings(
    workId: string,
    settings: {
        websiteTemplateAutoUpdate?: boolean;
        websiteTemplateUseBeta?: boolean;
    },
) {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }

    const t = await getTranslations('actions.deploy');
    const tWorks = await getTranslations('actions.works');

    try {
        const { work } = await workAPI.get(workId);

        // When enabling auto-update, verify git provider connection exists
        if (settings.websiteTemplateAutoUpdate === true) {
            const connectionCheck = await checkGitProviderConnection(work.gitProvider);
            if (!connectionCheck.connected) {
                return {
                    success: false,
                    error: tWorks('oauthRequired', { provider: work.gitProvider }),
                    requiresGitProvider: true,
                };
            }
        }

        const response = await workAPI.update(workId, settings);

        revalidatePath(ROUTES.DASHBOARD_WORK_DEPLOY(workId));

        return {
            success: response.status === 'success',
            data: response.work,
            error: response.status === 'error' ? t('updateSettingsFailed') : null,
        };
    } catch (error) {
        console.error('Update website template settings error:', error);
        return {
            success: false,
            data: null,
            error: error instanceof Error ? error.message : t('updateSettingsFailed'),
        };
    }
}
