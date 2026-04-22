import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { DeviceAuthStatus } from '@ever-works/plugin';

import { ensureBinary } from './utils/binary-manager.js';
import { buildSubprocessEnv } from './utils/subprocess-env.js';
import { getManagedCodexHome } from './utils/codex-home.js';

type LoggerLike = {
	log(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	debug?(message: string, ...args: unknown[]): void;
};

type DeviceAuthSession = {
	process: ReturnType<typeof spawn>;
	verificationUri?: string;
	userCode?: string;
	startedAt: number;
	status: 'pending' | 'connected' | 'failed';
	error?: string;
};

const sessionByUser = new Map<string, DeviceAuthSession>();
const lastFailureByUser = new Map<string, string>();
const DEVICE_AUTH_PROMPT_DISCOVERY_TIMEOUT_MS = 30_000;
const DEVICE_AUTH_SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const DEVICE_AUTH_PROMPT_POLL_INTERVAL_MS = 100;
const DEVICE_AUTH_EXPIRED_MESSAGE =
	'Codex device authentication expired before it was completed. Restart the device-auth flow.';

function getBinaryLogger(logger?: LoggerLike) {
	if (!logger) {
		return undefined;
	}

	return {
		log: logger.log.bind(logger),
		debug: (logger.debug ?? logger.log).bind(logger),
		warn: logger.warn.bind(logger)
	};
}

export async function getDeviceAuthStatus(userId: string, logger?: LoggerLike): Promise<DeviceAuthStatus> {
	const codexHome = getManagedCodexHome(userId);
	const installed = await isCodexInstalled(logger);
	const connected = installed ? await verifyDeviceAuthConnection(codexHome, logger) : false;
	const session = getActiveSession(userId);

	if (connected && session) {
		disposeSession(userId);
	}

	if (connected) {
		lastFailureByUser.delete(userId);
	}

	return {
		installed,
		connected,
		pending: Boolean(session && !connected),
		scope: 'user',
		flowType: 'device-code',
		prompt:
			session?.verificationUri && session?.userCode
				? {
						verificationUri: session.verificationUri,
						userCode: session.userCode
					}
				: undefined,
		message: buildStatusMessage({
			installed,
			connected,
			pending: Boolean(session && !connected),
			lastFailure: lastFailureByUser.get(userId)
		})
	};
}

export async function startDeviceAuth(userId: string, logger?: LoggerLike): Promise<DeviceAuthStatus> {
	const codexHome = getManagedCodexHome(userId);
	const installed = await isCodexInstalled(logger);
	if (!installed) {
		return {
			installed: false,
			connected: false,
			pending: false,
			scope: 'user',
			flowType: 'device-code',
			message: 'Codex CLI is not installed on this machine.'
		};
	}

	if (await isConnected(codexHome, logger)) {
		disposeSession(userId);
		lastFailureByUser.delete(userId);
		return {
			installed: true,
			connected: true,
			pending: false,
			scope: 'user',
			flowType: 'device-code',
			message: 'Codex device authentication is already connected for this user.'
		};
	}

	const existing = getActiveSession(userId);
	if (existing) {
		return {
			installed: true,
			connected: false,
			pending: true,
			scope: 'user',
			flowType: 'device-code',
			prompt:
				existing.verificationUri && existing.userCode
					? {
							verificationUri: existing.verificationUri,
							userCode: existing.userCode
						}
					: undefined,
			message: existing.verificationUri
				? 'Codex device authentication is already in progress.'
				: 'Codex device authentication is starting...'
		};
	}

	const codexCommand = await ensureBinary(undefined, getBinaryLogger(logger));
	await fs.mkdir(codexHome, { recursive: true });
	lastFailureByUser.delete(userId);
	const child = spawn(codexCommand, ['login', '--device-auth'], {
		cwd: process.cwd(),
		env: buildSubprocessEnv({ CODEX_HOME: codexHome }),
		stdio: ['ignore', 'pipe', 'pipe']
	});

	const session: DeviceAuthSession = {
		process: child,
		startedAt: Date.now(),
		status: 'pending'
	};
	sessionByUser.set(userId, session);

	let stdoutBuffer = '';
	let stderrBuffer = '';

	const applyOutput = (text: string) => {
		const lines = text.split(/\r?\n/u);
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}

			if (!session.verificationUri) {
				const urlMatch = trimmed.match(/https:\/\/auth\.openai\.com\/codex\/device/iu);
				if (urlMatch?.[0]) {
					session.verificationUri = urlMatch[0];
				}
			}

			if (!session.userCode) {
				const codeMatch = trimmed.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/u);
				if (codeMatch?.[0]) {
					session.userCode = codeMatch[0];
				}
			}
		}
	};

	child.stdout.on('data', (chunk) => {
		stdoutBuffer += chunk.toString('utf-8');
		applyOutput(stdoutBuffer);
	});

	child.stderr.on('data', (chunk) => {
		stderrBuffer += chunk.toString('utf-8');
		applyOutput(stderrBuffer);
	});

	child.on('exit', async (code) => {
		const connected = await hasAuthFile(codexHome);
		if (connected) {
			session.status = 'connected';
			disposeSession(userId);
			return;
		}

		if (session.status !== 'connected') {
			session.status = 'failed';
			session.error =
				code !== 0
					? stderrBuffer.trim() || stdoutBuffer.trim() || `Codex login exited with code ${code}`
					: 'Codex login exited successfully but auth file was not found.';
			lastFailureByUser.set(userId, session.error);
			logger?.warn(`Codex device auth failed: ${session.error}`);
			disposeSession(userId);
		}
	});

	child.on('error', (error) => {
		session.status = 'failed';
		session.error = error.message;
		lastFailureByUser.set(userId, error.message);
		logger?.warn(`Failed to start Codex device auth: ${error.message}`);
		disposeSession(userId);
	});

	const ready = await waitForDevicePrompt(session, DEVICE_AUTH_PROMPT_DISCOVERY_TIMEOUT_MS);
	if (!ready) {
		if (session.status === 'failed') {
			return {
				installed: true,
				connected: false,
				pending: false,
				scope: 'user',
				flowType: 'device-code',
				message: session.error || 'Failed to start Codex device authentication.'
			};
		}

		return {
			installed: true,
			connected: false,
			pending: true,
			scope: 'user',
			flowType: 'device-code',
			prompt:
				session.verificationUri && session.userCode
					? {
							verificationUri: session.verificationUri,
							userCode: session.userCode
						}
					: undefined,
			message: 'Codex device authentication is starting on the backend machine.'
		};
	}

	return {
		installed: true,
		connected: false,
		pending: true,
		scope: 'user',
		flowType: 'device-code',
		prompt:
			session.verificationUri && session.userCode
				? {
						verificationUri: session.verificationUri,
						userCode: session.userCode
					}
				: undefined,
		message: 'Open the device-auth page and enter the code shown below.'
	};
}

