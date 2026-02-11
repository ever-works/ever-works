import { Octokit, RequestError } from 'octokit';
import _sodium from 'libsodium-wrappers';
import type { GitHubWorkflow, GitHubPublicKey, GitHubActionSecret } from './types.js';
import { ACTIVE_WORKFLOW_NAMES, ACTIVE_WORKFLOW_FILES } from './types.js';

export class GitHubActionsService {
	private createOctokit(token: string, baseUrl?: string): Octokit {
		return new Octokit({
			auth: token,
			baseUrl: baseUrl || 'https://api.github.com'
		});
	}

	async getRepositoryPublicKey(
		owner: string,
		repo: string,
		token: string,
		baseUrl?: string
	): Promise<GitHubPublicKey> {
		const octokit = this.createOctokit(token, baseUrl);
		const { data } = await octokit.rest.actions.getRepoPublicKey({ owner, repo });
		return { key_id: data.key_id, key: data.key };
	}

	async getActionSecret(
		owner: string,
		repo: string,
		secretName: string,
		token: string,
		baseUrl?: string
	): Promise<GitHubActionSecret | null> {
		const octokit = this.createOctokit(token, baseUrl);

		try {
			const { data } = await octokit.rest.actions.getRepoSecret({
				owner,
				repo,
				secret_name: secretName
			});
			return data;
		} catch (err) {
			if (err instanceof RequestError && err.status === 404) {
				return null;
			}
			throw err;
		}
	}

	async setActionSecret(
		data: { key: string; value: string; repo: string; owner: string },
		publicKey: GitHubPublicKey,
		token: string,
		baseUrl?: string
	): Promise<void> {
		const octokit = this.createOctokit(token, baseUrl);

		await _sodium.ready;
		const binkey = _sodium.from_base64(publicKey.key, _sodium.base64_variants.ORIGINAL);
		const binsec = _sodium.from_string(data.value);
		const encryptedBytes = _sodium.crypto_box_seal(binsec, binkey);

		await octokit.rest.actions.createOrUpdateRepoSecret({
			owner: data.owner,
			repo: data.repo,
			secret_name: data.key,
			encrypted_value: _sodium.to_base64(encryptedBytes, _sodium.base64_variants.ORIGINAL),
			key_id: publicKey.key_id
		});
	}

	async setActionVariable(
		data: { key: string; value: string; repo: string; owner: string },
		token: string,
		baseUrl?: string
	): Promise<void> {
		const octokit = this.createOctokit(token, baseUrl);

		try {
			await octokit.rest.actions.updateRepoVariable({
				owner: data.owner,
				repo: data.repo,
				name: data.key,
				value: data.value
			});
		} catch (err) {
			if (err instanceof RequestError && err.status === 404) {
				await octokit.rest.actions.createRepoVariable({
					owner: data.owner,
					repo: data.repo,
					name: data.key,
					value: data.value
				});
			} else {
				throw err;
			}
		}
	}

	async listWorkflows(owner: string, repo: string, token: string, baseUrl?: string): Promise<GitHubWorkflow[]> {
		const octokit = this.createOctokit(token, baseUrl);
		const { data } = await octokit.rest.actions.listRepoWorkflows({ owner, repo });

		return data.workflows.map((w) => ({
			id: w.id,
			name: w.name,
			path: w.path,
			state: w.state as GitHubWorkflow['state']
		}));
	}

	async enableWorkflow(
		owner: string,
		repo: string,
		workflowId: number,
		token: string,
		baseUrl?: string
	): Promise<void> {
		const octokit = this.createOctokit(token, baseUrl);
		await octokit.rest.actions.enableWorkflow({ owner, repo, workflow_id: workflowId });
	}

	async disableWorkflow(
		owner: string,
		repo: string,
		workflowId: number,
		token: string,
		baseUrl?: string
	): Promise<void> {
		const octokit = this.createOctokit(token, baseUrl);
		await octokit.rest.actions.disableWorkflow({ owner, repo, workflow_id: workflowId });
	}

	/**
	 * Enables deployment workflows and disables all others.
	 * Uses predefined workflow names/files from ACTIVE_WORKFLOW_NAMES and ACTIVE_WORKFLOW_FILES.
	 */
	async enableDeploymentWorkflows(
		owner: string,
		repo: string,
		token: string,
		baseUrl?: string,
		withDelay: boolean = true
	): Promise<void> {
		const octokit = this.createOctokit(token, baseUrl);

		if (withDelay) {
			await new Promise((resolve) => setTimeout(resolve, 7000));
		}

		await Promise.allSettled([
			octokit.rest.actions.setAllowedActionsRepository({
				owner,
				repo,
				github_owned_allowed: true
			}),
			octokit.rest.actions.setGithubActionsPermissionsRepository({
				owner,
				repo,
				enabled: true,
				allowed_actions: 'all'
			})
		]);

		const workflows = await this.listWorkflows(owner, repo, token, baseUrl);

		const promises = workflows.map((workflow) => {
			const isActive =
				ACTIVE_WORKFLOW_NAMES.includes(workflow.name as (typeof ACTIVE_WORKFLOW_NAMES)[number]) ||
				ACTIVE_WORKFLOW_FILES.includes(workflow.path as (typeof ACTIVE_WORKFLOW_FILES)[number]);

			if (isActive) {
				return this.enableWorkflow(owner, repo, workflow.id, token, baseUrl);
			}
			return this.disableWorkflow(owner, repo, workflow.id, token, baseUrl);
		});

		await Promise.allSettled(promises);
	}

	async dispatchWorkflow(
		data: {
			workflow: string;
			inputs?: Record<string, unknown>;
			branch: string;
			owner: string;
			repo: string;
		},
		token: string,
		baseUrl?: string
	): Promise<void> {
		const octokit = this.createOctokit(token, baseUrl);

		await octokit.rest.actions.createWorkflowDispatch({
			workflow_id: data.workflow,
			inputs: data.inputs,
			ref: data.branch,
			owner: data.owner,
			repo: data.repo
		});
	}
}
