import 'server-only';
import { serverMutation } from './server-api';
import { APIResponse } from './types';

export type ValidateVercelTokenDto = APIResponse<{
    valid: boolean;
    userInfo: any;
}>;

export type DeployWebsiteResponseDto = APIResponse<{
    slug: string;
    owner: string;
    repository: string;
    message: string;
}>;

export type VercelTeam = {
    id: string;

    slug: string;

    name: string | null;

    saml?: any;

    createdAt: number;
};

export type VercelTeamResponse = APIResponse<{
    teams: VercelTeam[];
}>;

export interface DeployWebsiteVercelDto {
    vercelTeamId?: string;
}

export const deployAPI = {
    // Deploy to Vercel
    deployToVercel: async (directoryId: string, data: DeployWebsiteVercelDto) => {
        return serverMutation<DeployWebsiteResponseDto>({
            endpoint: `/deploy/directories/${directoryId}/vercel`,
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    // validate vercel token
    validateVercelToken: (vercelToken: string) => {
        return serverMutation<ValidateVercelTokenDto>({
            endpoint: '/deploy/vercel/validate-token',
            data: { token: vercelToken },
            method: 'POST',
            wrapInData: false,
        });
    },

    // get vercel teams of the passed token
    getVercelTeams() {
        return serverMutation<VercelTeamResponse>({
            endpoint: '/deploy/vercel/teams',
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },
};