export async function verifyDeviceAuthConnection(codexHome?: string, logger?: LoggerLike): Promise<boolean> {
	return isConnected(codexHome, logger);
}

async function waitForDevicePrompt(session: DeviceAuthSession, timeoutMs: number): Promise<boolean> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (session.verificationUri && session.userCode) {
			return true;
		}

		if (session.status === 'failed') {
			return false;
		}

		await new Promise((resolve) => setTimeout(resolve, DEVICE_AUTH_PROMPT_POLL_INTERVAL_MS));
	}

	return false;
}

async function isCodexInstalled(logger?: LoggerLike): Promise<boolean> {
	try {
		const codexCommand = await ensureBinary(undefined, getBinaryLogger(logger));
		return await new Promise((resolve) => {
			const child = spawn(codexCommand, ['--version'], {
				cwd: process.cwd(),
				env: buildSubprocessEnv(),
				stdio: ['ignore', 'ignore', 'ignore']
			});

			child.on('exit', (code) => resolve(code === 0));
			child.on('error', () => resolve(false));
		});
	} catch {
		return false;
	}
}

async function isConnected(codexHome?: string, logger?: LoggerLike): Promise<boolean> {
	if (await hasAuthFile(codexHome)) {
		return true;
	}

	try {
		const codexCommand = await ensureBinary(undefined, getBinaryLogger(logger));
		return await new Promise((resolve) => {
			const child = spawn(codexCommand, ['login', 'status'], {
				cwd: process.cwd(),
				env: buildSubprocessEnv(codexHome ? { CODEX_HOME: codexHome } : {}),
				stdio: ['ignore', 'pipe', 'pipe']
			});

			let output = '';
			child.stdout.on('data', (chunk) => {
				output += chunk.toString('utf-8');
			});
			child.stderr.on('data', (chunk) => {
				output += chunk.toString('utf-8');
			});

			child.on('exit', (code) => {
				resolve(code === 0 && output.toLowerCase().includes('logged in'));
			});
			child.on('error', () => resolve(false));
		});
	} catch {
		return false;
	}
}

async function hasAuthFile(codexHome?: string): Promise<boolean> {
	try {
		const stats = await fs.stat(getAuthPath(codexHome));
		return stats.isFile();
	} catch {
		return false;
	}
}

function getAuthPath(codexHome?: string): string {
	const resolvedCodexHome = codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
	return path.join(resolvedCodexHome, 'auth.json');
}

function getActiveSession(userId: string): DeviceAuthSession | undefined {
	const session = sessionByUser.get(userId);
	if (!session) {
		return undefined;
	}

	if (isExpiredSession(session)) {
		expireSession(userId, DEVICE_AUTH_EXPIRED_MESSAGE);
		return undefined;
	}

	if (session.process.killed || session.status === 'failed') {
		sessionByUser.delete(userId);
		return undefined;
	}

	return session;
}

function isExpiredSession(session: DeviceAuthSession): boolean {
	return session.status === 'pending' && Date.now() - session.startedAt > DEVICE_AUTH_SESSION_TIMEOUT_MS;
}

function expireSession(userId: string, message: string): void {
	const session = sessionByUser.get(userId);
	if (!session) {
		lastFailureByUser.set(userId, message);
		return;
	}

	session.status = 'failed';
	session.error = message;
	lastFailureByUser.set(userId, message);
	disposeSession(userId);
}

function disposeSession(userId: string): void {
	const session = sessionByUser.get(userId);
	if (session) {
		if (!session.process.killed) {
			session.process.kill('SIGTERM');
		}
		sessionByUser.delete(userId);
	}
}

function buildStatusMessage(params: {
	installed: boolean;
	connected: boolean;
	pending: boolean;
	lastFailure?: string;
}): string {
	if (!params.installed) {
		return 'Codex CLI is not installed on this machine.';
	}

	if (params.connected) {
		return 'Local Codex CLI auth is connected on this machine.';
	}

	if (params.pending) {
		return 'Codex device authentication is in progress.';
	}

	if (params.lastFailure) {
		return `Last local auth attempt failed: ${params.lastFailure}`;
	}

	return 'Local Codex CLI auth is not connected yet.';
}
