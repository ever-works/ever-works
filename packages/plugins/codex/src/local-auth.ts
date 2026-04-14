import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { LocalAuthStatus } from '@ever-works/plugin';

import { ensureBinary } from './utils/binary-manager.js';

type LoggerLike = {
	log(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	debug?(message: string, ...args: unknown[]): void;
};

type LocalAuthSession = {
	process: ReturnType<typeof spawn>;
	verificationUri?: string;
	userCode?: string;
	startedAt: number;
	status: 'pending' | 'connected' | 'failed';
	error?: string;
};

const sessionByUser = new Map<string, LocalAuthSession>();

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

export async function getLocalAuthStatus(userId: string, logger?: LoggerLike): Promise<LocalAuthStatus> {
	const installed = await isCodexInstalled(logger);
	const authPath = getAuthPath();
	const connected = installed ? await isConnected(logger) : false;
	const session = getActiveSession(userId);

	if (connected && session) {
		disposeSession(userId);
	}

	return {
		installed,
		connected,
		pending: Boolean(session && !connected),
		authPath,
		verificationUri: session?.verificationUri,
		userCode: session?.userCode,
		message: buildStatusMessage({
			installed,
			connected,
			pending: Boolean(session && !connected)
		})
	};
}

export async function startLocalAuth(userId: string, logger?: LoggerLike): Promise<LocalAuthStatus> {
	const installed = await isCodexInstalled(logger);
	const authPath = getAuthPath();
	if (!installed) {
		return {
			installed: false,
			connected: false,
			pending: false,
			authPath,
			message: 'Codex CLI is not installed on this machine.'
		};
	}

	if (await isConnected(logger)) {
		disposeSession(userId);
		return {
			installed: true,
			connected: true,
			pending: false,
			authPath,
			message: 'Local Codex CLI auth is already connected.'
		};
	}

	const existing = getActiveSession(userId);
	if (existing?.verificationUri && existing?.userCode) {
		return {
			installed: true,
			connected: false,
			pending: true,
			authPath,
			verificationUri: existing.verificationUri,
			userCode: existing.userCode,
			message: 'Codex device authentication is already in progress.'
		};
	}

	const codexCommand = await ensureBinary(undefined, getBinaryLogger(logger));
	const child = spawn(codexCommand, ['login', '--device-auth'], {
		cwd: process.cwd(),
		env: process.env,
		stdio: ['ignore', 'pipe', 'pipe']
	});

	const session: LocalAuthSession = {
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
		const connected = await hasAuthFile();
		if (connected) {
			session.status = 'connected';
			disposeSession(userId);
			return;
		}

		if (code !== 0 && session.status !== 'connected') {
			session.status = 'failed';
			session.error = stderrBuffer.trim() || stdoutBuffer.trim() || `Codex login exited with code ${code}`;
			logger?.warn(`Codex device auth failed: ${session.error}`);
			disposeSession(userId);
		}
	});

	child.on('error', (error) => {
		session.status = 'failed';
		session.error = error.message;
		logger?.warn(`Failed to start Codex device auth: ${error.message}`);
		disposeSession(userId);
	});

	const ready = await waitForDevicePrompt(session, 5000);
	if (!ready) {
		session.status = 'failed';
		session.error = 'Timed out waiting for Codex device authentication prompt.';
		disposeSession(userId);
		return {
			installed: true,
			connected: false,
			pending: false,
			authPath,
			message: 'Failed to start Codex device authentication.'
		};
	}

	return {
		installed: true,
		connected: false,
		pending: true,
		authPath,
		verificationUri: session.verificationUri,
		userCode: session.userCode,
		message: 'Open the device-auth page and enter the code shown below.'
	};
}

async function waitForDevicePrompt(session: LocalAuthSession, timeoutMs: number): Promise<boolean> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (session.verificationUri && session.userCode) {
			return true;
		}

		if (session.status === 'failed') {
			return false;
		}

		await new Promise((resolve) => setTimeout(resolve, 100));
	}

	return false;
}

async function isCodexInstalled(logger?: LoggerLike): Promise<boolean> {
	try {
		const codexCommand = await ensureBinary(undefined, getBinaryLogger(logger));
		return await new Promise((resolve) => {
			const child = spawn(codexCommand, ['--version'], {
				cwd: process.cwd(),
				env: process.env,
				stdio: ['ignore', 'ignore', 'ignore']
			});

			child.on('exit', (code) => resolve(code === 0));
			child.on('error', () => resolve(false));
		});
	} catch {
		return false;
	}
}

async function isConnected(logger?: LoggerLike): Promise<boolean> {
	if (await hasAuthFile()) {
		return true;
	}

	try {
		const codexCommand = await ensureBinary(undefined, getBinaryLogger(logger));
		return await new Promise((resolve) => {
			const child = spawn(codexCommand, ['login', 'status'], {
				cwd: process.cwd(),
				env: process.env,
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

async function hasAuthFile(): Promise<boolean> {
	try {
		const stats = await fs.stat(getAuthPath());
		return stats.isFile();
	} catch {
		return false;
	}
}

function getAuthPath(): string {
	const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
	return path.join(codexHome, 'auth.json');
}

function getActiveSession(userId: string): LocalAuthSession | undefined {
	const session = sessionByUser.get(userId);
	if (!session) {
		return undefined;
	}

	if (session.process.killed || session.status === 'failed') {
		sessionByUser.delete(userId);
		return undefined;
	}

	return session;
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

function buildStatusMessage(params: { installed: boolean; connected: boolean; pending: boolean }): string {
	if (!params.installed) {
		return 'Codex CLI is not installed on this machine.';
	}

	if (params.connected) {
		return 'Local Codex CLI auth is connected on this machine.';
	}

	if (params.pending) {
		return 'Codex device authentication is in progress.';
	}

	return 'Local Codex CLI auth is not connected yet.';
}
