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
    committerName?: string | null;
    committerEmail?: string | null;
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
    refresh_token?: string;
    user: UserProfile;
}

export interface UserProfile {
    id: string;
    username: string;
    email: string;
    avatar?: string;
    emailVerified?: boolean;
    committerName?: string | null;
    committerEmail?: string | null;
}

export interface OAuthUrlResponse {
    url: string;
}

export interface TokenValidationResponse {
    valid: boolean;
    message: string;
    email?: string;
    expiresAt?: Date;
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

    logout: async (data?: RefreshTokenDto) => {
        return serverMutation<MessageResponse>({
            endpoint: '/auth/logout',
            data: data || {},
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
    getOAuthAuthUrl: async (providerId: OAuthProvider, callbackUrl?: string, state?: string) => {
        const params = new URLSearchParams();
        if (callbackUrl) params.append('callbackUrl', callbackUrl);
        if (state) params.append('state', state);
        const query = params.toString() ? `?${params.toString()}` : '';
        return serverFetch<OAuthUrlResponse>(`/oauth/${providerId}/url${query}`);
    },

    connectOAuthCallback: async (providerId: OAuthProvider, code: string, callbackUrl: string) => {
        const params = new URLSearchParams({ code, callbackUrl });
        return serverFetch<AuthResponse>(`/oauth/${providerId}/callback?${params.toString()}`);
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
};
