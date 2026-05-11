'use client';

import { BookOpen, Shield, Sparkles, Zap } from 'lucide-react';

/**
 * Welcome step — explains Ever Works and the next 8 wizard steps in one
 * paragraph. No choices on this screen; just a "Next" call to action.
 */
export function WelcomeStep() {
    return (
        <div className="space-y-6 max-w-2xl">
            <div className="flex items-start gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-secondary dark:bg-white/5">
                    <BookOpen className="w-5 h-5 text-text-secondary dark:text-text-secondary-dark" />
                </div>
                <div>
                    <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                        Welcome to Ever Works
                    </h3>
                    <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                        Build AI-powered directories without leaving your browser. We&apos;ll
                        walk you through three quick choices (AI, Storage, Deployment) before
                        you create your first work.
                    </p>
                </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[
                    {
                        Icon: Sparkles,
                        title: 'AI-generated content',
                        description:
                            'Items, descriptions, tags and categories generated for you, ready to edit.',
                    },
                    {
                        Icon: Zap,
                        title: 'One-click deployment',
                        description:
                            'Pick where to host — Ever Works manages the cluster or use your own.',
                    },
                    {
                        Icon: Shield,
                        title: 'Your storage, your rules',
                        description:
                            'Push to a managed Ever Works org or to your own GitHub account.',
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
        </div>
    );
}
