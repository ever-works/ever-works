'use server';

import { apiKeysAPI } from '@/lib/api';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { revalidatePath } from 'next/cache';

export async function createApiKey(data: { name: string; expiresAt?: string }) {
	const user = await getAuthFromCookie();
	if (!user) {
		redirect(ROUTES.AUTH_LOGIN);
	}

	try {
		const result = await apiKeysAPI.create(data);
		revalidatePath(ROUTES.DASHBOARD_SETTINGS_API_KEYS);
		return { success: true, data: result, error: null };
	} catch (error) {
		return {
			success: false,
			data: null,
			error: error instanceof Error ? error.message : 'Failed to create API key',
		};
	}
}

export async function revokeApiKey(id: string) {
	const user = await getAuthFromCookie();
	if (!user) {
		redirect(ROUTES.AUTH_LOGIN);
	}

	try {
		await apiKeysAPI.revoke(id);
		revalidatePath(ROUTES.DASHBOARD_SETTINGS_API_KEYS);
		return { success: true, error: null };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : 'Failed to revoke API key',
		};
	}
}
