'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { useMounted } from '@/lib/hooks/use-mounted';
import { useOnboardingFlow, type WizardStep } from './useOnboardingFlow';
import { WizardFooter } from './WizardFooter';
import { WelcomeStep } from './steps/WelcomeStep';
import { ChoiceStep } from './steps/ChoiceStep';
import { ConfigStep } from './steps/ConfigStep';
import { PluginsCatalogStep } from './steps/PluginsCatalogStep';
import { CreateWorkStep } from './steps/CreateWorkStep';
import { useTurnstile } from './use-turnstile';
import { AI_ICONS, DEPLOY_ICONS, STORAGE_ICONS } from './brand-icons';
import { trackOnboardingEvent } from '@/app/actions/onboarding/track';
import { completeOnboarding, patchOnboardingState } from '@/app/actions/onboarding/state';
import { getOnboardingPluginStatuses } from '@/app/actions/dashboard/onboarding';
import type {
    OnboardingAiChoice,
    OnboardingCatalogResponse,
    OnboardingDeployChoice,
    OnboardingStateResponse,
    OnboardingStorageChoice,
} from '@ever-works/contracts/api';
import type { UserPlugin } from '@/lib/api/plugins';
import type { OAuthConnectionInfo } from '@/lib/api/plugins-capabilities/oauth';
import type { GitProviderConnectionInfo } from '@/lib/api/plugins-capabilities/git-providers';
import type { PluginDeviceAuthStatus } from '@/lib/api/plugins-capabilities/device-auth';

export interface EverWorksOnboardingWizardProps {
    readonly open: boolean;
    readonly initialState: OnboardingStateResponse;
    readonly catalog: OnboardingCatalogResponse;
    readonly plugins: ReadonlyArray<UserPlugin>;
    readonly initialConnections: Record<
        string,
        OAuthConnectionInfo | GitProviderConnectionInfo | null
    >;
    readonly initialDeviceAuthStatuses: Record<string, PluginDeviceAuthStatus | null>;
    readonly onClose: () => void;
}

/**
 * v2 onboarding wizard — choice-driven flow (Welcome → AI → Storage →
 * Deploy → Plugins → Create Work). Server-authoritative state, telemetry
 * via server action, Back / Skip / Refresh footer controls.
 */
