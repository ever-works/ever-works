import { describe, expect, it } from 'vitest';
import type { PrereqCheckResult, RemoteConnection, RuntimeSelection } from '../../shared/ipc-contract';
import type { WizardProgress } from './steps';
import {
	LOCAL_WIZARD_STEPS,
	REMOTE_WIZARD_STEPS,
	WIZARD_STEPS,
	canAdvance,
	computeStepList,
	firstIncompleteStep,
	isRemoteMode,
	nextStep,
	previousStep,
	remoteReady,
	selectionValid
} from './steps';

function prereqs(nodeOk: boolean, dockerOk = false): PrereqCheckResult[] {
	return [
		{ id: 'node', label: 'Node.js >= 22', required: true, found: nodeOk, ok: nodeOk },
		{ id: 'pnpm', label: 'pnpm', required: true, found: true, ok: true },
		{ id: 'docker', label: 'Docker (optional)', required: false, found: dockerOk, ok: dockerOk }
	];
}

function bullmqSelection(overrides: Partial<RuntimeSelection> = {}): RuntimeSelection {
	return {
		runtimeId: 'job-runtime-bullmq',
		values: {},
		database: 'embedded-sqlite',
		useDockerInfra: false,
		...overrides
	};
}

const remote: RemoteConnection = { webUrl: 'https://app.example.com', apiUrl: 'https://api.example.com' };

/** Local-stack progress (the default flow) with the mode already chosen. */
function progress(overrides: Partial<WizardProgress> = {}): WizardProgress {
	return { mode: 'local-stack', envWritten: false, servicesHealthy: false, ...overrides };
}

function remoteProgress(overrides: Partial<WizardProgress> = {}): WizardProgress {
	return { mode: 'remote-client', envWritten: false, servicesHealthy: false, ...overrides };
}

describe('computeStepList', () => {
	it('runs welcome → mode → prereq → runtime → env → boot → open for the local stack', () => {
		expect(computeStepList(progress())).toEqual(['welcome', 'mode', 'prereq', 'runtime', 'env', 'boot', 'open']);
		expect(WIZARD_STEPS).toEqual(LOCAL_WIZARD_STEPS);
		expect(LOCAL_WIZARD_STEPS).toHaveLength(7);
	});

	it('skips the whole local-stack setup in client mode', () => {
		expect(computeStepList(remoteProgress())).toEqual(['welcome', 'mode', 'remote', 'open']);
		expect(REMOTE_WIZARD_STEPS).toHaveLength(4);
	});

	it('defaults to the local flow before a mode is chosen', () => {
		const undecided: WizardProgress = { envWritten: false, servicesHealthy: false };
		expect(isRemoteMode(undecided)).toBe(false);
		expect(computeStepList(undecided)).toEqual([...LOCAL_WIZARD_STEPS]);
	});
});

describe('selectionValid', () => {
	it('accepts a runtime whose required fields resolve via defaults (BullMQ)', () => {
		expect(selectionValid(bullmqSelection())).toBe(true);
	});

	it('rejects a runtime with missing required credentials (Trigger.dev without secret key)', () => {
		expect(
			selectionValid({
				runtimeId: 'job-runtime-trigger',
				values: { TRIGGER_PROJECT_REF: 'proj_123' },
				database: 'embedded-sqlite',
				useDockerInfra: false
			})
		).toBe(false);
	});

	it('rejects external Postgres without a connection URL', () => {
		expect(selectionValid(bullmqSelection({ database: 'external-postgres' }))).toBe(false);
		expect(
			selectionValid(
				bullmqSelection({ database: 'external-postgres', externalDatabaseUrl: 'postgres://u:p@h/db' })
			)
		).toBe(true);
	});

	it('rejects docker Postgres unless docker infra is enabled, and unknown runtimes outright', () => {
		expect(selectionValid(bullmqSelection({ database: 'docker-postgres' }))).toBe(false);
		expect(selectionValid(bullmqSelection({ database: 'docker-postgres', useDockerInfra: true }))).toBe(true);
		expect(
			selectionValid({
				runtimeId: 'job-runtime-unknown' as RuntimeSelection['runtimeId'],
				values: {},
				database: 'embedded-sqlite',
				useDockerInfra: false
			})
		).toBe(false);
	});
});

