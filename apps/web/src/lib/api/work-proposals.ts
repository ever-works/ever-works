import 'server-only';
import { serverFetch, serverMutation } from './server-api';

export type WorkProposalStatus = 'pending' | 'dismissed' | 'accepted';
export type WorkProposalSource = 'auto-signup' | 'user-refresh' | 'discover' | 'scheduled';

export interface WorkProposal {
	id: string;
	title: string;
	description: string;
	slugSuggestion: string;
	suggestedCategories: Array<{ name: string; slug: string }>;
	suggestedFields: Array<{ name: string; type: string }>;
	recommendedPlugins: Array<{ pluginId: string; reason: string }>;
	reasoning: string;
	source: WorkProposalSource;
	status: WorkProposalStatus;
	acceptedWorkId?: string | null;
	generatedAt: string;
}

export const workProposalsAPI = {
	async list(statuses: WorkProposalStatus[] = ['pending']): Promise<WorkProposal[]> {
		const params = statuses.map((s) => `statuses=${encodeURIComponent(s)}`).join('&');
		return serverFetch<WorkProposal[]>(`/v1/me/work-proposals?${params}`, {
			method: 'GET'
		});
	},

	async status(): Promise<{ researching: boolean }> {
		return serverFetch<{ researching: boolean }>(`/v1/me/work-proposals/status`, {
			method: 'GET'
		});
	},

	async refresh(): Promise<{ status: 'queued' | 'rate-limited'; error?: string }> {
		return serverMutation<{ status: 'queued' | 'rate-limited'; error?: string }>({
			endpoint: '/v1/me/work-proposals/refresh',
			data: {},
			method: 'POST',
			wrapInData: false
		});
	},

	async dismiss(id: string): Promise<void> {
		await serverMutation<void>({
			endpoint: `/v1/me/work-proposals/${id}/dismiss`,
			data: {},
			method: 'PATCH',
			wrapInData: false
		});
	},

	async accept(id: string, workId: string): Promise<{ ok: boolean }> {
		return serverMutation<{ ok: boolean }>({
			endpoint: `/v1/me/work-proposals/${id}/accept`,
			data: { workId },
			method: 'POST',
			wrapInData: false
		});
	}
};
