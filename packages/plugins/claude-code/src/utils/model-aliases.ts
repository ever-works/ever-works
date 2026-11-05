/**
 * Claude Code CLI model aliases and the Anthropic API model each one resolves to on the
 * Anthropic API, as of 2026-11-05 (https://code.claude.com/docs/en/model-config;
 * https://platform.claude.com/docs/en/about-claude/models/overview).
 *
 * The CLI accepts these aliases on `--model`, but the Messages API does not: it needs an
 * API model id. The API-key probe in `validateApiKey()` therefore maps an alias to its API
 * id before calling `POST /v1/messages` (D3). The CLI run itself still receives the saved
 * value unchanged, so the CLI keeps resolving aliases on its own.
 */
const CLI_ALIAS_TO_API_MODEL: ReadonlyMap<string, string> = new Map([
	// `default` clears any override; for Anthropic API users it is Opus 5.5.
	['default', 'claude-opus-5-5'],
	['opus', 'claude-opus-5-5'],
	// `best` is Fable 5.1 where the account has it, otherwise Opus 5.5; `opusplan` plans with Opus
	// 5.5. The probe uses Opus 5.5 for both, which every API key can call.
	['best', 'claude-opus-5-5'],
	['opusplan', 'claude-opus-5-5'],
	['sonnet', 'claude-sonnet-5-5'],
	['haiku', 'claude-haiku-5-5'],
	['fable', 'claude-fable-5-1']
]);

/** Claude Code's long-context marker (e.g. `sonnet[1m]`); not part of any API model id. */
const LONG_CONTEXT_SUFFIX = '[1m]';

/**
 * Turn a saved Claude Code model value into an Anthropic API model id: a CLI alias maps to
 * its API id, a `[1m]` suffix is dropped, and any other value (a full id, current or not)
 * passes through unchanged.
 */
export function toAnthropicApiModelId(model: string): string {
	let id = model.trim();
	if (id.toLowerCase().endsWith(LONG_CONTEXT_SUFFIX)) {
		id = id.slice(0, -LONG_CONTEXT_SUFFIX.length);
	}
	return CLI_ALIAS_TO_API_MODEL.get(id.toLowerCase()) ?? id;
}
