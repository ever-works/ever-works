import {
	FLEET_SESSION_PROMPT_MAX_CHARS,
	validateFleetSessionRulesFile,
	type FleetSessionAttentionOption,
	type FleetSessionEvidence,
	type FleetSessionRule,
	type FleetSessionRulesFile
} from '@ever-works/contracts';
import { oneLine } from './hook-events';
import { SESSION_RULES_FILES } from './rules/session-rules';

/**
 * Session status (FL-05 P2, plan §6.1 `rules-engine.ts`, spec FR-33 … FR-36,
 * S9, U10) — reads a session's terminal for the prompts no hook reports.
 *
 * Every rules file is validated when the engine is built (node start): an
 * invalid one throws naming its rule id, so a broken release fails loudly
 * instead of mis-reading screens (FR-36). Rules are compiled once.
 *
 * {@link SessionRulesEngine.evaluate} is pure over its inputs — the screen
 * text, the title, the clock — plus a per-session memory of when each rule
 * started matching (its `quietMs` debounce). The FIRST matching rule wins, in
 * file order (prompts before `working`). A match becomes evidence with
 * `source: 'rules'` and, for a prompt, the options the CLI shows and the keys
 * that answer them (kept on the node, FR-35).
 */

export interface RuleRegions {
	/** The last 40 lines as shown (plain text). */
	screen: string;
	/** The terminal title. */
	title: string;
}

export interface RuleMatch {
	ruleId: string;
	evidence: FleetSessionEvidence;
	/** optionId → the keys the node types (FR-35). Empty for a `working` / `idle` rule. */
	keys: Record<string, string>;
}

interface CompiledRule {
	rule: FleetSessionRule;
	pattern: RegExp;
}

export class SessionRulesEngine {
	private readonly byProvider = new Map<string, CompiledRule[]>();
	/** `sessionId:ruleId` → when the rule started matching (its debounce). */
	private readonly matchingSince = new Map<string, number>();

	constructor(files: readonly FleetSessionRulesFile[] = SESSION_RULES_FILES) {
		for (const file of files) {
			const checked = validateFleetSessionRulesFile(file);
			if (!checked.ok) {
				throw new Error(
					`session rules for ${String((file as { provider?: unknown }).provider)} are invalid${
						checked.ruleId ? ` (rule ${checked.ruleId})` : ''
					}: ${checked.problem}`
				);
			}
			this.byProvider.set(
				checked.file.provider,
				checked.file.rules.map((rule) => ({
					rule,
					pattern: new RegExp(rule.when.match, rule.when.flags ?? '')
				}))
			);
		}
	}

	/** Whether a provider has any rule (a shell has none: never evaluated). */
	hasRules(provider: string): boolean {
		return (this.byProvider.get(provider)?.length ?? 0) > 0;
	}

	/** Forget a session's debounce memory (it ended). */
	forget(sessionId: string): void {
		for (const key of [...this.matchingSince.keys()]) {
			if (key.startsWith(`${sessionId}:`)) this.matchingSince.delete(key);
		}
	}

	evaluate(sessionId: string, provider: string, regions: RuleRegions, now: number): RuleMatch | null {
		const rules = this.byProvider.get(provider);
		if (!rules || rules.length === 0) return null;
		const lines = regions.screen.split(/\r?\n/);
		const tail = lines.slice(-10).join('\n').toLowerCase();
		let winner: RuleMatch | null = null;
		for (const { rule, pattern } of rules) {
			const region =
				rule.when.region === 'screen' ? regions.screen : rule.when.region === 'tail' ? tail : regions.title;
			const key = `${sessionId}:${rule.id}`;
			const match = pattern.exec(region);
			if (!match) {
				this.matchingSince.delete(key);
				continue;
			}
			const since = this.matchingSince.get(key) ?? now;
			this.matchingSince.set(key, since);
			if (winner) continue;
			if (now - since < (rule.when.quietMs ?? 0)) continue;
			winner = this.toMatch(rule, region, match, now);
		}
		return winner;
	}

	private toMatch(rule: FleetSessionRule, region: string, match: RegExpExecArray, now: number): RuleMatch {
		const then = rule.then;
		if (then.state !== 'needs_you') {
			return {
				ruleId: rule.id,
				evidence: {
					source: 'rules',
					event: then.state === 'working' ? 'working' : 'idle-weak',
					at: now,
					rule: rule.id
				},
				keys: {}
			};
		}
		// The line the match sits on is what the CLI asks (redacted, one line).
		const start = region.lastIndexOf('\n', match.index) + 1;
		const end = region.indexOf('\n', match.index);
		const line = region.slice(start, end < 0 ? undefined : end);
		const prompt = then.prompt ?? oneLine(line, FLEET_SESSION_PROMPT_MAX_CHARS) ?? '';
		const options: FleetSessionAttentionOption[] = [];
		const keys: Record<string, string> = {};
		for (const option of then.options ?? []) {
			options.push({
				id: option.id,
				label: option.label,
				...(option.primary ? { primary: true } : {}),
				...(option.deny ? { deny: true } : {})
			});
			keys[option.id] = option.keys;
		}
		return {
			ruleId: rule.id,
			evidence: {
				source: 'rules',
				event: then.reason === 'question' ? 'question' : then.reason === 'blocked' ? 'blocked' : 'permission',
				at: now,
				rule: rule.id,
				prompt,
				options,
				...(then.allowsText ? { allowsText: true } : {})
			},
			keys
		};
	}
}
