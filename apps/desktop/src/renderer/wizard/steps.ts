import type { DesktopMode, PrereqCheckResult, RemoteConnection, RuntimeSelection } from '../../shared/ipc-contract';
import { getRuntime } from '../../shared/runtimes';
import { requiredPrereqsOk } from '../../services/prereq-check';

/**
 * Pure sequencing logic for the pre-boot install wizard.
 *
 * The wizard branches on the deployment mode chosen in the `mode` step:
 *
 * - `local-stack`  welcome → mode → prereq → runtime → env → boot → open
 * - `remote-client` welcome → mode → remote → open
 *
 * Mirrors the web onboarding's computeStepList pattern so desktop-only steps
 * can slot in later without new machinery.
 */

/** Steps of the all-in-one local install. */
export const LOCAL_WIZARD_STEPS = ['welcome', 'mode', 'prereq', 'runtime', 'env', 'boot', 'open'] as const;

/** Steps of the client-mode install (connect to an instance that already runs elsewhere). */
export const REMOTE_WIZARD_STEPS = ['welcome', 'mode', 'remote', 'open'] as const;

/** Default (local-stack) flow. */
export const WIZARD_STEPS = LOCAL_WIZARD_STEPS;

export type WizardStepId = (typeof LOCAL_WIZARD_STEPS)[number] | (typeof REMOTE_WIZARD_STEPS)[number];

export interface WizardProgress {
	/** Undefined until the user picks a mode in the `mode` step. */
	mode?: DesktopMode;
	prereqResults?: PrereqCheckResult[];
	selection?: RuntimeSelection;
	envWritten: boolean;
	servicesHealthy: boolean;
	/** Remote instance the user entered (client mode only). */
	remoteConnection?: RemoteConnection;
	/** True once the remote instance answered its health probe. */
	remoteVerified?: boolean;
}

/** Which flow a progress snapshot is on. Local is the default until a mode is chosen. */
export function isRemoteMode(progress: WizardProgress): boolean {
	return progress.mode === 'remote-client';
}

export function computeStepList(progress: WizardProgress): WizardStepId[] {
	return isRemoteMode(progress) ? [...REMOTE_WIZARD_STEPS] : [...LOCAL_WIZARD_STEPS];
}

/** A selection is valid when the runtime exists, required fields resolve to a value, and the DB choice is coherent. */
export function selectionValid(selection: RuntimeSelection | undefined): boolean {
	if (!selection) {
		return false;
	}
	const runtime = getRuntime(selection.runtimeId);
	if (!runtime) {
		return false;
	}
	for (const field of runtime.fields) {
		if (!field.required) {
			continue;
		}
		const value = selection.values[field.key] ?? field.defaultValue;
		if (value === undefined || value === '') {
			return false;
		}
	}
	if (selection.database === 'external-postgres' && !selection.externalDatabaseUrl) {
		return false;
	}
	if (selection.database === 'docker-postgres' && !selection.useDockerInfra) {
		return false;
	}
	return true;
}

/** A remote step is complete once a connection was resolved AND its health probe succeeded. */
export function remoteReady(progress: WizardProgress): boolean {
	return Boolean(progress.remoteConnection) && progress.remoteVerified === true;
}

/** Whether the given step's completion condition is met (i.e. the user may advance past it). */
export function canAdvance(step: WizardStepId, progress: WizardProgress): boolean {
	switch (step) {
		case 'welcome':
			return true;
		case 'mode':
			return progress.mode !== undefined;
		case 'remote':
			return remoteReady(progress);
		case 'prereq':
			return requiredPrereqsOk(progress.prereqResults);
		case 'runtime':
			return selectionValid(progress.selection);
		case 'env':
			return progress.envWritten;
		case 'boot':
			return progress.servicesHealthy;
		case 'open':
			return false;
	}
}

export function nextStep(step: WizardStepId, progress: WizardProgress): WizardStepId | null {
	if (!canAdvance(step, progress)) {
		return null;
	}
	const steps = computeStepList(progress);
	const index = steps.indexOf(step);
	return index >= 0 && index < steps.length - 1 ? steps[index + 1] : null;
}

export function previousStep(step: WizardStepId, progress: WizardProgress): WizardStepId | null {
	const steps = computeStepList(progress);
	const index = steps.indexOf(step);
	return index > 0 ? steps[index - 1] : null;
}

/** Where a resumed wizard should land: the first step whose condition is unmet (welcome excluded). */
export function firstIncompleteStep(progress: WizardProgress): WizardStepId {
	const steps = computeStepList(progress);
	for (const step of steps) {
		if (step === 'welcome') {
			continue;
		}
		if (!canAdvance(step, progress)) {
			return step;
		}
	}
	return steps[steps.length - 1];
}
