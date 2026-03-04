import 'server-only';
import { serverFetch, serverMutation } from './server-api';

export interface CreateApiKeyDto {
	name: string;
	expiresAt?: string;
}

export interface CreateApiKeyResponse {
	id: string;
	name: string;
	key: string;
	prefix: string;
	expiresAt: string | null;
	createdAt: string;
}

export interface ApiKeyListItem {
	id: string;
	name: string;
	prefix: string;
	expiresAt: string | null;
	lastUsedAt: string | null;
	isActive: boolean;
	createdAt: string;
}

export const apiKeysAPI = {
	create: async (data: CreateApiKeyDto) => {
		return serverMutation<CreateApiKeyResponse>({
			endpoint: '/auth/api-keys',
			data,
			method: 'POST',
			wrapInData: false,
		});
	},

	list: async () => {
		return serverFetch<ApiKeyListItem[]>('/auth/api-keys');
	},

	revoke: async (id: string) => {
		return serverMutation<{ message: string }>({
			endpoint: `/auth/api-keys/${id}`,
			data: {},
			method: 'DELETE',
			wrapInData: false,
		});
	},
};
