'use strict';

const fs = require('node:fs');

const [provider, capturePath, hookMarkerPath, ...args] = process.argv.slice(2);
const versions = {
	'claude-code': '2.1.169 (Claude Code)',
	codex: 'codex-cli 0.120.0'
};

if (args.length === 1 && args[0] === '--version') {
	process.stdout.write(`${versions[provider]}\n`);
	process.exit(0);
}

const unsupported = provider === 'claude-code' ? [] : ['--ignore-user-config'];
const unsupportedArg = args.find((arg) => unsupported.includes(arg));
if (unsupportedArg) {
	process.stderr.write(`${versions[provider]} does not support ${unsupportedArg}`);
	process.exit(64);
}

fs.writeFileSync(
	capturePath,
	JSON.stringify({
		provider,
		args,
		cwd: process.cwd(),
		hasClaudeCredential: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY),
		hasCodexApiKey: Boolean(process.env.CODEX_API_KEY),
		hasCodexAccessToken: Boolean(process.env.CODEX_ACCESS_TOKEN)
	})
);

if (provider === 'claude-code') {
	if (!args.includes('--safe-mode')) {
		const settingsPath = require('node:path').join(process.cwd(), '.claude', 'settings.json');
		if (fs.existsSync(settingsPath)) {
			const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
			if (settings?.hooks?.SessionStart) fs.writeFileSync(hookMarkerPath, 'project hook loaded');
		}
		process.stderr.write('claude-code 2.1.169 requires --safe-mode for leased workspaces');
		process.exit(64);
	}
	if (args.includes('--setting-sources')) {
		process.stderr.write('claude-code safe mode must not enable project setting sources');
		process.exit(64);
	}
	if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
		process.stderr.write('raw Claude credential must not be inherited');
		process.exit(65);
	}
	process.stdout.write(
		JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'fixture done' })
	);
	process.exit(0);
}

if (process.env.CODEX_ACCESS_TOKEN || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) {
	process.stderr.write('raw Codex credential must not be inherited');
	process.exit(65);
}
process.stdout.write(
	`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'fixture done' } })}\n`
);
process.stdout.write(`${JSON.stringify({ type: 'turn.completed' })}\n`);
