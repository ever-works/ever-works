'use client';

import { Fragment } from 'react';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { X, ExternalLink, BookOpen, Keyboard } from 'lucide-react';

interface HelpDrawerProps {
    open: boolean;
    onClose: () => void;
    onboarding?: {
        currentStep: number;
        totalSteps: number;
        onOpen: () => void;
    };
}

const DOCS_URL = 'https://docs.ever.works/docs';

export function HelpDrawer({ open, onClose, onboarding }: HelpDrawerProps) {
    const t = useTranslations('dashboard.header.help');
    const tCommon = useTranslations('common.ui');

    const quickTips = [
        { icon: '1', text: t('quickTips.tip1') },
        { icon: '2', text: t('quickTips.tip2') },
        { icon: '3', text: t('quickTips.tip3') },
    ];

    const keyboardShortcuts = [
        { keys: ['Ctrl', 'K'], label: t('shortcuts.search') },
        { keys: ['C'], label: t('shortcuts.newDirectory') },
    ];

    const links = [
        {
            label: t('links.docs'),
            href: DOCS_URL,
            icon: BookOpen,
            external: true,
        },
    ];

    return (
        <Transition show={open}>
            <Dialog onClose={onClose} className="relative z-50">
                {/* Backdrop */}
                <TransitionChild
                    enter="ease-out duration-300"
                    enterFrom="opacity-0"
                    enterTo="opacity-100"
                    leave="ease-in duration-200"
                    leaveFrom="opacity-100"
                    leaveTo="opacity-0"
                >
                    <div className="fixed inset-0 bg-black/50 dark:bg-black/70" />
                </TransitionChild>

                {/* Drawer */}
                <div className="fixed inset-0 overflow-hidden">
                    <div className="absolute inset-0 overflow-hidden">
                        <div className="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10">
                            <TransitionChild
                                enter="transform transition ease-in-out duration-300"
                                enterFrom="translate-x-full"
                                enterTo="translate-x-0"
                                leave="transform transition ease-in-out duration-200"
                                leaveFrom="translate-x-0"
                                leaveTo="translate-x-full"
                            >
                                <DialogPanel className="pointer-events-auto w-screen max-w-md">
                                    <div
                                        className={cn(
                                            'flex h-full flex-col overflow-y-auto',
                                            'bg-white dark:bg-surface-dark',
                                            'shadow-xl',
                                        )}
                                    >
                                        {/* Header */}
                                        <div
                                            className={cn(
                                                'px-6 py-4',
                                                'border-b border-border dark:border-border-dark',
                                            )}
                                        >
                                            <div className="flex items-center justify-between">
                                                <DialogTitle
                                                    className={cn(
                                                        'text-lg font-semibold',
                                                        'text-text dark:text-text-dark',
                                                    )}
                                                >
                                                    {t('title')}
                                                </DialogTitle>
                                                <button
                                                    onClick={onClose}
                                                    className={cn(
                                                        'p-2 rounded-md transition-colors',
                                                        'text-text-secondary dark:text-text-secondary-dark',
                                                        'hover:text-text dark:hover:text-text-dark',
                                                        'hover:bg-surface dark:hover:bg-surface-secondary-dark',
                                                    )}
                                                >
                                                    <X className="w-5 h-5" />
                                                    <span className="sr-only">
                                                        {tCommon('close')}
                                                    </span>
                                                </button>
                                            </div>
                                            <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                                                {t('subtitle')}
                                            </p>
                                        </div>

                                        {/* Content */}
                                        <div className="flex-1 px-6 py-6 space-y-8">
                                            {onboarding && (
                                                <section>
                                                    <h3
                                                        className={cn(
                                                            'text-sm font-semibold uppercase tracking-wider mb-4',
                                                            'text-text-secondary dark:text-text-secondary-dark',
                                                        )}
                                                    >
                                                        {t('onboarding.title')}
                                                    </h3>
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            onboarding.onOpen();
                                                            onClose();
                                                        }}
                                                        className={cn(
                                                            'w-full rounded-xl border p-4 text-left transition-colors',
                                                            'border-border dark:border-border-dark',
                                                            'bg-surface dark:bg-surface-secondary-dark',
                                                            'hover:border-primary/50 hover:bg-surface-secondary dark:hover:bg-surface-dark',
                                                        )}
                                                    >
                                                        <div className="flex items-start justify-between gap-3">
                                                            <div className="space-y-1">
                                                                <p className="text-sm font-medium text-text dark:text-text-dark">
                                                                    {t('onboarding.action', {
                                                                        currentStep:
                                                                            onboarding.currentStep,
                                                                        totalSteps:
                                                                            onboarding.totalSteps,
                                                                    })}
                                                                </p>
                                                                <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                                                    {t('onboarding.description')}
                                                                </p>
                                                            </div>
                                                            <BookOpen className="h-5 w-5 flex-shrink-0 text-text-secondary dark:text-text-secondary-dark" />
                                                        </div>
                                                    </button>
                                                </section>
                                            )}

                                            {/* Quick Tips Section */}
                                            <section>
                                                <h3
                                                    className={cn(
                                                        'text-sm font-semibold uppercase tracking-wider mb-4',
                                                        'text-text-secondary dark:text-text-secondary-dark',
                                                    )}
                                                >
                                                    {t('quickTips.title')}
                                                </h3>
                                                <ul className="space-y-3">
                                                    {quickTips.map((tip, index) => (
                                                        <li
                                                            key={index}
                                                            className="flex items-start gap-3"
                                                        >
                                                            <span
                                                                className={cn(
                                                                    'flex-shrink-0 w-6 h-6 rounded-full',
                                                                    'bg-primary/10 text-primary',
                                                                    'flex items-center justify-center',
                                                                    'text-xs font-semibold',
                                                                )}
                                                            >
                                                                {tip.icon}
                                                            </span>
                                                            <span className="text-sm text-text dark:text-text-dark">
                                                                {tip.text}
                                                            </span>
                                                        </li>
                                                    ))}
                                                </ul>
                                            </section>

                                            {/* Keyboard Shortcuts Section */}
                                            <section>
                                                <h3
                                                    className={cn(
                                                        'text-sm font-semibold uppercase tracking-wider mb-4',
                                                        'text-text-secondary dark:text-text-secondary-dark',
                                                        'flex items-center gap-2',
                                                    )}
                                                >
                                                    <Keyboard className="w-4 h-4" />
                                                    {t('shortcuts.title')}
                                                </h3>
                                                <div className="space-y-2">
                                                    {keyboardShortcuts.map((shortcut, index) => (
                                                        <div
                                                            key={index}
                                                            className={cn(
                                                                'flex items-center justify-between py-2 px-3 rounded-lg',
                                                                'bg-surface dark:bg-surface-secondary-dark',
                                                            )}
                                                        >
                                                            <span className="text-sm text-text dark:text-text-dark">
                                                                {shortcut.label}
                                                            </span>
                                                            <div className="flex items-center gap-1">
                                                                {shortcut.keys.map(
                                                                    (key, keyIndex) => (
                                                                        <Fragment key={keyIndex}>
                                                                            <kbd
                                                                                className={cn(
                                                                                    'px-2 py-1 text-xs font-medium rounded',
                                                                                    'bg-white dark:bg-surface-dark',
                                                                                    'border border-border dark:border-border-dark',
                                                                                    'text-text-secondary dark:text-text-secondary-dark',
                                                                                )}
                                                                            >
                                                                                {key}
                                                                            </kbd>
                                                                            {keyIndex <
                                                                                shortcut.keys
                                                                                    .length -
                                                                                    1 && (
                                                                                <span className="text-text-muted dark:text-text-muted-dark">
                                                                                    +
                                                                                </span>
                                                                            )}
                                                                        </Fragment>
                                                                    ),
                                                                )}
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                                <p className="mt-2 text-xs text-text-muted dark:text-text-muted-dark">
                                                    {t('shortcuts.hint')}
                                                </p>
                                            </section>

                                            {/* Links Section */}
                                            <section>
                                                <h3
                                                    className={cn(
                                                        'text-sm font-semibold uppercase tracking-wider mb-4',
                                                        'text-text-secondary dark:text-text-secondary-dark',
                                                    )}
                                                >
                                                    {t('links.title')}
                                                </h3>
                                                <div className="space-y-2">
                                                    {links.map((link, index) => (
                                                        <a
                                                            key={index}
                                                            href={link.href}
                                                            target={
                                                                link.external ? '_blank' : undefined
                                                            }
                                                            rel={
                                                                link.external
                                                                    ? 'noopener noreferrer'
                                                                    : undefined
                                                            }
                                                            className={cn(
                                                                'flex items-center justify-between py-3 px-4 rounded-lg transition-colors',
                                                                'border border-border dark:border-border-dark',
                                                                'hover:bg-surface dark:hover:bg-surface-secondary-dark hover:border-primary/50',
                                                            )}
                                                        >
                                                            <div className="flex items-center gap-3">
                                                                <link.icon className="w-5 h-5 text-text-secondary dark:text-text-secondary-dark" />
                                                                <span className="text-sm font-medium text-text dark:text-text-dark">
                                                                    {link.label}
                                                                </span>
                                                            </div>
                                                            {link.external && (
                                                                <ExternalLink className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                                                            )}
                                                        </a>
                                                    ))}
                                                </div>
                                            </section>
                                        </div>

                                        {/* Footer */}
                                        <div
                                            className={cn(
                                                'px-6 py-4',
                                                'border-t border-border dark:border-border-dark',
                                                'bg-surface dark:bg-surface-secondary-dark',
                                            )}
                                        >
                                            <p className="text-xs text-text-muted dark:text-text-muted-dark text-center">
                                                {t('version', {
                                                    version:
                                                        process.env.NEXT_PUBLIC_APP_VERSION ||
                                                        '1.0.0',
                                                })}
                                            </p>
                                        </div>
                                    </div>
                                </DialogPanel>
                            </TransitionChild>
                        </div>
                    </div>
                </div>
            </Dialog>
        </Transition>
    );
}
