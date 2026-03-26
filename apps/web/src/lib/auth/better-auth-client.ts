import { createAuthClient } from 'better-auth/react';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3100';

export const authClient = createAuthClient({
	baseURL: API_URL,
	basePath: '/api/auth/better-auth',
});
