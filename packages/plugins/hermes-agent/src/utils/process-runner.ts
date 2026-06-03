import { spawn, type ChildProcess } from 'child_process';
import * as os from 'os';
import { KILL_TIMEOUT_MS, MAX_BUFFER_SIZE } from '../types.js';

// Security (audit C: provider-key exfiltration): the Hermes child runs with the
// `web` toolset (and, when explicitly enabled, `terminal --yolo`), so any prompt
// injection delivered through ingested/web content can run `printenv` + a network
// tool to exfiltrate whatever lives in its environment. We therefore build the
// child env from scratch and allow through ONLY:
//   1. Proxy / TLS plumbing — required for the CLI to reach provider APIs from
//      inside corporate networks and behind self-signed CAs (no secret value).
//   2. The single ACTIVE provider's credential(s) — resolved from the configured
//      `--provider` (allow-list, see PROVIDER_ENV_KEYS), never the broad
//      ~30-key list that used to be forwarded unconditionally.
//   3. `HERMES_`-prefixed vars — Hermes's own namespaced config (e.g.
//      HERMES_INFERENCE_PROVIDER); these are Hermes-specific, not third-party
//      secrets, and selecting a provider via env is part of the supported config.
// This mirrors the codex / claude-code subprocess-env posture (proxy/TLS plumbing
// + provider-scoped credential only).
const PASSTHROUGH_ENV_KEYS = [
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'ALL_PROXY',
	'NO_PROXY',
	'http_proxy',
	'https_proxy',
	'all_proxy',
	'no_proxy',
	'SSL_CERT_FILE',
	'SSL_CERT_DIR',
	'NODE_EXTRA_CA_CERTS',
	'REQUESTS_CA_BUNDLE',
	'CURL_CA_BUNDLE'
] as const;

// Security: provider-scoped credential allow-list. Maps a Hermes `--provider`
// identifier to the ONLY environment variables (API key + optional base-URL
// override) that should be exposed for that provider. When a run resolves an
// active provider we forward just that provider's entry; no other provider's
// key ever enters the child env, so a prompt-injected exfiltration attempt finds
// at most the one credential the run legitimately needs. Keys are matched
// case-insensitively against the configured provider so `OpenRouter`, `openrouter`,
// and an explicit `HERMES_INFERENCE_PROVIDER` all resolve identically.
const PROVIDER_ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
	openrouter: ['OPENROUTER_API_KEY'],
	openai: ['OPENAI_API_KEY'],
	nous: ['NOUS_API_KEY'],
	anthropic: ['ANTHROPIC_API_KEY'],
	google: ['GOOGLE_API_KEY'],
	gemini: ['GEMINI_API_KEY', 'GEMINI_BASE_URL'],
	glm: ['GLM_API_KEY', 'GLM_BASE_URL'],
	kimi: ['KIMI_API_KEY', 'KIMI_BASE_URL'],
	kimi_cn: ['KIMI_CN_API_KEY'],
	arceeai: ['ARCEEAI_API_KEY', 'ARCEE_BASE_URL'],
	arcee: ['ARCEEAI_API_KEY', 'ARCEE_BASE_URL'],
	minimax: ['MINIMAX_API_KEY', 'MINIMAX_BASE_URL'],
	minimax_cn: ['MINIMAX_CN_API_KEY', 'MINIMAX_CN_BASE_URL'],
	opencode_zen: ['OPENCODE_ZEN_API_KEY', 'OPENCODE_ZEN_BASE_URL'],
	opencode_go: ['OPENCODE_GO_API_KEY', 'OPENCODE_GO_BASE_URL'],
	huggingface: ['HF_TOKEN'],
	hf: ['HF_TOKEN'],
	nvidia: ['NVIDIA_API_KEY'],
	xiaomi: ['XIAOMI_API_KEY', 'XIAOMI_BASE_URL'],
	ollama: ['OLLAMA_API_KEY', 'OLLAMA_BASE_URL'],
	ai_gateway: ['AI_GATEWAY_API_KEY']
};

