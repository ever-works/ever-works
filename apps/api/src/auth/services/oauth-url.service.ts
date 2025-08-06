import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { config } from '../../config/constants';
import { GitHubScopePresets } from '../config/github-scopes.config';

@Injectable()
export class OAuthUrlService {
    generateGoogleAuthUrl(callbackUrl?: string, state?: string): string {
        const clientId = config.google.clientId();
        const defaultCallbackUrl = config.google.callbackUrl();

        if (!clientId) {
            throw new InternalServerErrorException('Google OAuth client ID is not configured');
        }

        if (!defaultCallbackUrl && !callbackUrl) {
            throw new InternalServerErrorException('Google OAuth callback URL is not configured');
        }

        const params = new URLSearchParams({
            client_id: clientId,
            redirect_uri: callbackUrl || defaultCallbackUrl,
            response_type: 'code',
            scope: 'email profile',
            access_type: 'offline',
            prompt: 'consent',
            ...(state && { state }),
        });

        return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }

    generateGitHubAuthUrl(callbackUrl?: string, state?: string): string {
        const clientId = config.github.clientId();
        const defaultCallbackUrl = config.github.callbackUrl();

        if (!clientId) {
            throw new InternalServerErrorException('GitHub OAuth client ID is not configured');
        }

        if (!defaultCallbackUrl && !callbackUrl) {
            throw new InternalServerErrorException('GitHub OAuth callback URL is not configured');
        }

        const params = new URLSearchParams({
            client_id: clientId,
            redirect_uri: callbackUrl || defaultCallbackUrl,
            scope: GitHubScopePresets.AGENT.join(' '),
            ...(state && { state }),
        });

        return `https://github.com/login/oauth/authorize?${params.toString()}`;
    }
}
