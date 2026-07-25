import { describe, expect, it } from 'vitest';
import type { PrereqCheckResult, RuntimeSelection } from '../../shared/ipc-contract';
import type { WizardProgress } from './steps';
import {
	WIZARD_STEPS,
	canAdvance,
	computeStepList,
	firstIncompleteStep,
	nextStep,
	previousStep,
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

function progress(overrides: Partial<WizardProgress> = {}): WizardProgress {
	return { envWritten: false, servicesHealthy: false, ...overrides };
}

describe('computeStepList', () => {
	it('runs welcome → prereq → runtime → env → boot → open', () => {
		expect(computeStepList(progress())).toEqual(['welcome', 'prereq', 'runtime', 'env', 'boot', 'open']);
		expect(WIZARD_STEPS).toHaveLength(6);
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
	it('blocks the prereq step until required prerequisites pass (docker stays optional)', () => {
		expect(canAdvance('prereq', progress())).toBe(false);
		expect(canAdvance('prereq', progress({ prereqResults: prereqs(false) }))).toBe(false);
		expect(canAdvance('prereq', progress({ prereqResults: prereqs(true, false) }))).toBe(true);
		expect(nextStep('prereq', progress({ prereqResults: prereqs(false) }))).toBeNull();
	});

	it('walks the happy path in order once each condition is met', () => {
		const complete = progress({
			prereqResults: prereqs(true, true),
			selection: bullmqSelection(),
			envWritten: true,
			servicesHealthy: true
		});
		expect(nextStep('welcome', complete)).toBe('prereq');
		expect(nextStep('prereq', complete)).toBe('runtime');
		expect(nextStep('runtime', complete)).toBe('env');
		expect(nextStep('env', complete)).toBe('boot');
		expect(nextStep('boot', complete)).toBe('open');
		expect(nextStep('open', complete)).toBeNull();
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
		expect(previousStep('runtime', progress())).toBe('prereq');
		expect(previousStep('open', progress())).toBe('boot');
	});

	it('resumes at the first incomplete step', () => {
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
});