describe('canAdvance / nextStep gating', () => {
	it('blocks the mode step until a mode is picked', () => {
		expect(canAdvance('mode', { envWritten: false, servicesHealthy: false })).toBe(false);
		expect(canAdvance('mode', progress())).toBe(true);
		expect(canAdvance('mode', remoteProgress())).toBe(true);
	});

	it('blocks the prereq step until required prerequisites pass (docker stays optional)', () => {
		expect(canAdvance('prereq', progress())).toBe(false);
		expect(canAdvance('prereq', progress({ prereqResults: prereqs(false) }))).toBe(false);
		expect(canAdvance('prereq', progress({ prereqResults: prereqs(true, false) }))).toBe(true);
		expect(nextStep('prereq', progress({ prereqResults: prereqs(false) }))).toBeNull();
	});

	it('walks the local happy path in order once each condition is met', () => {
		const complete = progress({
			prereqResults: prereqs(true, true),
			selection: bullmqSelection(),
			envWritten: true,
			servicesHealthy: true
		});
		expect(nextStep('welcome', complete)).toBe('mode');
		expect(nextStep('mode', complete)).toBe('prereq');
		expect(nextStep('prereq', complete)).toBe('runtime');
		expect(nextStep('runtime', complete)).toBe('env');
		expect(nextStep('env', complete)).toBe('boot');
		expect(nextStep('boot', complete)).toBe('open');
		expect(nextStep('open', complete)).toBeNull();
	});

	it('walks the client-mode path welcome → mode → remote → open', () => {
		const complete = remoteProgress({ remoteConnection: remote, remoteVerified: true });
		expect(nextStep('welcome', complete)).toBe('mode');
		expect(nextStep('mode', complete)).toBe('remote');
		expect(nextStep('remote', complete)).toBe('open');
		expect(nextStep('open', complete)).toBeNull();
	});

	it('blocks the remote step until the instance answered its health probe', () => {
		expect(remoteReady(remoteProgress())).toBe(false);
		expect(remoteReady(remoteProgress({ remoteConnection: remote }))).toBe(false);
		expect(remoteReady(remoteProgress({ remoteConnection: remote, remoteVerified: true }))).toBe(true);
		expect(canAdvance('remote', remoteProgress({ remoteConnection: remote }))).toBe(false);
		expect(nextStep('remote', remoteProgress({ remoteConnection: remote }))).toBeNull();
	});

	it('blocks env until written and boot until services are healthy', () => {
		const base = progress({ prereqResults: prereqs(true), selection: bullmqSelection() });
		expect(nextStep('env', base)).toBeNull();
		expect(nextStep('env', { ...base, envWritten: true })).toBe('boot');
		expect(nextStep('boot', { ...base, envWritten: true })).toBeNull();
		expect(nextStep('boot', { ...base, envWritten: true, servicesHealthy: true })).toBe('open');
	});

	it('supports going back except from the first step', () => {
		expect(previousStep('welcome', progress())).toBeNull();
		expect(previousStep('mode', progress())).toBe('welcome');
		expect(previousStep('runtime', progress())).toBe('prereq');
		expect(previousStep('open', progress())).toBe('boot');
		expect(previousStep('open', remoteProgress())).toBe('remote');
	});

	it('resumes at the first incomplete step', () => {
		expect(firstIncompleteStep({ envWritten: false, servicesHealthy: false })).toBe('mode');
		expect(firstIncompleteStep(progress())).toBe('prereq');
		expect(firstIncompleteStep(progress({ prereqResults: prereqs(true) }))).toBe('runtime');
		expect(
			firstIncompleteStep(
				progress({ prereqResults: prereqs(true), selection: bullmqSelection(), envWritten: true })
			)
		).toBe('boot');
		expect(
			firstIncompleteStep(
				progress({
					prereqResults: prereqs(true),
					selection: bullmqSelection(),
					envWritten: true,
					servicesHealthy: true
				})
			)
		).toBe('open');
	});

	it('resumes a client-mode wizard at the remote step until it is verified', () => {
		expect(firstIncompleteStep(remoteProgress())).toBe('remote');
		expect(firstIncompleteStep(remoteProgress({ remoteConnection: remote, remoteVerified: true }))).toBe('open');
	});
});
