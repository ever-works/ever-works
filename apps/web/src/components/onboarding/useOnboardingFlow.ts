'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import {
    ONBOARDING_DEFAULT_STATE,
    type OnboardingAiChoice,
    type OnboardingCatalogResponse,
    type OnboardingDeployChoice,
    type OnboardingStateResponse,
    type OnboardingStatePatchRequest,
    type OnboardingStorageChoice,
    type OnboardingWizardStateV2,
} from '@ever-works/contracts/api';

// ─── Step model ─────────────────────────────────────────────────────────────

export type WizardStepKind =
    | 'welcome'
    | 'ai-choice'
    | 'ai-config'
    | 'storage-choice'
    | 'storage-config'
    | 'deploy-choice'
    | 'deploy-config'
    | 'plugins-catalog'
    | 'create-work';

export interface WizardStep {
    readonly kind: WizardStepKind;
    /** Stable id used for `skippedSteps` and telemetry. */
    readonly id: string;
}

/**
 * Compute the effective step list from the current state. AI/Storage/Deploy
 * config steps are dropped when the user chose the Ever Works default for
 * that bucket (which needs no per-user config) so we never show empty steps.
 */
export function computeStepList(state: OnboardingWizardStateV2): WizardStep[] {
    const steps: WizardStep[] = [{ kind: 'welcome', id: 'welcome' }];
    steps.push({ kind: 'ai-choice', id: 'ai-choice' });
    if (state.ai.choice !== 'ever-works') {
        steps.push({ kind: 'ai-config', id: `ai-config:${state.ai.choice}` });
    }
    steps.push({ kind: 'storage-choice', id: 'storage-choice' });
    if (state.storage.choice === 'user-github') {
        steps.push({ kind: 'storage-config', id: `storage-config:${state.storage.choice}` });
    }
    steps.push({ kind: 'deploy-choice', id: 'deploy-choice' });
    if (state.deploy.choice === 'vercel' || state.deploy.choice === 'k8s') {
        steps.push({ kind: 'deploy-config', id: `deploy-config:${state.deploy.choice}` });
    }
    steps.push({ kind: 'plugins-catalog', id: 'plugins-catalog' });
    steps.push({ kind: 'create-work', id: 'create-work' });
    return steps;
}

// ─── State + reducer ────────────────────────────────────────────────────────

interface FlowReducerState {
    readonly state: OnboardingWizardStateV2;
    readonly history: number[]; // recent step indices, for Back
    readonly stepIndex: number;
    readonly refreshNonce: number;
}

type FlowAction =
    | { type: 'goNext' }
    | { type: 'goBack' }
    | { type: 'jumpTo'; index: number }
    | { type: 'setAiChoice'; value: OnboardingAiChoice }
    | { type: 'setStorageChoice'; value: OnboardingStorageChoice }
    | { type: 'setDeployChoice'; value: OnboardingDeployChoice }
    | { type: 'recordSkip'; stepId: string }
    | { type: 'setPluginsReviewed'; value: boolean }
    | { type: 'mergeServerState'; value: OnboardingWizardStateV2 }
    | { type: 'refresh' };

function reduce(state: FlowReducerState, action: FlowAction): FlowReducerState {
    switch (action.type) {
        case 'goNext': {
            const steps = computeStepList(state.state);
            const next = Math.min(state.stepIndex + 1, steps.length - 1);
            if (next === state.stepIndex) return state;
            return {
                ...state,
                stepIndex: next,
                history: [...state.history, state.stepIndex],
                state: { ...state.state, lastStep: next },
            };
        }
        case 'goBack': {
            const last = state.history[state.history.length - 1];
            if (last === undefined) return state;
            return {
                ...state,
                stepIndex: last,
                history: state.history.slice(0, -1),
                state: { ...state.state, lastStep: last },
            };
        }
        case 'jumpTo': {
            const steps = computeStepList(state.state);
            const clamped = Math.max(0, Math.min(steps.length - 1, action.index));
            if (clamped === state.stepIndex) return state;
            return {
                ...state,
                stepIndex: clamped,
                history: [...state.history, state.stepIndex],
                state: { ...state.state, lastStep: clamped },
            };
        }
        case 'setAiChoice':
            return {
                ...state,
                state: { ...state.state, ai: { choice: action.value } },
            };
        case 'setStorageChoice':
            return {
                ...state,
                state: { ...state.state, storage: { choice: action.value } },
            };
        case 'setDeployChoice':
            return {
                ...state,
                state: { ...state.state, deploy: { choice: action.value } },
            };
        case 'recordSkip': {
            if (state.state.skippedSteps.includes(action.stepId)) return state;
            return {
                ...state,
                state: {
                    ...state.state,
                    skippedSteps: [...state.state.skippedSteps, action.stepId],
                },
            };
        }
        case 'setPluginsReviewed':
            return {
                ...state,
                state: { ...state.state, pluginsReviewed: action.value },
            };
        case 'mergeServerState':
            return {
                ...state,
                state: action.value,
                stepIndex: clampToSteps(state.stepIndex, action.value),
            };
        case 'refresh':
            return { ...state, refreshNonce: state.refreshNonce + 1 };
        default:
            return state;
    }
}

