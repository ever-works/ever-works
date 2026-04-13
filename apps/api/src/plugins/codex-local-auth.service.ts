import { Injectable, Logger } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureCodexBinary } from './codex-binary';

type LocalAuthSession = {
    process: ChildProcessWithoutNullStreams;
    verificationUri?: string;
    userCode?: string;
    startedAt: number;
    status: 'pending' | 'connected' | 'failed';
    error?: string;
};

export interface CodexLocalAuthStatus {
    installed: boolean;
    connected: boolean;
    pending: boolean;
    authPath: string;
    verificationUri?: string;
    userCode?: string;
    message: string;
}

@Injectable()
export class CodexLocalAuthService {
    private readonly logger = new Logger(CodexLocalAuthService.name);
    private readonly sessionByUser = new Map<string, LocalAuthSession>();

    private async getCodexCommand(): Promise<string> {
        return ensureCodexBinary(this.logger);
    }

    async getStatus(userId: string): Promise<CodexLocalAuthStatus> {
        const installed = await this.isCodexInstalled();
        const authPath = this.getAuthPath();
        const connected = installed ? await this.isConnected() : false;
        const session = this.getActiveSession(userId);

        if (connected && session) {
            this.disposeSession(userId);
        }

        return {
            installed,
            connected,
            pending: Boolean(session && !connected),
            authPath,
            verificationUri: session?.verificationUri,
            userCode: session?.userCode,
            message: this.buildStatusMessage({
                installed,
                connected,
                pending: Boolean(session && !connected),
            }),
        };
    }

    async startDeviceAuth(userId: string): Promise<CodexLocalAuthStatus> {
        const installed = await this.isCodexInstalled();
        const authPath = this.getAuthPath();
        if (!installed) {
            return {
                installed: false,
                connected: false,
                pending: false,
                authPath,
                message: 'Codex CLI is not installed on this machine.',
            };
        }

        if (await this.isConnected()) {
            this.disposeSession(userId);
            return {
                installed: true,
                connected: true,
                pending: false,
                authPath,
                message: 'Local Codex CLI auth is already connected.',
            };
        }

        const existing = this.getActiveSession(userId);
        if (existing?.verificationUri && existing?.userCode) {
            return {
                installed: true,
                connected: false,
                pending: true,
                authPath,
                verificationUri: existing.verificationUri,
                userCode: existing.userCode,
                message: 'Codex device authentication is already in progress.',
            };
        }

        const codexCommand = await this.getCodexCommand();
        const child = spawn(codexCommand, ['login', '--device-auth'], {
            cwd: process.cwd(),
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        const session: LocalAuthSession = {
            process: child,
            startedAt: Date.now(),
            status: 'pending',
        };
        this.sessionByUser.set(userId, session);

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
            const connected = await this.hasAuthFile();
            if (connected) {
                session.status = 'connected';
                this.disposeSession(userId);
                return;
            }

            if (code !== 0 && session.status !== 'connected') {
                session.status = 'failed';
                session.error =
                    stderrBuffer.trim() ||
                    stdoutBuffer.trim() ||
                    `Codex login exited with code ${code}`;
                this.logger.warn(`Codex device auth failed: ${session.error}`);
            }
        });

        child.on('error', (error) => {
            session.status = 'failed';
            session.error = error.message;
            this.logger.warn(`Failed to start Codex device auth: ${error.message}`);
        });

        const ready = await this.waitForDevicePrompt(session, 5_000);
        if (!ready) {
            return {
                installed: true,
                connected: false,
                pending: false,
                authPath,
                message: 'Failed to start Codex device authentication.',
            };
        }

        return {
            installed: true,
            connected: false,
            pending: true,
            authPath,
            verificationUri: session.verificationUri,
            userCode: session.userCode,
            message: 'Open the device-auth page and enter the code shown below.',
        };
    }

    private async waitForDevicePrompt(
        session: LocalAuthSession,
        timeoutMs: number,
    ): Promise<boolean> {
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

    private async isCodexInstalled(): Promise<boolean> {
        try {
            const codexCommand = await this.getCodexCommand();
            return await new Promise((resolve) => {
                const child = spawn(codexCommand, ['--version'], {
                    cwd: process.cwd(),
                    env: process.env,
                    stdio: ['ignore', 'ignore', 'ignore'],
                });

                child.on('exit', (code) => resolve(code === 0));
                child.on('error', () => resolve(false));
            });
        } catch {
            return false;
        }
    }

    private async isConnected(): Promise<boolean> {
        if (await this.hasAuthFile()) {
            return true;
        }

        try {
            const codexCommand = await this.getCodexCommand();
            return await new Promise((resolve) => {
                const child = spawn(codexCommand, ['login', 'status'], {
                    cwd: process.cwd(),
                    env: process.env,
                    stdio: ['ignore', 'pipe', 'pipe'],
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

    private async hasAuthFile(): Promise<boolean> {
        try {
            const stats = await fs.stat(this.getAuthPath());
            return stats.isFile();
        } catch {
            return false;
        }
    }

    private getAuthPath(): string {
        const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
        return path.join(codexHome, 'auth.json');
    }

    private getActiveSession(userId: string): LocalAuthSession | undefined {
        const session = this.sessionByUser.get(userId);
        if (!session) {
            return undefined;
        }

        if (session.process.killed || session.status === 'failed') {
            return undefined;
        }

        return session;
    }

    private disposeSession(userId: string): void {
        const session = this.sessionByUser.get(userId);
        if (session) {
            if (!session.process.killed) {
                session.process.kill('SIGTERM');
            }
            this.sessionByUser.delete(userId);
        }
    }

    private buildStatusMessage(params: {
        installed: boolean;
        connected: boolean;
        pending: boolean;
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

        return 'Local Codex CLI auth is not connected yet.';
    }
}
