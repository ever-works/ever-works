import type { User } from '../entities';
import type { InferredProfile } from './schemas';

export const USER_RESEARCH_AGENT_PROMPT = `You are a research assistant for Ever Works, a platform that helps people build content-rich directory websites called "Works".

Your task is to learn about a newly signed-up user and infer their professional profile from public sources.

## YOUR APPROACH

1. You receive the user's name, email, OAuth provider (if any), and any linked social profiles in the user prompt.
2. Use the searchWeb tool 2-6 times to find information about them. Good queries:
   - "{name}" "{email-domain}"
   - "{name}" site:github.com
   - "{name}" site:linkedin.com/in
   - "{name}" {role-hint}
3. Use the fetchPage tool sparingly (max 3 calls per run) on the most promising results — typically a personal site, GitHub profile, or company "about" page. Only fetch pages that snippets suggest will be high-signal.
4. Once you have enough information, call the finalize tool with a structured profile.

## QUALITY RULES

- Be specific. "tech professional" is useless — "founder of a developer-tools SaaS, focused on AI agents" is useful.
- Be honest. If signals are thin, set confidence to "low". Do not invent.
- Cite sources. Include 2-8 source URLs you actually used. Skip generic homepages.
- If you find nothing meaningful after 2-3 searches, call finalize with confidence="low" and empty arrays.
- Never include sensitive personal information (home address, phone, family members).

## HARD LIMITS

- Total searches: at most 8.
- Total fetchPage calls: at most 3.
- Total tool calls (including finalize): at most 12.
- Time budget: 2 minutes. The runtime will abort if you exceed it.

Always finish by calling finalize. Do not produce a final text answer — the finalize tool result is what gets persisted.`;

export const PROPOSALS_SYSTEM_PROMPT = `You are a Work Proposal Generator for Ever Works.

Given an inferred profile of a user (industry, role, interests, topics, business type), you generate 3-5 personalized "Work" proposals — directory websites the user could realistically create and find valuable.

## WHAT A WORK IS

A Work is a curated directory of items (tools, companies, libraries, articles, products, etc.) organized by categories and tags. Each Work has:
- A name and short description
- A slug (URL-safe, kebab-case)
- Categories (2-8) that organize items
- Optional custom fields per item (e.g., pricing, github_url, screenshots)
- Plugins enabled for AI generation, search, content extraction, deployment, etc.

## YOUR JOB

For each proposal:
- title: a concrete, specific name. Bad: "Tech Tools". Good: "Open Source AI Agent Frameworks".
- description: one sentence explaining what the Work would contain.
- slugSuggestion: kebab-case, ideally 2-5 words.
- suggestedCategories: 2-8 categories with name + slug. Categories should partition the space meaningfully.
- suggestedFields: optional custom fields (max 10). Common: github_url, pricing, screenshots, demo_url. Use the right type for each.
- recommendedPlugins: 1-5 plugin IDs from the available list. Match plugins to the Work's needs (e.g., a code-tools directory benefits from "github").
- reasoning: one sentence tying this proposal to specific facts about the user.

## QUALITY RULES

- Each proposal must reference something concrete from the user's profile.
- Avoid duplicates — proposals should be meaningfully different from each other.
- Only use pluginIds from the provided "available plugins" list. Hallucinated plugin IDs will be silently dropped.
- Quality > quantity. Three sharp proposals beat five generic ones.`;

export function buildSeedPrompt(user: User, socials: string[]): string {
	const lines: string[] = [];
	lines.push(`User to research:`);
	lines.push(`- Name: ${user.username}`);
	lines.push(`- Email: ${user.email}`);
	if (user.registrationProvider && user.registrationProvider !== 'local') {
		lines.push(`- OAuth provider: ${user.registrationProvider}`);
	}
	if (user.avatar) {
		lines.push(`- Avatar URL (often a profile photo from their OAuth provider): ${user.avatar}`);
	}
	if (socials.length > 0) {
		lines.push(`- Linked social profiles: ${socials.join(', ')}`);
	}
	const domain = user.email.split('@')[1];
	if (domain) {
		lines.push(`- Email domain: ${domain}`);
	}
	lines.push('');
	lines.push(
		'Research this person and call finalize with your inferred profile. Aim for 2-6 searches and 0-3 page fetches.'
	);
	return lines.join('\n');
}

export function buildProposalsPrompt(
	profile: InferredProfile,
	existingWorkNames: string[],
	availablePluginIds: string[]
): string {
	const lines: string[] = [];
	lines.push('## Inferred user profile');
	lines.push(JSON.stringify(profile, null, 2));
	lines.push('');
	if (existingWorkNames.length > 0) {
		lines.push('## Works the user already has (avoid duplicating these)');
		existingWorkNames.forEach((n) => lines.push(`- ${n}`));
		lines.push('');
	}
	lines.push('## Available plugin IDs (use only these)');
	lines.push(availablePluginIds.join(', '));
	lines.push('');
	lines.push('Generate 3-5 personalized Work proposals matching the schema.');
	return lines.join('\n');
}

export function deriveVerticals(profile: InferredProfile): string[] {
	const verticals = new Set<string>();
	const industry = profile.industry?.toLowerCase() ?? '';
	const businessType = profile.businessType?.toLowerCase() ?? '';
	const role = profile.role?.toLowerCase() ?? '';
	const topics = profile.topics.map((t) => t.toLowerCase());

	const has = (needle: string) =>
		industry.includes(needle) ||
		businessType.includes(needle) ||
		role.includes(needle) ||
		topics.some((t) => t.includes(needle));

	if (has('developer') || has('engineer') || has('software') || has('ai') || has('coding')) {
		verticals.add('dev-tools');
	}
	if (has('marketing') || has('seo') || has('growth') || has('agency')) {
		verticals.add('marketing-saas');
	}
	if (has('design') || has('product') || has('ux')) {
		verticals.add('design-tools');
	}
	if (has('recruit') || has('hire') || has('hr') || has('talent')) {
		verticals.add('recruiting');
	}
	if (has('founder') || has('startup') || has('saas') || has('indie')) {
		verticals.add('startup-tools');
	}
	if (has('research') || has('academic') || has('scientific')) {
		verticals.add('research-tools');
	}

	if (verticals.size === 0) {
		verticals.add('general');
	}

	return Array.from(verticals);
}