function clampToSteps(index: number, state: OnboardingWizardStateV2): number {
    const steps = computeStepList(state);
    return Math.max(0, Math.min(steps.length - 1, index));
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export interface UseOnboardingFlowOptions {
    readonly initial: OnboardingStateResponse;
    readonly catalog: OnboardingCatalogResponse;
    readonly patchState: (patch: OnboardingStatePatchRequest) => Promise<void>;
    readonly trackEvent: (event: string, props?: Record<string, unknown>) => void;
    readonly onClose: () => void;
    readonly markCompleted: () => void;
}

export interface UseOnboardingFlowResult {
    readonly steps: WizardStep[];
    readonly stepIndex: number;
    readonly currentStep: WizardStep;
    readonly state: OnboardingWizardStateV2;
    readonly refreshNonce: number;
    readonly canGoBack: boolean;
    readonly isLastStep: boolean;
    readonly setAiChoice: (value: OnboardingAiChoice) => void;
    readonly setStorageChoice: (value: OnboardingStorageChoice) => void;
    readonly setDeployChoice: (value: OnboardingDeployChoice) => void;
    readonly setPluginsReviewed: (value: boolean) => void;
    readonly goNext: () => void;
    readonly goBack: () => void;
    readonly skip: () => void;
    readonly refresh: () => void;
    readonly jumpTo: (index: number) => void;
    readonly finish: (options?: { dismissed?: boolean }) => void;
    readonly notePlannedClick: (bucket: 'ai' | 'storage' | 'deploy', choice: string) => void;
}

/**
 * Reducer-backed step machine for the onboarding wizard. Drives the step
 * sequence derived from current choices, owns Back/Skip/Refresh logic,
 * mirrors every transition to the server via `patchState`, and emits
 * telemetry via `trackEvent`.
 *
 * `catalog` is read but not stored — the parent already memoises it from
 * the server-side fetch.
 */
export function useOnboardingFlow({
    initial,
    catalog: _catalog,
    patchState,
    trackEvent,
    onClose,
    markCompleted,
}: UseOnboardingFlowOptions): UseOnboardingFlowResult {
    void _catalog; // referenced via consumers; not stored

    const [reducerState, dispatch] = useReducer(
        reduce,
        undefined,
        (): FlowReducerState => ({
            state: initial.state ?? ONBOARDING_DEFAULT_STATE,
            history: [],
            stepIndex: clampToSteps(
                initial.state?.lastStep ?? 0,
                initial.state ?? ONBOARDING_DEFAULT_STATE,
            ),
            refreshNonce: 0,
        }),
    );

    const steps = useMemo(() => computeStepList(reducerState.state), [reducerState.state]);
    const currentStep = steps[reducerState.stepIndex] ?? steps[0];
    const isLastStep = reducerState.stepIndex >= steps.length - 1;

    // Persist the latest state to the server in the background. We don't
    // await — failures are surfaced via `patchState`'s own toast handling.
    const lastPushedRef = useRef<string>('');
    const pushState = useCallback(
        (next: OnboardingWizardStateV2) => {
            const serialised = JSON.stringify(next);
            if (serialised === lastPushedRef.current) return;
            lastPushedRef.current = serialised;
            void patchState({ state: stripVersion(next) });
        },
        [patchState],
    );

    const goNext = useCallback(() => {
        const stepId = currentStep?.id ?? '';
        const stepKind = currentStep?.kind ?? 'welcome';
        trackEvent('onboarding_step_next', { stepKind, stepId });
        dispatch({ type: 'goNext' });
    }, [currentStep?.id, currentStep?.kind, trackEvent]);

    const goBack = useCallback(() => {
        if (reducerState.history.length === 0) return;
        const stepKind = currentStep?.kind ?? 'welcome';
        trackEvent('onboarding_step_back', { stepKind });
        dispatch({ type: 'goBack' });
    }, [currentStep?.kind, reducerState.history.length, trackEvent]);

    const skip = useCallback(() => {
        const stepId = currentStep?.id ?? '';
        const stepKind = currentStep?.kind ?? 'welcome';
        trackEvent('onboarding_step_skipped', { stepKind, stepId });
        dispatch({ type: 'recordSkip', stepId });
        dispatch({ type: 'goNext' });
    }, [currentStep?.id, currentStep?.kind, trackEvent]);

    const setAiChoice = useCallback(
        (value: OnboardingAiChoice) => {
            trackEvent('onboarding_ai_choice_selected', { choice: value });
            dispatch({ type: 'setAiChoice', value });
        },
        [trackEvent],
    );

    const setStorageChoice = useCallback(
        (value: OnboardingStorageChoice) => {
            trackEvent('onboarding_storage_choice_selected', { choice: value });
            dispatch({ type: 'setStorageChoice', value });
        },
        [trackEvent],
    );

    const setDeployChoice = useCallback(
        (value: OnboardingDeployChoice) => {
            trackEvent('onboarding_deploy_choice_selected', { choice: value });
            dispatch({ type: 'setDeployChoice', value });
        },
        [trackEvent],
    );

    const setPluginsReviewed = useCallback(
        (value: boolean) => dispatch({ type: 'setPluginsReviewed', value }),
        [],
    );

    const refresh = useCallback(() => {
        const stepKind = currentStep?.kind ?? 'welcome';
        trackEvent('onboarding_plugin_refresh_clicked', { stepKind });
        dispatch({ type: 'refresh' });
    }, [currentStep?.kind, trackEvent]);

    const jumpTo = useCallback((index: number) => dispatch({ type: 'jumpTo', index }), []);

    const finish = useCallback(
        (options?: { dismissed?: boolean }) => {
            if (options?.dismissed) {
                trackEvent('onboarding_closed', {
                    completed: false,
                    lastStepIndex: reducerState.stepIndex,
                });
            } else {
                trackEvent('onboarding_completed', {});
                markCompleted();
            }
            onClose();
        },
        [markCompleted, onClose, reducerState.stepIndex, trackEvent],
    );

    const notePlannedClick = useCallback(
        (bucket: 'ai' | 'storage' | 'deploy', choice: string) =>
            trackEvent('onboarding_planned_card_clicked', { bucket, choice }),
        [trackEvent],
    );

    // Sync state to server after render whenever it changes. Done in an
    // effect (not during render) so we don't read/write refs in the render
    // pass — the lint rule `react-hooks/refs-in-render` enforces this.
    useEffect(() => {
        pushState(reducerState.state);
    }, [pushState, reducerState.state]);

    return {
        steps,
        stepIndex: reducerState.stepIndex,
        currentStep,
        state: reducerState.state,
        refreshNonce: reducerState.refreshNonce,
        canGoBack: reducerState.history.length > 0,
        isLastStep,
        setAiChoice,
        setStorageChoice,
        setDeployChoice,
        setPluginsReviewed,
        goNext,
        goBack,
        skip,
        refresh,
        jumpTo,
        finish,
        notePlannedClick,
    };
}

function stripVersion(state: OnboardingWizardStateV2) {
    // The patch endpoint deep-merges by field; `version` is server-managed.
    const { lastStep, ai, storage, deploy, skippedSteps, pluginsReviewed } = state;
    return {
        lastStep,
        ai: { choice: ai.choice },
        storage: { choice: storage.choice },
        deploy: { choice: deploy.choice },
        skippedSteps: [...skippedSteps],
        pluginsReviewed,
    };
}

export const __test__ = { reduce, computeStepList, clampToSteps };
