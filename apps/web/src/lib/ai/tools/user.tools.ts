import { z } from 'zod';
import { tool } from 'ai';
import { authAPI } from '@/lib/api/auth';

export const getUserInfo = tool({
    description: [
        "Get the current authenticated user's profile information.",
        'Returns username, email, avatar, and verification status.',
        'Use this when you need to personalize responses or look up info about the user.',
    ].join(' '),
    inputSchema: z.object({}),
    execute: async () => {
        try {
            const profile = await authAPI.getProfile();

            return {
                success: true,
                user: {
                    username: profile.username,
                    email: profile.email,
                    avatar: profile.avatar ?? null,
                    emailVerified: profile.emailVerified ?? false,
                },
            };
        } catch {
            return {
                success: false,
                user: null,
                message: 'Failed to retrieve user profile.',
            };
        }
    },
});
