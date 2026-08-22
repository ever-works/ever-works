/**
 * The CLI credentials a fleet node may be granted for `agent-task` steps.
 *
 * ## Why this exists
 *
 * A node builds its subprocess environment from scratch and drops every
 * secret-SHAPED name (`…TOKEN`, `…KEY`, `…SECRET`, …) unless the step
 * explicitly grants it through `envPassthrough`. That default is right —
 * but it means a machine whose Claude or Codex credential lives in an
 * environment variable silently gets no credential at all, and the agent
 * fails in a way that looks like a model problem rather than a config one.
 *
 * Only the `HOME`-based path works without a grant, because `HOME` is on
 * the node's allowlist and the CLIs keep their login under it. That covers
 * a person's own desktop and nothing else: a headless node has no browser
 * to log in with, a container has no persistent home, and anyone using an
 * API key or a ChatGPT workspace access token has no login to begin with.
 *
 * ## Why one shared list works for a mixed fleet
 *
 * `envPassthrough` grants a NAME, and the value is read from the node's
 * own environment. Granting a name that a given machine does not set is a
 * no-op. So one list can cover a fleet where PC-1 authenticates with a
 * Claude subscription token and PC-2 with an Anthropic API key — each
 * machine picks up only what it actually has, and neither learns anything
 * about the other's credential.
 *
 * ## Why the families matter
 *
 * Within one CLI these variables are not interchangeable, they are
 * PRIORITISED — and the CLI's own priority does not match the operator's
 * intent. Claude Code resolves `ANTHROPIC_API_KEY` ahead of
 * `CLAUDE_CODE_OAUTH_TOKEN`, and in non-interactive (`-p`) mode the key
 * "is always used when present". A machine that happens to have both set
 * would therefore bill the Console org for an agent the operator meant to
 * run on their Claude plan — silently.
 *
 * So a node resolves at most ONE credential per family, preferring the
 * subscription-backed one. Landing on a subscription credential costs plan
 * quota; landing on an API key costs money nobody authorised. See
 * `resolveExclusiveAgentCredentials`.
 */

/** One CLI's credential variables, most-preferred first. */
export interface FleetAgentCredentialFamily {
	/** Human-readable CLI name, used in log lines. */
	readonly cli: string;
	/**
	 * Credential env var names in the order this platform prefers them —
	 * subscription-backed credentials BEFORE per-token API keys. Only the
	 * first one actually present on a node is granted.
	 */
	readonly envNames: readonly string[];
}

export const FLEET_AGENT_CREDENTIAL_FAMILIES: readonly FleetAgentCredentialFamily[] = [
	{
		cli: 'claude-code',
		// CLAUDE_CODE_OAUTH_TOKEN (a Claude plan) before ANTHROPIC_API_KEY
		// (per-token Console billing) — deliberately the REVERSE of the CLI's
		// own precedence, so the cheaper credential wins rather than the one
		// that silently spends money.
		envNames: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']
	},
	{
		cli: 'codex',
		// CODEX_ACCESS_TOKEN draws the ChatGPT workspace entitlement;
		// OPENAI_API_KEY is per-token platform billing.
		envNames: ['CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY']
	}
] as const;

/**
 * Every credential name the platform grants to `agent-task` steps by
 * default. Operators can replace this list (or empty it) — see the
 * `FLEET_NODE_AGENT_TASK_ENV_PASSTHROUGH` setting.
 */
export const FLEET_AGENT_CREDENTIAL_ENV_NAMES: readonly string[] = FLEET_AGENT_CREDENTIAL_FAMILIES.flatMap(
	(family) => family.envNames
);

/**
 * Drop credential names that lose to a higher-preference sibling PRESENT
 * in the same environment, so the CLI cannot resolve one the operator did
 * not choose.
 *
 * Takes the granted names and the node's own environment; returns the
 * names that survive, plus a note per family explaining any drop so the
 * decision shows up in the job log instead of only on an invoice.
 *
 * Names outside every known family pass through untouched — an operator
 * granting a variable for their own wrapper CLI is none of our business.
 */
export function resolveExclusiveAgentCredentials(
	grantedNames: readonly string[],
	env: Readonly<Record<string, string | undefined>>
): { names: string[]; notes: string[] } {
	const granted = new Set(grantedNames);
	const dropped = new Set<string>();
	const notes: string[] = [];

	for (const family of FLEET_AGENT_CREDENTIAL_FAMILIES) {
		const present = family.envNames.filter((name) => granted.has(name) && (env[name] ?? '').trim() !== '');
		if (present.length <= 1) {
			continue;
		}
		const [winner, ...losers] = present;
		for (const loser of losers) {
			dropped.add(loser);
		}
		notes.push(
			`${family.cli}: using ${winner}; ignoring ${losers.join(', ')} ` +
				`(both were set on this node, and granting both would let the CLI pick the one you did not choose)`
		);
	}

	return { names: grantedNames.filter((name) => !dropped.has(name)), notes };
}
