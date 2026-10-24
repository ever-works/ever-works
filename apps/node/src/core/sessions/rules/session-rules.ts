import type { FleetSessionRulesFile } from '@ever-works/contracts';

/**
 * Session status (FL-05 P2, spec FR-33 … FR-36) — the screen rules files
 * that ship inside the node package, one per agent provider (spec §8b: no
 * out-of-band fetch; a stale rule is fixed by a node release).
 *
 * Each rule reads one region of a session's terminal — `screen` (the last 40
 * lines as shown), `tail` (the last 10, lower-cased) or `title` — and names
 * the state it raises, the reason, the options the CLI shows and the KEYS
 * that answer them (typed by the node; they never leave the machine). Every
 * rule says why it exists. No rule may raise `done` (the guard refuses it at
 * node start).
 *
 * Rules run only for a session with no hook evidence in the last 10 s, at
 * most every 2 s — the hooks are the truth whenever they speak (README D4).
 * Claude Code's numbered dialogs choose an option on its digit (no Enter);
 * Esc is its "no, tell Claude what to do differently". Codex answers its
 * approval with `y` / `a` / Esc.
 */

export const CLAUDE_CODE_RULES: FleetSessionRulesFile = {
	version: 1,
	provider: 'claude-code',
	rules: [
		{
			id: 'claude.permission',
			when: {
				region: 'screen',
				match: 'do you want to (proceed|make this edit|create|run|allow|fetch|delete|overwrite)',
				flags: 'i',
				quietMs: 1_000
			},
			then: {
				state: 'needs_you',
				reason: 'permission',
				options: [
					{ id: '1', label: 'Allow', keys: '1', primary: true },
					{ id: 'deny', label: 'Deny', keys: '\u001b', deny: true }
				]
			},
			why: 'A Claude Code release without the PermissionRequest hook shows its permission dialog on screen only.'
		},
		{
			id: 'claude.trust-folder',
			when: { region: 'screen', match: 'do you trust the files in this folder', flags: 'i' },
			then: {
				state: 'needs_you',
				reason: 'question',
				prompt: 'Claude Code asks whether to trust the files in this folder',
				options: [
					{ id: '1', label: 'Yes, proceed', keys: '1', primary: true },
					{ id: '2', label: 'No, exit', keys: '2', deny: true }
				]
			},
			why: 'On a folder it has not seen, Claude Code asks whether to trust it before it loads any hook.'
		},
		{
			id: 'claude.working',
			when: { region: 'tail', match: 'esc to interrupt' },
			then: { state: 'working' },
			why: 'While a turn runs Claude Code shows "esc to interrupt": a prompt answered in the terminal is over.'
		}
	]
};

export const CODEX_RULES: FleetSessionRulesFile = {
	version: 1,
	provider: 'codex',
	rules: [
		{
			id: 'codex.exec-approval',
			when: {
				region: 'screen',
				match: 'would you like to run the following command\\?|allow command\\?',
				flags: 'i',
				quietMs: 1_000
			},
			then: {
				state: 'needs_you',
				reason: 'permission',
				options: [
					{ id: 'yes', label: 'Yes, proceed', keys: 'y', primary: true },
					{ id: 'always', label: "Yes, and don't ask again for this command", keys: 'a' },
					{ id: 'no', label: 'No, tell Codex what to do differently', keys: '\u001b', deny: true }
				]
			},
			why: 'Codex asks before it runs a command, and its notify program reports only the end of a turn.'
		},
		{
			id: 'codex.patch-approval',
			when: {
				region: 'screen',
				match: 'would you like to make the following edits\\?|proceed with (this|these) (change|edit)s?\\?',
				flags: 'i',
				quietMs: 1_000
			},
			then: {
				state: 'needs_you',
				reason: 'permission',
				options: [
					{ id: 'yes', label: 'Yes, apply', keys: 'y', primary: true },
					{ id: 'no', label: 'No, tell Codex what to do differently', keys: '\u001b', deny: true }
				]
			},
			why: 'Codex asks before it applies edits outside its sandbox, and nothing reports that prompt but the screen.'
		},
		{
			id: 'codex.trust-folder',
			when: {
				region: 'screen',
				match: 'do you trust the (files|contents) (in|of) this (folder|directory)|allow codex to work in this folder',
				flags: 'i'
			},
			then: {
				state: 'needs_you',
				reason: 'question',
				prompt: 'Codex asks whether to trust this folder',
				options: [
					{ id: '1', label: 'Yes', keys: '1\r', primary: true },
					{ id: '2', label: 'No', keys: '2\r', deny: true }
				]
			},
			why: 'On a folder it has not seen, Codex asks whether to work in it before anything else.'
		},
		{
			id: 'codex.working',
			when: { region: 'tail', match: 'esc to interrupt' },
			then: { state: 'working' },
			why: 'While a turn runs Codex shows "esc to interrupt": a prompt answered in the terminal is over.'
		}
	]
};

/** A shell has no agent status: no rules (FR-19). */
export const SHELL_RULES: FleetSessionRulesFile = { version: 1, provider: 'shell', rules: [] };

export const SESSION_RULES_FILES: readonly FleetSessionRulesFile[] = [CLAUDE_CODE_RULES, CODEX_RULES, SHELL_RULES];