// Security: tool-provider credentials the Hermes `web`/`skills` toolsets may need
// to reach search / crawl / browser back-ends. These are exposed regardless of the
// chosen inference provider because the web toolset can use any of them, but the
// list is an explicit allow-list (no DB/auth/host secrets) rather than the former
// blanket forward, and is intentionally narrow. Kept separate from
// PROVIDER_ENV_KEYS so the inference-provider scoping stays exact.
const TOOL_PROVIDER_ENV_KEYS = [
	'EXA_API_KEY',
	'PARALLEL_API_KEY',
	'FIRECRAWL_API_KEY',
	'FIRECRAWL_API_URL',
	'TAVILY_API_KEY',
	'BROWSERBASE_API_KEY',
	'BROWSER_USE_API_KEY'
] as const;

const PASSTHROUGH_ENV_PREFIXES = ['HERMES_'] as const;

// Security: normalize a provider identifier to its PROVIDER_ENV_KEYS lookup form.
// Lower-cases and collapses separators (`-`, ` `) to `_` so CLI-friendly names
// (`opencode-zen`, `minimax cn`) resolve to the canonical allow-list key.
function normalizeProviderId(provider: string): string {
	return provider
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, '_');
}

// Security: resolve the env keys for the ACTIVE inference provider. Prefers the
// explicit `--provider` override; falls back to HERMES_INFERENCE_PROVIDER (the
// env-driven selector). Returns an empty list for an unknown / unset provider so
// NOTHING is forwarded by default — when the provider cannot be identified, the
// Hermes profile is the source of truth for credentials (README), and we must not
// guess-and-leak. Legitimate env-keyed runs always set a recognized provider.
function resolveProviderEnvKeys(provider: string | undefined): readonly string[] {
	const candidates = [provider, process.env.HERMES_INFERENCE_PROVIDER];
	for (const candidate of candidates) {
		if (typeof candidate !== 'string' || !candidate.trim()) {
			continue;
		}
		const keys = PROVIDER_ENV_KEYS[normalizeProviderId(candidate)];
		if (keys) {
			return keys;
		}
	}
	return [];
}

export interface ExecuteOptions {
	readonly binaryPath: string;
	readonly prompt: string;
	readonly cwd: string;
	readonly profile: string;
	readonly toolsets: string;
	readonly provider?: string;
	readonly model?: string;
	readonly skills?: string;
	readonly maxTurns: number;
	readonly yolo: boolean;
	readonly signal?: AbortSignal;
	readonly onStdoutLine?: (line: string) => void;
	readonly onStderrLine?: (line: string) => void;
}

export interface ExecuteResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly killed: boolean;
	readonly duration: number;
}

// Security: these values are passed as separate argv elements to spawn() (no
// shell), so they cannot inject shell metacharacters. They can, however, be
// parsed by the Hermes CLI as option *flags* if they begin with '-' (e.g. a
// `skills` value of '--output' smuggled in via a settings write). Reject any
// such value to prevent CLI option injection. Legitimate profile / toolset /
// provider / model / skill identifiers never start with '-'.
function assertNotOptionLike(field: string, value: string): void {
	if (value.startsWith('-')) {
		throw new Error(`Invalid Hermes ${field}: value must not start with "-"`);
	}
}

export function buildHermesArgs(options: ExecuteOptions): string[] {
	// Security: guard each user/admin-controlled value against CLI option injection.
	assertNotOptionLike('profile', options.profile);
	assertNotOptionLike('toolsets', options.toolsets);
	if (options.provider) {
		assertNotOptionLike('provider', options.provider);
	}
	if (options.model) {
		assertNotOptionLike('model', options.model);
	}
	if (options.skills) {
		assertNotOptionLike('skills', options.skills);
	}

	const args = ['-p', options.profile, 'chat', '--quiet', '--toolsets', options.toolsets];

	if (options.yolo) {
		args.push('--yolo');
	}

	if (options.provider) {
		args.push('--provider', options.provider);
	}

	if (options.model) {
		args.push('--model', options.model);
	}

	if (options.skills) {
		args.push('--skills', options.skills);
	}

	args.push('--max-turns', String(options.maxTurns), '--query', options.prompt);

	return args;
}

