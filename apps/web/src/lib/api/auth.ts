import { serverFetch, serverMutation } from './server-api';

// DTOs - Auth
export interface RegisterDto {
    username: string;
    email: string;
    password: string;
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
}

// DTOs - Email Verification
export interface VerifyEmailDto {
    token: string;
}

export interface ForgotPasswordDto {
    email: string;
}

export interface ResetPasswordDto {
    token: string;
    newPassword: string;
}

// Response Types
export interface AuthResponse {
    access_token: string;
    refresh_token: string;
    user: {
        id: string;
        username: string;
        email: string;
        avatar?: string;
    };
}

export interface OAuthUrlResponse {
    url: string;
}

export interface OAuthConnectionResponse {
    id: string;
    provider: string;
    providerId: string;
    scopes: string[];
    createdAt: string;
}

export interface MessageResponse {
    message: string;
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

    // OAuth Connections
    oauth_connections: {
        getAll: async () => {
            return serverFetch<OAuthConnectionResponse[]>('/auth/connections');
        },

        checkConnection: async (provider: string) => {
            return serverFetch<{ connected: boolean; scopes?: string[] }>(
                `/auth/connections/${provider}`,
            );
        },

        getConnectUrl: async (
            provider: string,
            callbackUrl?: string,
            state?: string,
        ): Promise<{ url: string; state: string }> => {
            const params = new URLSearchParams();
            if (callbackUrl) params.append('callbackUrl', callbackUrl);
            if (state) params.append('state', state);
            const query = params.toString() ? `?${params.toString()}` : '';

            return serverFetch<{ url: string; state: string }>(
                `/auth/connections/${provider}/connect/url${query}`,
            );
        },

        connectCallback: async (provider: string, code: string, state?: string) => {
            const params = new URLSearchParams({ code });
            if (state) params.append('state', state);
            return serverFetch<OAuthConnectionResponse>(
                `/auth/connections/${provider}/callback?${params.toString()}`,
            );
        },

        requestAdditionalScopes: async (provider: string, scopes: string[]) => {
            return serverMutation<MessageResponse>({
                endpoint: `/auth/connections/${provider}/request-scopes`,
                data: { scopes },
                method: 'POST',
                wrapInData: false,
            });
        },

        disconnect: async (provider: string) => {
            return serverMutation<void>({
                endpoint: `/auth/connections/${provider}`,
                data: {},
                method: 'DELETE',
                wrapInData: false,
            });
        },

        // GitHub specific
        getGitHubRepositories: async () => {
            return serverFetch<any[]>('/auth/connections/github/repositories');
        },

        checkGitHubScopes: async (requiredScopes: string[]) => {
            const params = new URLSearchParams({ required: requiredScopes.join(',') });
            return serverFetch<{ hasScopes: boolean; missingScopes?: string[] }>(
                `/auth/connections/github/check-scopes?${params.toString()}`,
            );
        },
    },
};
