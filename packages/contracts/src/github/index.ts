export interface ParsedGitHubRepository {
	owner: string;
	repo: string;
	canonicalUrl: string;
}

export function parseGitHubRepositoryUrl(input: string): ParsedGitHubRepository | null {
	try {
		const url = new URL(input);
		if (!['https:', 'http:'].includes(url.protocol)) {
			return null;
		}

		if (url.hostname.toLowerCase() !== 'github.com') {
			return null;
		}

		const segments = url.pathname
			.replace(/\.git$/, '')
			.split('/')
			.filter(Boolean);

		if (segments.length < 2) {
			return null;
		}

		const owner = segments[0].toLowerCase();
		const repo = segments[1].toLowerCase();

		return {
			owner,
			repo,
			canonicalUrl: `https://github.com/${owner}/${repo}`
		};
	} catch {
		return null;
	}
}
