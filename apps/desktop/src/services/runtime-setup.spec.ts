import { describe, expect, it } from 'vitest';
import type { RuntimeSelection } from '../shared/ipc-contract';
import type { RuntimeSetupIo } from './runtime-setup';
import {
	DESKTOP_RUNTIME_ENV_KEY,
	applyRuntimeSelection,
	buildEnvEntries,
	detectDocker,
	mergeEnvEntries,
	parseEnvFile,
	serializeEnvFile,
	startDockerInfra
} from './runtime-setup';

function bullmqSelection(overrides: Partial<RuntimeSelection> = {}): RuntimeSelection {
	return {
		runtimeId: 'job-runtime-bullmq',
		values: {},
		database: 'embedded-sqlite',
		useDockerInfra: false,
		...overrides
	};
}

interface FakeIoState {
	files: Record<string, string>;
	commands: Array<{ command: string; args: string[]; cwd?: string }>;
	dockerAvailable: boolean;
	composeFails?: boolean;
}

function fakeIo(state: FakeIoState): RuntimeSetupIo {
	return {
		run: async (command, args, options) => {
			state.commands.push({ command, args, cwd: options?.cwd });
			if (command === 'docker' && args[0] === '--version') {
				return state.dockerAvailable
					? { code: 0, stdout: 'Docker version 27.4.0, build deadbeef', stderr: '' }
					: { code: 1, stdout: '', stderr: 'docker: not found' };
			}
			if (command === 'docker' && args[0] === 'compose') {
				return state.composeFails
					? { code: 1, stdout: '', stderr: 'compose failed' }
					: { code: 0, stdout: 'started', stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		},
		readFile: async (path) => state.files[path],
		writeFile: async (path, content) => {
			state.files[path] = content;
		}
	};
}

describe('buildEnvEntries', () => {
	it('writes BullMQ defaults, service ports and the desktop runtime marker', () => {
		const entries = buildEnvEntries(bullmqSelection());
		expect(entries.PORT).toBe('3100');
		expect(entries.WEB_URL).toBe('http://localhost:3000');
		expect(entries.API_URL).toBe('http://localhost:3100');
		expect(entries[DESKTOP_RUNTIME_ENV_KEY]).toBe('job-runtime-bullmq');
		expect(entries.BULLMQ_REDIS_URL).toBe('redis://localhost:6379');
		expect(entries.BULLMQ_QUEUE_PREFIX).toBe('ever-works');
	});

	it('configures embedded SQLite with the provided database path', () => {
		const entries = buildEnvEntries(bullmqSelection(), { sqliteDbPath: '/data/ever-works.db' });
		expect(entries.DATABASE_TYPE).toBe('sqlite');
		expect(entries.DATABASE_IN_MEMORY).toBe('false');
		expect(entries.DATABASE_PATH).toBe('/data/ever-works.db');
	});

	it('configures docker Postgres with the docker-compose.infra.yml defaults', () => {
		const entries = buildEnvEntries(bullmqSelection({ database: 'docker-postgres', useDockerInfra: true }));
		expect(entries.DATABASE_TYPE).toBe('postgres');
		expect(entries.DATABASE_HOST).toBe('localhost');
		expect(entries.DATABASE_PORT).toBe('5432');
		expect(entries.DATABASE_USERNAME).toBe('postgres');
		expect(entries.DATABASE_PASSWORD).toBe('ever_works_password');
		expect(entries.DATABASE_NAME).toBe('ever_works');
	});

	it('configures an external Postgres via DATABASE_URL', () => {
		const entries = buildEnvEntries(
			bullmqSelection({
				database: 'external-postgres',
				externalDatabaseUrl: 'postgres://u:p@db.example:5432/ew'
			})
		);
		expect(entries.DATABASE_TYPE).toBe('postgres');
		expect(entries.DATABASE_URL).toBe('postgres://u:p@db.example:5432/ew');
	});

	it('lets user values override field defaults and includes Trigger.dev cloud credentials', () => {
		const entries = buildEnvEntries({
			runtimeId: 'job-runtime-trigger',
			values: {
				TRIGGER_SECRET_KEY: 'tr_dev_abc',
				TRIGGER_PROJECT_REF: 'proj_123',
				TRIGGER_API_URL: 'http://localhost:8030'
			},
			database: 'embedded-sqlite',
			useDockerInfra: false
		});
		expect(entries[DESKTOP_RUNTIME_ENV_KEY]).toBe('job-runtime-trigger');
		expect(entries.TRIGGER_SECRET_KEY).toBe('tr_dev_abc');
		expect(entries.TRIGGER_PROJECT_REF).toBe('proj_123');
		expect(entries.TRIGGER_API_URL).toBe('http://localhost:8030');
	});

	it('omits empty optional fields and rejects unknown runtimes', () => {
		const entries = buildEnvEntries({
			runtimeId: 'job-runtime-temporal',
			values: { TEMPORAL_ADDRESS: 'temporal.local:7233' },
			database: 'embedded-sqlite',
			useDockerInfra: false
		});
		expect(entries.TEMPORAL_ADDRESS).toBe('temporal.local:7233');
		expect(entries.TEMPORAL_NAMESPACE).toBe('default');
		expect(entries).not.toHaveProperty('TEMPORAL_TLS_CERT');
		expect(entries).not.toHaveProperty('TEMPORAL_TLS_KEY');

		expect(() =>
			buildEnvEntries({
				runtimeId: 'job-runtime-unknown' as RuntimeSelection['runtimeId'],
				values: {},
				database: 'embedded-sqlite',
				useDockerInfra: false
			})
		).toThrow(/Unknown job runtime/);
	});
});

describe('env file parse/serialize/merge', () => {
	it('round-trips entries through serialize + parse, quoting values with spaces', () => {
		const entries = { FOO: 'bar', SPACED: 'a value with spaces', HASHED: 'x#y' };
		const parsed = parseEnvFile(serializeEnvFile(entries));
		expect(parsed).toEqual(entries);
	});

	it('ignores comments and blank lines when parsing', () => {
		const parsed = parseEnvFile('# comment\n\nKEY=value\nBROKEN LINE\nOTHER=1\n');
		expect(parsed).toEqual({ KEY: 'value', OTHER: '1' });
	});

	it('merge keeps unrelated existing keys and lets generated keys win', () => {
		const merged = mergeEnvEntries({ KEEP: 'me', PORT: '9999' }, { PORT: '3100', NEW: 'yes' });
		expect(merged).toEqual({ KEEP: 'me', PORT: '3100', NEW: 'yes' });
	});
});

describe('docker helpers', () => {
	it('detects docker availability and version', async () => {
		const state: FakeIoState = { files: {}, commands: [], dockerAvailable: true };
		expect(await detectDocker(fakeIo(state))).toEqual({ available: true, version: '27.4.0' });

		state.dockerAvailable = false;
		expect(await detectDocker(fakeIo(state))).toEqual({ available: false });
	});

	it('starts infra via docker compose -f docker-compose.infra.yml up -d in the repo root', async () => {
		const state: FakeIoState = { files: {}, commands: [], dockerAvailable: true };
		const result = await startDockerInfra(fakeIo(state), '/repo');
		expect(result.ok).toBe(true);
		expect(state.commands).toContainEqual({
			command: 'docker',
			args: ['compose', '-f', 'docker-compose.infra.yml', 'up', '-d'],
			cwd: '/repo'
		});
	});
});

describe('applyRuntimeSelection', () => {
	it('writes the merged env file without touching docker when infra is not requested', async () => {
		const state: FakeIoState = {
			files: { '/data/desktop.env': 'CUSTOM=kept\nPORT=9999\n' },
			commands: [],
			dockerAvailable: false
		};
		const result = await applyRuntimeSelection(fakeIo(state), {
			selection: bullmqSelection(),
			envFilePath: '/data/desktop.env',
			repoRoot: '/repo',
			sqliteDbPath: '/data/ever-works.db'
		});
		expect(result.dockerStarted).toBe(false);
		expect(state.commands).toHaveLength(0);
		const written = parseEnvFile(state.files['/data/desktop.env']);
		expect(written.CUSTOM).toBe('kept');
		expect(written.PORT).toBe('3100');
		expect(written.DATABASE_PATH).toBe('/data/ever-works.db');
	});

	it('provisions docker infra when requested and reports it', async () => {
		const state: FakeIoState = { files: {}, commands: [], dockerAvailable: true };
		const result = await applyRuntimeSelection(fakeIo(state), {
			selection: bullmqSelection({ database: 'docker-postgres', useDockerInfra: true }),
			envFilePath: '/data/desktop.env',
			repoRoot: '/repo'
		});
		expect(result.dockerStarted).toBe(true);
		expect(state.commands.some((call) => call.args[0] === 'compose')).toBe(true);
		expect(parseEnvFile(state.files['/data/desktop.env']).DATABASE_HOST).toBe('localhost');
	});

	it('fails fast when docker infra is requested but docker is unavailable', async () => {
		const state: FakeIoState = { files: {}, commands: [], dockerAvailable: false };
		await expect(
			applyRuntimeSelection(fakeIo(state), {
				selection: bullmqSelection({ useDockerInfra: true }),
				envFilePath: '/data/desktop.env',
				repoRoot: '/repo'
			})
		).rejects.toThrow(/Docker is not available/);
		expect(state.files['/data/desktop.env']).toBeUndefined();
	});

	it('surfaces docker compose failures', async () => {
		const state: FakeIoState = { files: {}, commands: [], dockerAvailable: true, composeFails: true };
		await expect(
			applyRuntimeSelection(fakeIo(state), {
				selection: bullmqSelection({ useDockerInfra: true }),
				envFilePath: '/data/desktop.env',
				repoRoot: '/repo'
			})
		).rejects.toThrow(/docker compose up failed/);
	});
});
