import { BadRequestException } from '@nestjs/common';
import { AuthProvider, config } from '../../config/constants';
import type { SocialAuthProviderId } from '../types/social-auth.types';

export interface SocialAuthProviderConfig {
	id: SocialAuthProviderId;
	displayName: string;
	authorizationUrl: string;
	tokenUrl: string;
	scopes: string[];
	scopeSeparator?: string;
	callbackUrl: () => string;
	clientId: () => string | undefined;
	clientSecret: () => string | undefined;
}

export const SOCIAL_AUTH_PROVIDERS: Record<SocialAuthProviderId, SocialAuthProviderConfig> = {
	[AuthProvider.GITHUB]: {
		id: AuthProvider.GITHUB,
		displayName: 'GitHub',
		authorizationUrl: 'https://github.com/login/oauth/authorize',
		tokenUrl: 'https://github.com/login/oauth/access_token',
		scopes: ['user:email', 'read:user'],
		callbackUrl: config.github.callbackUrl,
		clientId: config.github.clientId,
		clientSecret: config.github.clientSecret
	},
	[AuthProvider.GOOGLE]: {
		id: AuthProvider.GOOGLE,
		displayName: 'Google',
		authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
		tokenUrl: 'https://oauth2.googleapis.com/token',
		scopes: ['openid', 'email', 'profile'],
		callbackUrl: config.google.callbackUrl,
		clientId: config.google.clientId,
		clientSecret: config.google.clientSecret
	},
	[AuthProvider.FACEBOOK]: {
		id: AuthProvider.FACEBOOK,
		displayName: 'Facebook',
		authorizationUrl: 'https://www.facebook.com/v23.0/dialog/oauth',
		tokenUrl: 'https://graph.facebook.com/v23.0/oauth/access_token',
		scopes: ['email', 'public_profile'],
		scopeSeparator: ',',
		callbackUrl: config.facebook.callbackUrl,
		clientId: config.facebook.clientId,
		clientSecret: config.facebook.clientSecret
	},
	[AuthProvider.LINKEDIN]: {
		id: AuthProvider.LINKEDIN,
		displayName: 'LinkedIn',
		authorizationUrl: 'https://www.linkedin.com/oauth/v2/authorization',
		tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
		scopes: ['openid', 'profile', 'email'],
		callbackUrl: config.linkedin.callbackUrl,
		clientId: config.linkedin.clientId,
		clientSecret: config.linkedin.clientSecret
	}
};

export function getSocialAuthProviderConfig(providerId: string): SocialAuthProviderConfig {
	const provider = SOCIAL_AUTH_PROVIDERS[providerId as SocialAuthProviderId];
	if (!provider) {
		throw new BadRequestException(`Unsupported OAuth provider: ${providerId}`);
	}

	return provider;
}