// Security: `provider` is the resolved Hermes `--provider` override (may be
// undefined when the profile selects the provider). Only that provider's
// credential is forwarded — never the full multi-provider key set.
export function buildHermesEnv(cwd: string, provider?: string): Record<string, string> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
		HOME: process.env.HOME ?? os.homedir(),
		TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
		TERMINAL_CWD: cwd
	};

	// Proxy / TLS plumbing (no secrets).
	for (const key of PASSTHROUGH_ENV_KEYS) {
		const value = process.env[key];
		if (value) {
			env[key] = value;
		}
	}

	// Active inference provider's credential only (provider-scoped allow-list).
	for (const key of resolveProviderEnvKeys(provider)) {
		const value = process.env[key];
		if (value) {
			env[key] = value;
		}
	}

	// Narrow tool-provider (search/crawl/browser) credentials the web toolset may use.
	for (const key of TOOL_PROVIDER_ENV_KEYS) {
		const value = process.env[key];
		if (value) {
			env[key] = value;
		}
	}

	// Hermes's own namespaced config (HERMES_*), e.g. HERMES_INFERENCE_PROVIDER.
	for (const [key, value] of Object.entries(process.env)) {
		if (!value) {
			continue;
		}

		if (PASSTHROUGH_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
			env[key] = value;
		}
	}

	return env;
}

export function executeHermes(options: ExecuteOptions): {
	promise: Promise<ExecuteResult>;
	kill: () => void;
} {
	let childProcess: ChildProcess | null = null;
	let killed = false;
	let abortListener: (() => void) | null = null;

	const kill = () => {
		if (!childProcess || killed) return;
		killed = true;
		childProcess.kill('SIGTERM');

		const killTimer = setTimeout(() => {
			if (childProcess && !childProcess.killed) {
				childProcess.kill('SIGKILL');
			}
		}, KILL_TIMEOUT_MS);

		childProcess.on('exit', () => clearTimeout(killTimer));
	};

	const promise = new Promise<ExecuteResult>((resolve, reject) => {
		const startTime = Date.now();
		const args = buildHermesArgs(options);

		childProcess = spawn(options.binaryPath, args, {
			cwd: options.cwd,
			env: buildHermesEnv(options.cwd, options.provider),
			stdio: ['ignore', 'pipe', 'pipe']
		});

		const cleanupAbortListener = () => {
			if (options.signal && abortListener) {
				options.signal.removeEventListener('abort', abortListener);
				abortListener = null;
			}
		};

		let stdout = '';
		let stderr = '';
		let stdoutRemainder = '';
		let stderrRemainder = '';

		childProcess.stdout?.on('data', (chunk: Buffer) => {
			const text = chunk.toString('utf-8');
			if (stdout.length < MAX_BUFFER_SIZE) {
				stdout += text;
				if (stdout.length > MAX_BUFFER_SIZE) {
					stdout = stdout.slice(0, MAX_BUFFER_SIZE);
				}
			}

			const combined = stdoutRemainder + text;
			const lines = combined.split('\n');
			stdoutRemainder = lines.pop() ?? '';
			for (const line of lines) {
				if (line.trim()) {
					options.onStdoutLine?.(line);
				}
			}
		});

		childProcess.stderr?.on('data', (chunk: Buffer) => {
			const text = chunk.toString('utf-8');
			if (stderr.length < MAX_BUFFER_SIZE) {
				stderr += text;
				if (stderr.length > MAX_BUFFER_SIZE) {
					stderr = stderr.slice(0, MAX_BUFFER_SIZE);
				}
			}

			const combined = stderrRemainder + text;
			const lines = combined.split('\n');
			stderrRemainder = lines.pop() ?? '';
			for (const line of lines) {
				if (line.trim()) {
					options.onStderrLine?.(line);
				}
			}
		});

		childProcess.on('error', (error) => {
			cleanupAbortListener();
			reject(error);
		});
		childProcess.on('exit', (code) => {
			cleanupAbortListener();
			if (stdoutRemainder.trim()) {
				options.onStdoutLine?.(stdoutRemainder);
			}
			if (stderrRemainder.trim()) {
				options.onStderrLine?.(stderrRemainder);
			}

			resolve({
				stdout,
				stderr,
				exitCode: code,
				killed,
				duration: Date.now() - startTime
			});
		});

		if (options.signal) {
			if (options.signal.aborted) {
				kill();
			} else {
				abortListener = kill;
				options.signal.addEventListener('abort', abortListener, { once: true });
			}
		}
	});

	return { promise, kill };
}