export function EverWorksOnboardingWizard({
    open,
    initialState,
    catalog,
    plugins,
    initialConnections,
    initialDeviceAuthStatuses,
    onClose,
}: EverWorksOnboardingWizardProps) {
    const mounted = useMounted();

    const pluginsById = useMemo(() => {
        const map: Record<string, UserPlugin> = {};
        plugins.forEach((p) => {
            map[p.pluginId] = p;
        });
        return map;
    }, [plugins]);

    const [connections, setConnections] = useState(initialConnections);
    const [deviceAuthStatuses, setDeviceAuthStatuses] = useState(initialDeviceAuthStatuses);
    const [isStatusLoading, setIsStatusLoading] = useState(false);

    // EW-617 G7 — Turnstile token producer. Renders a hidden Managed
    // widget once at wizard mount; getToken() executes on demand
    // before each captcha-gated API call. No-ops cleanly when the
    // server's CAPTCHA_PROVIDER is unset.
    const turnstile = useTurnstile();

    // EW-617 G8 — correlation UUID minted on wizard mount, threaded
    // into telemetry events server-side so ops can trace the full
    // funnel (landing → wizard → work created → deploy ready).
    const correlationId = useMemo(() => {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
        // Fallback for environments without crypto.randomUUID — only
        // used in legacy browsers / older Node test envs.
        return `corr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }, []);

    const flow = useOnboardingFlow({
        initial: initialState,
        catalog,
        patchState: async (patch) => {
            const result = await patchOnboardingState(patch);
            // If the server-action wrapper reports `success: false` (e.g. API
            // 4xx/5xx, validation error), surface it so the user knows their
            // progress wasn't saved. Silent failures previously let the user
            // click through the whole wizard with nothing persisted.
            if (!result.success) {
                toast.error(result.error ?? 'Failed to save your onboarding progress');
            }
        },
        trackEvent: (event, props) => {
            void trackOnboardingEvent(event, props);
        },
        onClose,
        markCompleted: () => {
            void completeOnboarding();
        },
    });

    // EW-617 G4 + G1 — landing-page hand-off. When the wizard mounts and
    // the URL carries `?prompt=…` (or hash `#prompt=…`, used as a poor-man's
    // signed-token transport), seed the wizard state and jump straight to
    // the final step so the user sees "Generate now" without scrolling
    // through choices. We do this once per mount; subsequent renders read
    // from the persisted state.
    const promptHydratedRef = useRef(false);
    useEffect(() => {
        if (!mounted || promptHydratedRef.current) return;
        if (flow.state.prompt) {
            // Already hydrated from server state — no URL work needed.
            promptHydratedRef.current = true;
            return;
        }
        if (typeof window === 'undefined') return;
        const url = new URL(window.location.href);
        const fromQuery = url.searchParams.get('prompt');
        const fromHash = readHashParam(url.hash, 'prompt');
        const raw = (fromQuery || fromHash || '').trim();
        if (!raw) return;

        promptHydratedRef.current = true;
        flow.setPrompt(raw);
        // Skip to the final step so the user lands on "Generate now".
        const createIndex = flow.steps.findIndex((s) => s.kind === 'create-work');
        if (createIndex >= 0) {
            flow.jumpTo(createIndex);
        }

        // Strip the prompt from the URL so a reload doesn't re-trigger the
        // hand-off (and so we don't leak the prompt to analytics referers).
        url.searchParams.delete('prompt');
        if (fromHash) {
            url.hash = stripHashParam(url.hash, 'prompt');
        }
        window.history.replaceState({}, '', url.toString());
    }, [mounted, flow]);

    const refreshConnections = async (pluginId?: string) => {
        const target = pluginId ? plugins.filter((p) => p.pluginId === pluginId) : plugins;
        if (target.length === 0) return;
        setIsStatusLoading(true);
        try {
            const result = await getOnboardingPluginStatuses(
                target.map((p) => ({ pluginId: p.pluginId, capabilities: p.capabilities })),
            );
            if (result.success && result.data) {
                setConnections((prev) => ({ ...prev, ...result.data!.connections }));
                setDeviceAuthStatuses((prev) => ({
                    ...prev,
                    ...result.data!.deviceAuthStatuses,
                }));
            }
        } finally {
            setIsStatusLoading(false);
        }
    };

    if (!mounted || !open) return null;

    const stepIndex = flow.stepIndex;
    const progressPercent = Math.round(((stepIndex + 1) / flow.steps.length) * 100);
    const currentStep = flow.currentStep;
    const isConfigStep = isConfigKind(currentStep.kind);

    const skipLabel = isConfigStep
        ? 'Skip step'
        : currentStep.kind === 'plugins-catalog'
          ? 'Skip — set up later'
          : flow.isLastStep
            ? 'Finish later'
            : 'Skip step';

    const nextLabel = flow.isLastStep ? 'Finish' : 'Next';

    return (
        <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
            <DialogContent className="max-w-5xl p-0 overflow-hidden rounded-lg shadow-2xl">
                <div className="absolute top-0 left-0 right-0 h-[3px] bg-border dark:bg-border-dark z-10 rounded-t-lg">
                    <div
                        className="h-full bg-text dark:bg-white/70 transition-all duration-500 ease-out rounded-t-2xl"
                        style={{ width: `${progressPercent}%` }}
                    />
                </div>

                <div className="grid gap-0 md:grid-cols-[260px_1fr] min-h-[88dvh]">
                    <SideNav
                        steps={flow.steps}
                        activeIndex={stepIndex}
                        onJump={flow.jumpTo}
                        onClose={onClose}
                    />

                    <section className="flex flex-col">
                        <div className="flex-1 overflow-y-auto px-8 pt-10 pb-6">
                            <StepBody
                                step={currentStep}
                                flow={flow}
                                catalog={catalog}
                                pluginsById={pluginsById}
                                connections={connections}
                                deviceAuthStatuses={deviceAuthStatuses}
                                isStatusLoading={isStatusLoading}
                                turnstile={turnstile}
                                correlationId={correlationId}
                            />
                        </div>
                        <WizardFooter
                            stepIndex={stepIndex}
                            totalSteps={flow.steps.length}
                            canGoBack={flow.canGoBack}
                            nextLabel={nextLabel}
                            skipLabel={skipLabel}
                            showSkip={!flow.isLastStep || isConfigStep}
                            showNext={!flow.isLastStep}
                            showRefresh={isConfigStep}
                            refreshing={isStatusLoading}
                            onBack={flow.goBack}
                            onSkip={() => {
                                if (flow.isLastStep) {
                                    flow.finish({ dismissed: true });
                                    return;
                                }
                                flow.skip();
                            }}
                            onRefresh={() => {
                                flow.refresh();
                                const pluginId = pluginIdForStep(currentStep, flow.state);
                                void refreshConnections(pluginId);
                            }}
                            onNext={() => {
                                if (flow.isLastStep) {
                                    flow.finish();
                                    return;
                                }
                                flow.goNext();
                            }}
                        />
                    </section>
                </div>
            </DialogContent>
        </Dialog>
    );
}

// ─── Subcomponents ─────────────────────────────────────────────────────────

function SideNav({
    steps,
    activeIndex,
    onJump,
    onClose,
}: {
    steps: WizardStep[];
    activeIndex: number;
    onJump: (index: number) => void;
    onClose: () => void;
}) {
    return (
        <aside className="relative flex flex-col bg-surface-secondary/50 dark:bg-surface-secondary-dark/60 border-r border-border dark:border-border-dark">
            <div className="px-5 pt-8 pb-5">
                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-text-muted dark:text-text-muted-dark bg-surface-secondary dark:bg-white/5 px-2.5 py-1 rounded-full mb-3">
                    Setup
                </span>
                <h2 className="text-sm font-semibold text-text dark:text-text-dark leading-snug">
                    Get started with Ever Works
                </h2>
                <p className="text-[11px] leading-relaxed mt-1 text-text-muted dark:text-text-muted-dark">
                    A guided 9-step walkthrough. You can change any choice later from Settings.
                </p>
            </div>
            <nav className="flex-1 px-3 pb-2 space-y-0.5 overflow-y-auto">
                {steps.map((step, index) => {
                    const isActive = index === activeIndex;
                    const isPast = index < activeIndex;
                    return (
                        <button
                            key={step.id}
                            type="button"
                            onClick={() => onJump(index)}
                            className={cn(
                                'w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-all',
                                isActive
                                    ? 'bg-surface dark:bg-white/5'
                                    : 'hover:bg-surface dark:hover:bg-surface-dark',
                            )}
                        >
                            <span
                                className={cn(
                                    'flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold transition-all',
                                    isActive
                                        ? 'bg-text dark:bg-white text-white dark:text-black'
                                        : isPast
                                          ? 'bg-border dark:bg-border-dark text-text-muted dark:text-text-muted-dark'
                                          : 'border border-border dark:border-border-dark text-text-muted dark:text-text-muted-dark',
                                )}
                            >
                                {index + 1}
                            </span>
                            <span
                                className={cn(
                                    'text-sm truncate transition-colors',
                                    isActive
                                        ? 'font-medium text-text dark:text-text-dark'
                                        : 'text-text-secondary dark:text-text-secondary-dark',
                                )}
                            >
                                {labelForStep(step)}
                            </span>
                        </button>
                    );
                })}
            </nav>
            <div className="px-3 py-2 mt-auto border-t border-border dark:border-border-dark">
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={onClose}
                    className="w-4/5 mx-auto text-xs py-2.5 text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
                >
                    Close wizard
                </Button>
            </div>
        </aside>
    );
}

function StepBody({
    step,
    flow,
    catalog,
    pluginsById,
    connections,
    deviceAuthStatuses,
    isStatusLoading,
    turnstile,
    correlationId,
}: {
    step: WizardStep;
    flow: ReturnType<typeof useOnboardingFlow>;
    catalog: OnboardingCatalogResponse;
    pluginsById: Record<string, UserPlugin | undefined>;
    connections: Record<string, OAuthConnectionInfo | GitProviderConnectionInfo | null>;
    deviceAuthStatuses: Record<string, PluginDeviceAuthStatus | null>;
    isStatusLoading: boolean;
    turnstile: ReturnType<typeof useTurnstile>;
    correlationId: string;
}) {
    switch (step.kind) {
        case 'welcome':
            return <WelcomeStep />;
        case 'ai-choice':
            return (
                <ChoiceStep
                    title="Your AI choice"
                    description="Pick the AI provider that powers content generation."
                    cards={catalog.ai}
                    selected={flow.state.ai.choice}
                    columns={3}
                    icons={AI_ICONS}
                    onSelect={(choice) => flow.setAiChoice(choice as OnboardingAiChoice)}
                    onPlannedClick={(c) => flow.notePlannedClick('ai', c)}
                />
            );
        case 'ai-config': {
            const pluginId = flow.state.ai.choice;
            const plugin = pluginsById[pluginId] ?? null;
            return (
                <ConfigStep
                    title={`Configure ${plugin?.name ?? pluginId}`}
                    description="Paste your credentials below. Skip to come back later."
                    plugin={plugin}
                    connection={connections[pluginId] ?? null}
                    deviceAuthStatus={deviceAuthStatuses[pluginId] ?? null}
                    isStatusLoading={isStatusLoading}
                />
            );
        }
        case 'storage-choice':
            return (
                <ChoiceStep
                    title="Your storage"
                    description="Where do you want your work repos to live?"
                    cards={catalog.storage}
                    selected={flow.state.storage.choice}
                    icons={STORAGE_ICONS}
                    onSelect={(choice) => flow.setStorageChoice(choice as OnboardingStorageChoice)}
                    onPlannedClick={(c) => flow.notePlannedClick('storage', c)}
                />
            );
        case 'storage-config': {
            // Only `user-github` reaches here (others are auto-skipped).
            const plugin = pluginsById['github'] ?? null;
            return (
                <ConfigStep
                    title="Connect your GitHub"
                    description="Sign in with GitHub so we can create your work repos."
                    plugin={plugin}
                    connection={connections['github'] ?? null}
                    isStatusLoading={isStatusLoading}
                />
            );
        }
        case 'deploy-choice':
            return (
                <ChoiceStep
                    title="Your deployment"
                    description="Where do you want your works to be deployed?"
                    cards={catalog.deploy}
                    selected={flow.state.deploy.choice}
                    columns={3}
                    icons={DEPLOY_ICONS}
                    onSelect={(choice) => flow.setDeployChoice(choice as OnboardingDeployChoice)}
                    onPlannedClick={(c) => flow.notePlannedClick('deploy', c)}
                />
            );
        case 'deploy-config': {
            const pluginId = flow.state.deploy.choice; // 'vercel' | 'k8s'
            const plugin = pluginsById[pluginId] ?? null;
            return (
                <ConfigStep
                    title={`Configure ${plugin?.name ?? pluginId}`}
                    description="Add deployment credentials. You can change this later."
                    plugin={plugin}
                    connection={connections[pluginId] ?? null}
                    isStatusLoading={isStatusLoading}
                />
            );
        }
        case 'plugins-catalog':
            return (
                <PluginsCatalogStep
                    cards={catalog.plugins}
                    pluginsById={pluginsById}
                    onExpand={() => flow.setPluginsReviewed(true)}
                />
            );
        case 'create-work':
            return (
                <CreateWorkStep
                    onLeave={() => flow.finish()}
                    prompt={flow.state.prompt}
                    onQuickCreate={
                        flow.state.prompt
                            ? async (prompt) => {
                                  // EW-617 G4: anonymous + claimed users alike
                                  // can one-click finish. The endpoint reads
                                  // provider defaults from onboarding state.
                                  // EW-617 G7: fetch a fresh Turnstile token
                                  // right before the call. Empty when captcha
                                  // is disabled — server is OK with that.
                                  const captchaToken = await turnstile.getToken();
                                  const { quickCreateWorkAction } =
                                      await import('@/app/actions/works/quick-create');
                                  const slug = slugifyPrompt(prompt);
                                  const result = await quickCreateWorkAction({
                                      slug,
                                      name: deriveNameFromPrompt(prompt),
                                      description: prompt.slice(0, 500),
                                      prompt,
                                      organization: false,
                                      deployProvider: flow.state.deploy.choice,
                                      storageProvider: flow.state.storage.choice,
                                      captchaToken: captchaToken || undefined,
                                      correlationId,
                                  });
                                  if (!result.success) {
                                      throw new Error(result.error ?? 'Failed to start generation');
                                  }
                                  return {
                                      workSlug: result.data?.work.slug,
                                      generationHistoryId: result.data?.generation.historyId,
                                  };
                              }
                            : undefined
                    }
                />
            );
        default:
            return null;
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isConfigKind(kind: WizardStep['kind']): boolean {
    return kind === 'ai-config' || kind === 'storage-config' || kind === 'deploy-config';
}

// EW-617 G4: extract `prompt=…` from a URL hash fragment. The landing
// page (G1) hands off via fragment so the prompt never hits the server
// access logs as a querystring. We parse defensively; bad input returns
// `null` and we fall back to the existing /works/new flow.
function readHashParam(hash: string, key: string): string | null {
    if (!hash) return null;
    const raw = hash.startsWith('#') ? hash.slice(1) : hash;
    try {
        const params = new URLSearchParams(raw);
        return params.get(key);
    } catch {
        return null;
    }
}

function stripHashParam(hash: string, key: string): string {
    if (!hash) return '';
    const raw = hash.startsWith('#') ? hash.slice(1) : hash;
    try {
        const params = new URLSearchParams(raw);
        params.delete(key);
        const remaining = params.toString();
        return remaining ? `#${remaining}` : '';
    } catch {
        return hash;
    }
}

// EW-617 G4: derive a DNS-safe slug from the user's prompt.
// The slug column has the same `^[a-z0-9]+(?:-[a-z0-9]+)*$` constraint
// as `CreateWorkDto.slug`, so we strip everything else and bound the
// length. Adds a short timestamp suffix so two users typing the same
// prompt don't collide.
function slugifyPrompt(prompt: string): string {
    const base = prompt
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    const suffix = Math.random().toString(36).slice(2, 8);
    return base ? `${base}-${suffix}` : `quick-${suffix}`;
}

// Pull the first ~80 chars of the prompt as a display name. Title-cased
// so it looks like a name in the dashboard list.
function deriveNameFromPrompt(prompt: string): string {
    const head = prompt.slice(0, 80).trim();
    return head.charAt(0).toUpperCase() + head.slice(1);
}

function pluginIdForStep(
    step: WizardStep,
    state: ReturnType<typeof useOnboardingFlow>['state'],
): string | undefined {
    if (step.kind === 'ai-config') return state.ai.choice;
    if (step.kind === 'storage-config') return 'github';
    if (step.kind === 'deploy-config') return state.deploy.choice;
    return undefined;
}

function labelForStep(step: WizardStep): string {
    switch (step.kind) {
        case 'welcome':
            return 'Welcome';
        case 'ai-choice':
            return 'Your AI choice';
        case 'ai-config':
            return 'Configure AI';
        case 'storage-choice':
            return 'Your storage';
        case 'storage-config':
            return 'Configure storage';
        case 'deploy-choice':
            return 'Your deployment';
        case 'deploy-config':
            return 'Configure deployment';
        case 'plugins-catalog':
            return 'Plugins & Integrations';
        case 'create-work':
            return 'Create your first work';
        default:
            return step.kind;
    }
}
