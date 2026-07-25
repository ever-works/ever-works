import type { PrereqCheckResult, RuntimeSelection } from '../../shared/ipc-contract';
import { getRuntime } from '../../shared/runtimes';
import { requiredPrereqsOk } from '../../services/prereq-check';

/**
 * Pure sequencing logic for the pre-boot install wizard:
 * welcome → prereq check → runtime select → env write → boot → open app.
 * Mirrors the web onboarding's computeStepList pattern so desktop-only steps
 * can slot in later without new machinery.
 */

export const WIZARD_STEPS = ['welcome', 'prereq', 'runtime', 'env', 'boot', 'open'] as const;
export type WizardStepId = (typeof WIZARD_STEPS)[number];

export interface WizardProgress {
	prereqResults?: PrereqCheckResult[];
	selection?: RuntimeSelection;
	envWritten: boolean;
	servicesHealthy: boolean;
}

export function computeStepList(_progress: WizardProgress): WizardStepId[] {
	// All steps always apply today; conditional runtime-config sub-steps hook
	// in here later (same extension point the web wizard uses).
	return [...WIZARD_STEPS];
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

/** Whether the given step's completion condition is met (i.e. the user may advance past it). */
export function canAdvance(step: WizardStepId, progress: WizardProgress): boolean {
	switch (step) {
		case 'welcome':
			return true;
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
