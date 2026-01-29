import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import { MessageResponse } from './types';
import { OAuthProvider } from './enums';

// DTOs - Auth
export interface RegisterDto {
    username: string;
    email: string;
    password: string;
    emailVerificationCallbackUrl?: string;
}

export interface LoginDto {
    email: string;
    password: string;
}

export interface RefreshTokenDto {
    refreshToken: string;
}

export interface UpdatePasswordDto {
    currentPassword: string;
    newPassword: string;
}

export interface UpdateProfileDto {
    username?: string;
    avatar?: string;
    vercelToken?: string;
    screenshotoneAccessKey?: string;
    screenshotoneSecretKey?: string;
}

// DTOs - Email Verification
export interface VerifyEmailDto {
    token: string;
}

export interface ForgotPasswordDto {
    email: string;
    resetPasswordCallbackUrl?: string;
}

export interface ResetPasswordDto {
    token: string;
    newPassword: string;
}

// Response Types
export interface AuthResponse {
    access_token: string;
    refresh_token: string;
    user: UserProfile;
}

export interface UserProfile {
    id: string;
    username: string;
    email: string;
    avatar?: string;
    emailVerified?: boolean;
    vercelToken?: string;
    screenshotoneAccessKey?: string;
    screenshotoneSecretKey?: string;
}

export interface OAuthUrlResponse {
    url: string;
}

export interface ConnectionInfo {
    provider: OAuthProvider;
    connected: boolean;
    email?: string;
    username?: string;
    scopes?: string[];
    connectedAt?: Date;
    metadata?: Record<string, any>;
}

interface OAuthConnectionResponse extends ConnectionInfo {}

export interface TokenValidationResponse {
    valid: boolean;
    message: string;
    email?: string;
    expiresAt?: Date;
}

// Github

export interface GitHubOrganization {
    login: string;
    id: number;
    node_id: string;
    url: string;
    repos_url: string;
    events_url: string;
    hooks_url: string;
    issues_url: string;
    members_url: string;
    public_members_url: string;
    avatar_url: string;
    description: string;
}

