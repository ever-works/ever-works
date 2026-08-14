import type { AttachedRepoResource } from '@ever-works/plugin';

import type { ManagedAgentsSessionGithubRepositoryResource, ManagedAgentsSessionResource } from '../types.js';

/**
 * Repository registry (Feature G) — session resource assembly.
 *
 * Pure functions so the payload shape is unit-testable without a live
 * Anthropic client. The invariant the tests pin: with NO attachments the
 * resource list is byte-identical to what the plugin always sent (the
 * single seed-manifest file resource), so existing runs cannot change.
 */

/** An env file already uploaded to the Files API, awaiting mounting. */
export interface UploadedAttachedEnvFile {
	fileId: string;
	/** Repo mount dir the file belongs under (single path segment). */
	mountDir: string;
	/** Relative path inside the repo checkout (e.g. `.env`, `apps/api/.env`). */
	path: string;
}

/** Mount path for an attached repo: `/workspace/<mountDir>`. */
export function attachedRepoMountPath(workspacePath: string, mountDir: string): string {
	return `${workspacePath.replace(/\/+$/, '')}/${mountDir}`;
}

/** Mount path for an attached repo's env file: `/workspace/<mountDir>/<path>`. */
export function attachedEnvFileMountPath(workspacePath: string, mountDir: string, path: string): string {
	return `${attachedRepoMountPath(workspacePath, mountDir)}/${path.replace(/^\/+/, '')}`;
}

/**
 * Build the full `resources` array for the session create call:
 * seed-manifest file first (unchanged primary), then one
 * `github_repository` resource per attached repo, then the uploaded env
 * files mounted under their repo's directory.
 */
export function buildSessionResources(input: {
	workspacePath: string;
	seedManifest: { fileId: string; mountPath: string };
	attachedRepos?: readonly AttachedRepoResource[];
	uploadedEnvFiles?: readonly UploadedAttachedEnvFile[];
}): ManagedAgentsSessionResource[] {
	const resources: ManagedAgentsSessionResource[] = [
		{
			type: 'file',
			file_id: input.seedManifest.fileId,
			mount_path: input.seedManifest.mountPath
		}
	];

	for (const repo of input.attachedRepos ?? []) {
		const resource: ManagedAgentsSessionGithubRepositoryResource = {
			type: 'github_repository',
			url: repo.url,
			mount_path: attachedRepoMountPath(input.workspacePath, repo.mountDir)
		};
		if (repo.branch) {
			resource.branch = repo.branch;
		}
		resources.push(resource);
	}

	for (const envFile of input.uploadedEnvFiles ?? []) {
		resources.push({
			type: 'file',
			file_id: envFile.fileId,
			mount_path: attachedEnvFileMountPath(input.workspacePath, envFile.mountDir, envFile.path)
		});
	}

	return resources;
}
