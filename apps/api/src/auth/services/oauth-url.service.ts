import { Injectable } from '@nestjs/common';
import { config } from '../../config/constants';
import { GitHubScopePresets } from '../config/github-scopes.config';

@Injectable()
export class OAuthUrlService {
    generateGoogleAuthUrl(callbackUrl?: string, state?: string): string {
        const params = new URLSearchParams({
            client_id: config.google.clientId(),
            redirect_uri: callbackUrl || config.google.callbackUrl(),
            response_type: 'code',
            scope: 'email profile',
            access_type: 'offline',
            prompt: 'consent',
            ...(state && { state }),
        });

        return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }

    generateGitHubAuthUrl(callbackUrl?: string, state?: string): string {
        const params = new URLSearchParams({
            client_id: config.github.clientId(),
            redirect_uri: callbackUrl || config.github.callbackUrl(),
            scope: GitHubScopePresets.AGENT.join(' '),
            ...(state && { state }),
        });

        return `https://github.com/login/oauth/authorize?${params.toString()}`;
    }
}
