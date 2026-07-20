'use client';

import { Boxes, GitBranch, Rocket } from 'lucide-react';

export interface WelcomeStepProps {
    /**
     * Labels of the remaining wizard steps (Welcome excluded), passed from the
     * parent so the "what's next" overview always mirrors the dynamic flow
     * (6 base steps, up to 9 with BYOK config steps). Derived from
     * `computeStepList` via the same `labelForStep` the SideNav uses, so the
     * numbering here matches the sidebar.
     */
    readonly upcomingSteps?: ReadonlyArray<string>;
}

/**
 * Welcome step — introduces Ever Works and previews the next steps on one
 * screen. No choices here; just a "Next" call to action.
 */
export function WelcomeStep({ upcomingSteps = [] }: WelcomeStepProps) {
    return (
        <div className="space-y-6 max-w-2xl">
            <div className="flex items-start gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-secondary dark:bg-white/5">
                    <Boxes className="w-5 h-5 text-text-secondary dark:text-text-secondary-dark" />
                </div>
                <div>
                    <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                        Welcome to Ever Works
                    </h3>
                    <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                        Ever Works is an open agentic runtime for building content-rich web apps and
                        Git repositories, then publishing them as live sites. Spin up directories,
                        websites, landing pages, blogs and awesome-lists — or go further with
                        Missions, Agents, Tasks and Companies — all AI-generated, Git-backed and
                        one-click deployed. This short setup captures a few defaults (AI, Storage,
                        Deployment); you can change any of them later from Settings.
                    </p>
                </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[
                    {
                        Icon: Boxes,
                        title: 'Build almost anything',
                        description:
                            'Directories, websites, landing pages, blogs and awesome-lists — plus Missions, Agents, Tasks and Companies.',
                    },
                    {
                        Icon: GitBranch,
                        title: 'AI-generated & Git-backed',
                        description:
                            'Content, items, tags and categories are generated for you and versioned in a real Git repository.',
                    },
                    {
                        Icon: Rocket,
                        title: 'One-click deployment',
                        description:
                            'Publish to a managed Ever Works cluster or bring your own — every project ships as a live site.',
                    },
                ].map((feature) => (
                    <div
                        key={feature.title}
                        className="rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-4"
                    >
                        <feature.Icon className="w-4 h-4 text-text-secondary dark:text-text-secondary-dark mb-2.5" />
                        <p className="text-xs font-semibold text-text dark:text-text-dark mb-1">
                            {feature.title}
                        </p>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark leading-relaxed">
                            {feature.description}
                        </p>
                    </div>
                ))}
            </div>

            {upcomingSteps.length > 0 ? (
                <div className="rounded-xl border border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/30 p-5">
                    <p className="text-sm font-semibold text-text dark:text-text-dark">
                        Here&apos;s what&apos;s next
                    </p>
                    <ol className="mt-3 space-y-2">
                        {upcomingSteps.map((label, index) => (
                            <li
                                key={`${index}-${label}`}
                                className="flex items-center gap-3 text-sm text-text-secondary dark:text-text-secondary-dark"
                            >
                                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border dark:border-border-dark text-[11px] font-semibold text-text-muted dark:text-text-muted-dark">
                                    {index + 1}
                                </span>
                                {label}
                            </li>
                        ))}
                    </ol>
                </div>
            ) : null}
        </div>
    );
}