export const authAPI = {
    // Authentication
    register: async (data: RegisterDto) => {
        return serverMutation<AuthResponse>({
            endpoint: '/auth/register',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    login: async (data: LoginDto) => {
        return serverMutation<AuthResponse>({
            endpoint: '/auth/login',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    refresh: async (data: RefreshTokenDto) => {
        return serverMutation<AuthResponse>({
            endpoint: '/auth/refresh',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    logout: async (data: RefreshTokenDto) => {
        return serverMutation<MessageResponse>({
            endpoint: '/auth/logout',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    logoutAll: async () => {
        return serverMutation<MessageResponse>({
            endpoint: '/auth/logout-all',
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    // Profile
    getProfile: async () => {
        return serverFetch<AuthResponse['user']>('/auth/profile');
    },

    getFreshProfile: async () => {
        return serverFetch<AuthResponse['user']>('/auth/profile/fresh');
    },

    updatePassword: async (data: UpdatePasswordDto) => {
        return serverMutation<MessageResponse>({
            endpoint: '/auth/update-password',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    updateProfile: async (data: UpdateProfileDto) => {
        return serverMutation<AuthResponse['user']>({
            endpoint: '/auth/profile',
            data,
            method: 'PUT',
            wrapInData: false,
        });
    },

    // OAuth URLs
    getGitHubAuthUrl: async (callbackUrl?: string, state?: string) => {
        const params = new URLSearchParams();
        if (callbackUrl) params.append('callbackUrl', callbackUrl);
        if (state) params.append('state', state);
        const query = params.toString() ? `?${params.toString()}` : '';
        return serverFetch<OAuthUrlResponse>(`/auth/github/url${query}`);
    },

    getGoogleAuthUrl: async (callbackUrl?: string, state?: string) => {
        const params = new URLSearchParams();
        if (callbackUrl) params.append('callbackUrl', callbackUrl);
        if (state) params.append('state', state);
        const query = params.toString() ? `?${params.toString()}` : '';
        return serverFetch<OAuthUrlResponse>(`/auth/google/url${query}`);
    },

    connectGoogleCallback: async (code: string, state?: string) => {
        const params = new URLSearchParams({ code });
        if (state) params.append('state', state);

        return serverFetch<AuthResponse>(`/auth/google/callback?${params.toString()}`);
    },

    connectGitHubCallback: async (code: string, state?: string) => {
        const params = new URLSearchParams({ code });
        if (state) params.append('state', state);

        return serverFetch<AuthResponse>(`/auth/github/callback?${params.toString()}`);
    },

    // Email Verification
    sendVerification: async () => {
        return serverMutation<MessageResponse>({
            endpoint: '/auth/send-verification',
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    verifyEmail: async (data: VerifyEmailDto) => {
        return serverMutation<AuthResponse>({
            endpoint: '/auth/verify-email',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    forgotPassword: async (data: ForgotPasswordDto) => {
        return serverMutation<MessageResponse>({
            endpoint: '/auth/forgot-password',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    resetPassword: async (data: ResetPasswordDto) => {
        return serverMutation<MessageResponse>({
            endpoint: '/auth/reset-password',
            data,
            method: 'POST',
            wrapInData: false,
        });
    },

    validateEmailVerificationToken: async (token: string) => {
        return serverFetch<TokenValidationResponse>(
            `/auth/validate-email-token?token=${encodeURIComponent(token)}`,
        );
    },

    validatePasswordResetToken: async (token: string) => {
        return serverFetch<TokenValidationResponse>(
            `/auth/validate-reset-token?token=${encodeURIComponent(token)}`,
        );
    },

    // OAuth Connections
    oauth_connections: {
        getAll: async () => {
            return serverFetch<OAuthConnectionResponse[]>('/auth/connections');
        },

        checkConnection: async (provider: `${OAuthProvider}`) => {
            return serverFetch<OAuthConnectionResponse>(`/auth/connections/${provider}`);
        },

        getConnectUrl: async (
            provider: OAuthProvider,
            callbackUrl?: string,
            state?: string,
            forceConsent?: boolean,
        ): Promise<{ url: string; state: string }> => {
            const params = new URLSearchParams();
            if (callbackUrl) params.append('callbackUrl', callbackUrl);
            if (state) params.append('state', state);
            if (forceConsent) params.append('forceConsent', 'true');
            const query = params.toString() ? `?${params.toString()}` : '';

            return serverFetch<{ url: string; state: string }>(
                `/auth/connections/${provider}/connect/url${query}`,
            );
        },

        connectCallback: async (provider: OAuthProvider, code: string, state?: string) => {
            const params = new URLSearchParams({ code });
            if (state) params.append('state', state);
            return serverFetch<OAuthConnectionResponse>(
                `/auth/connections/${provider}/callback?${params.toString()}`,
            );
        },

        requestAdditionalScopes: async (provider: OAuthProvider, scopes: string[]) => {
            return serverMutation<MessageResponse>({
                endpoint: `/auth/connections/${provider}/request-scopes`,
                data: { scopes },
                method: 'POST',
                wrapInData: false,
            });
        },

        ensureConnection: async (provider: `${OAuthProvider}`) => {
            return serverFetch<{ connected: boolean }>(`/auth/connections/${provider}/ensure`);
        },

        disconnect: async (provider: OAuthProvider) => {
            return serverMutation<void>({
                endpoint: `/auth/connections/${provider}`,
                data: {},
                method: 'DELETE',
                wrapInData: false,
            });
        },

        // GitHub specific
        getGitHubOrgs: async () => {
            return serverFetch<GitHubOrganization[]>('/auth/connections/github/orgs');
        },

        checkGitHubScopes: async (requiredScopes: string[]) => {
            const params = new URLSearchParams({ required: requiredScopes.join(',') });
            return serverFetch<{ hasScopes: boolean; missingScopes?: string[] }>(
                `/auth/connections/github/check-scopes?${params.toString()}`,
            );
        },
    },
};
