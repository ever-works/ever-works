import { Injectable, Logger } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';

const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;
const GITHUB_HTTPS_REPO = /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/i;

const RegisterWorkSchema = z.object({
	repo: z
		.string()
		.regex(GITHUB_HTTPS_REPO)
		.describe('HTTPS GitHub repo URL containing works.yml at root'),
	githubToken: z
		.string()
		.min(4)
		.describe(
			'Fine-grained PAT, classic PAT, or GitHub App installation token. Never logged, never echoed.'
		),
	email: z.string().email().optional().describe('Optional contact email.'),
	agentId: z
		.string()
		.min(1)
		.max(256)
		.regex(PRINTABLE_ASCII)
		.optional()
		.describe('Opaque agent identifier (printable ASCII, ≤256 chars).'),
	webhookUrl: z
		.string()
		.url()
		.optional()
		.describe('Optional HTTPS URL for signed terminal-status webhooks.'),
	subdomain: z
		.string()
		.min(3)
		.max(63)
		.regex(SUBDOMAIN_RE)
		.optional()
		.describe('Optional DNS-safe slug for the assigned subdomain.'),
	idempotencyKey: z
		.string()
		.min(1)
		.max(64)
		.optional()
		.describe('Optional idempotency key (Stripe convention).')
});

/**
 * MCP tool that mirrors POST /api/register-work. Public — no Ever Works
 * credential required (the registration call IS the bootstrap of the
 * agent's account). The tool POSTs to the API base URL configured at
 * `EVER_WORKS_API_URL` (defaults to `https://api.ever.works`).
 */
@Injectable()
export class RegisterWorkTool {
	private readonly logger = new Logger(RegisterWorkTool.name);

	@Tool({
		name: 'register_work',
		description:
			'Zero-friction registration. Creates an Ever Works account if needed, links it to your ' +
			'GitHub identity, parses works.yml from your repo, and queues a Work for generation. ' +
			'Returns 202 with onboardingId, workId, statusUrl, and the assigned subdomain.',
		parameters: RegisterWorkSchema
	})
	async register(input: z.infer<typeof RegisterWorkSchema>) {
		const apiBase = process.env.EVER_WORKS_API_URL || 'https://api.ever.works';
		const url = `${apiBase.replace(/\/$/, '')}/api/register-work`;
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json',
			'X-GitHub-Token': input.githubToken
		};
		if (input.idempotencyKey) {
			headers['Idempotency-Key'] = input.idempotencyKey;
		}

		const body = JSON.stringify({
			repo: input.repo,
			email: input.email,
			agentId: input.agentId,
			webhookUrl: input.webhookUrl,
			subdomain: input.subdomain
		});

		try {
			const response = await fetch(url, { method: 'POST', headers, body });
			const text = await response.text();
			let parsed: unknown;
			try {
				parsed = text ? JSON.parse(text) : {};
			} catch {
				parsed = { raw: text };
			}

			if (response.status >= 200 && response.status < 300) {
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify(parsed, null, 2)
						}
					]
				};
			}

			return {
				isError: true,
				content: [
					{
						type: 'text' as const,
						text: `Ever Works register-work failed (HTTP ${response.status}): ${JSON.stringify(parsed, null, 2)}`
					}
				]
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logger.warn(`register_work.fetch_failed reason=${message}`);
			return {
				isError: true,
				content: [
					{
						type: 'text' as const,
						text: `Ever Works API unreachable: ${message}`
					}
				]
			};
		}
	}
}
