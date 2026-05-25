import type { User } from '../entities';
import type { WorkProposalStatus } from '../entities/work-proposal.entity';
import type { InferredProfile } from './schemas';

/**
 * Mission-context payload passed to `buildProposalsPrompt` by the
 * Mission tick worker (Phase 3 PR J). When present, the prompt is
 * instructed to bias every generated Idea toward this Mission's
 * Goal description and KB excerpts.
 *
 * `description` is the Mission's Goal text — the same prompt the
 * user typed when creating the Mission. `kbExcerpts` is optional;
 * the Mission tick worker reads the Mission's `.works/` KB seed
 * paths (Phase 8 PR JJ) and packs short excerpts here when room.
 */
export interface MissionContext {
    description: string;
    kbExcerpts?: string[];
}

/**
 * Compact view of a single existing Idea — title + slug + short
 * description + status — passed to the proposal generator as both
 * an exclusion list (don't re-suggest these) AND a positive
 * context signal (the user has explored these areas; lean into or
 * around them per the per-status hint). Spec §3.3, Decision A4.
 */
export interface ExistingIdeaContext {
    title: string;
    slug: string;
    description: string;
    status: WorkProposalStatus;
}

export const USER_RESEARCH_AGENT_PROMPT = `You are a research assistant for Ever Works, a platform that helps people build content-rich directory websites called "Works".

Your task is to learn about a newly signed-up user and infer their professional profile from public sources.

## YOUR APPROACH

1. You receive the user's name, email, OAuth provider (if any), and any linked social profiles in the user prompt.
2. Use the searchWeb tool 2-6 times to find information about them. Use natural-language queries, not search operators like site: or inurl:. Good queries:
   - "{name}" "{email-domain}"
   - "{name}" GitHub profile
   - "{name}" LinkedIn profile
   - "{name}" professional background {role-hint}
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
- Time budget: bounded by runtime configuration. Finish promptly once you have enough evidence.

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
- generatedPrompt: a concise, user-facing prompt that could be typed directly into the "Describe Your Work" field. It must clearly say what kind of items the Work should contain. Example: "Create a Work of the top open-source AI agent frameworks for developers, organized by framework type and license." Do not write internal pipeline instructions.
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
    // EW-617 G2: anonymous users have no email until they claim the account;
    // user-research only runs after onboarding so this is mostly defensive.
    if (user.email) {
        lines.push(`- Email: ${user.email}`);
    }
    if (user.registrationProvider && user.registrationProvider !== 'local') {
        lines.push(`- OAuth provider: ${user.registrationProvider}`);
    }
    if (user.avatar) {
        lines.push(
            `- Avatar URL (often a profile photo from their OAuth provider): ${user.avatar}`,
        );
    }
    if (socials.length > 0) {
        lines.push(`- Linked social profiles: ${socials.join(', ')}`);
    }
    const domain = user.email?.split('@')[1];
    if (domain) {
        lines.push(`- Email domain: ${domain}`);
    }
    lines.push('');
    lines.push(
        'Research this person and call finalize with your inferred profile. Aim for 2-6 searches and 0-3 page fetches.',
    );
    return lines.join('\n');
}

/** Hard cap on Idea-context entries injected into the prompt — keeps
 *  the token budget bounded even for users with hundreds of Ideas. */
const MAX_EXISTING_IDEAS_IN_PROMPT = 50;

/** Per-entry description truncation when rendering existing Ideas
 *  into the prompt. Long descriptions add tokens fast. */
const EXISTING_IDEA_DESC_MAX_CHARS = 140;

/**
 * Default count of Ideas to ask the model for per generation tick
 * when the caller doesn't provide one (Phase 1 PR D). Matches the
 * previous hardcoded "3-5" range's midpoint; user-pref
 * `autoGenerateBatchSize` (Phase 0 PR 0.4) overrides when set.
 * Clamped to 1–20 at the prompt-builder boundary.
 */
const DEFAULT_PROPOSALS_PER_TICK = 3;
const MIN_PROPOSALS_PER_TICK = 1;
const MAX_PROPOSALS_PER_TICK = 20;

export function buildProposalsPrompt(
    profile: InferredProfile,
    existingWorkNames: string[],
    availablePluginIds: string[],
    /**
     * Phase 1 PR C / spec §3.3 — optional context list of EVERY
     * existing Idea (across ALL statuses incl. DONE / DISMISSED /
     * FAILED). The generator uses this both to avoid literal
     * duplicates AND as a positive signal of what the user is
     * interested in. Suggesting net-new directions adjacent to
     * what's been tried is better than blank-slate riffing.
     *
     * Optional + back-compat default `[]` so existing callers
     * that haven't been updated yet still produce a valid prompt.
     */
    existingIdeas: ExistingIdeaContext[] = [],
    /**
     * Phase 3 PR J — optional Mission-scoped context. When
     * present, the prompt asks the model to bias every
     * generated Idea toward this Mission's Goal description and
     * any KB excerpts the tick worker passed along.
     */
    missionContext?: MissionContext,
    /**
     * Phase 1 PR D — number of Ideas to ask the model for. When
     * omitted, defaults to `DEFAULT_PROPOSALS_PER_TICK`.
     * `WorkAgentPreference.autoGenerateBatchSize` flows into here
     * from the caller (WorkProposalsApiService). Clamped to
     * [1, 20] to keep prompts and budgets bounded.
     */
    targetCount?: number,
): string {
    const lines: string[] = [];
    lines.push('## Inferred user profile');
    lines.push(JSON.stringify(profile, null, 2));
    lines.push('');

    if (missionContext) {
        lines.push('## Mission context — bias all proposals toward this Goal');
        lines.push(missionContext.description.trim());
        if (missionContext.kbExcerpts && missionContext.kbExcerpts.length > 0) {
            lines.push('');
            lines.push('### Background excerpts from the Mission KB');
            for (const excerpt of missionContext.kbExcerpts) {
                lines.push(`- ${excerpt.trim()}`);
            }
        }
        lines.push('');
        lines.push(
            'Every proposal you generate MUST advance the Mission above. Reject directions that do not.',
        );
        lines.push('');
    }

    if (existingWorkNames.length > 0) {
        lines.push('## Works the user already has (avoid duplicating these)');
        existingWorkNames.forEach((n) => lines.push(`- ${n}`));
        lines.push('');
    }

    if (existingIdeas.length > 0) {
        lines.push(
            "## The user's existing Ideas (do NOT re-suggest these; use as context for what they care about)",
        );
        lines.push(
            'Each row includes the status — for done Ideas the Work has shipped, for dismissed Ideas the user rejected the direction, for pending/queued/building/failed the work is in motion. Use this signal: lean adjacent to ACCEPTED themes, avoid replays of DISMISSED ones.',
        );
        lines.push('');
        const limited = existingIdeas.slice(0, MAX_EXISTING_IDEAS_IN_PROMPT);
        for (const idea of limited) {
            const desc = idea.description
                .trim()
                .replace(/\s+/g, ' ')
                .slice(0, EXISTING_IDEA_DESC_MAX_CHARS);
            lines.push(`- [${idea.status}] "${idea.title}" (${idea.slug}) — ${desc}`);
        }
        if (existingIdeas.length > MAX_EXISTING_IDEAS_IN_PROMPT) {
            lines.push(
                `- … and ${existingIdeas.length - MAX_EXISTING_IDEAS_IN_PROMPT} older Ideas omitted for brevity.`,
            );
        }
        lines.push('');
    }

    lines.push('## Available plugin IDs (use only these)');
    lines.push(availablePluginIds.join(', '));
    lines.push('');

    const clampedCount = Math.min(
        MAX_PROPOSALS_PER_TICK,
        Math.max(MIN_PROPOSALS_PER_TICK, Math.trunc(targetCount ?? DEFAULT_PROPOSALS_PER_TICK)),
    );
    lines.push(`Generate exactly ${clampedCount} personalized Work proposals matching the schema.`);
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
