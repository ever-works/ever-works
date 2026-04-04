import { AuthProvider } from '../../config/constants';

export type SocialAuthProviderId = Exclude<AuthProvider, AuthProvider.LOCAL>;

export interface SocialAuthUser {
	provider: SocialAuthProviderId;
	providerUserId: string;
	email: string;
	displayName: string;
	username?: string;
	avatar?: string | null;
	emailVerified?: boolean;
	accessToken: string;
	refreshToken?: string | null;
	tokenType?: string | null;
	scope?: string | null;
	expiresAt?: Date | null;
	metadata?: Record<string, unknown>;
}
