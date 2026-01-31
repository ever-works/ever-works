'use client';

import { Fragment } from 'react';
import {
    Dialog,
    DialogPanel,
    DialogTitle,
    Transition,
    TransitionChild,
} from '@headlessui/react';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import { X, ExternalLink, BookOpen, MessageCircle, Keyboard } from 'lucide-react';

interface HelpDrawerProps {
    open: boolean;
    onClose: () => void;
}

const GITHUB_REPO_URL = 'https://github.com/ever-works/ever-works';
const GITHUB_ISSUES_URL = 'https://github.com/ever-works/ever-works/issues';
const DOCS_URL = 'https://docs.ever.works';

// GitHub icon component (lucide's Github is deprecated)
function GitHubIcon({ className }: { className?: string }) {
    return (
        <svg className={className} fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
        </svg>
    );
}

export function HelpDrawer({ open, onClose }: HelpDrawerProps) {
    const t = useTranslations('dashboard.header.help');

    const quickTips = [
        { icon: '1', text: t('quickTips.tip1') },
        { icon: '2', text: t('quickTips.tip2') },
        { icon: '3', text: t('quickTips.tip3') },
    ];

    const keyboardShortcuts = [
        { keys: ['Ctrl', 'K'], label: t('shortcuts.search') },
        { keys: ['C'], label: t('shortcuts.newDirectory') },
        { keys: ['?'], label: t('shortcuts.help') },
    ];

    const links = [
        {
            label: t('links.github'),
            href: GITHUB_REPO_URL,
            icon: GitHubIcon,
            external: true,
        },
        {
            label: t('links.issues'),
            href: GITHUB_ISSUES_URL,
            icon: MessageCircle,
            external: true,
        },
        {
            label: t('links.docs'),
            href: DOCS_URL,
            icon: BookOpen,
            external: true,
            comingSoon: true,
        },
    ];

    return (
        <Transition show={open} as={Fragment}>
            <Dialog onClose={onClose} className="relative z-50">
                {/* Backdrop */}
                <TransitionChild
                    as={Fragment}
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
                                as={Fragment}
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
                                                    <span className="sr-only">Close</span>
                                                </button>
                                            </div>
                                            <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                                                {t('subtitle')}
                                            </p>
                                        </div>

                                        {/* Content */}
                                        <div className="flex-1 px-6 py-6 space-y-8">
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
                                                                {shortcut.keys.map((key, keyIndex) => (
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
                                                                            shortcut.keys.length - 1 && (
                                                                            <span className="text-text-muted dark:text-text-muted-dark">
                                                                                +
                                                                            </span>
                                                                        )}
                                                                    </Fragment>
                                                                ))}
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
                                                            href={link.comingSoon ? undefined : link.href}
                                                            target={link.external ? '_blank' : undefined}
                                                            rel={
                                                                link.external
                                                                    ? 'noopener noreferrer'
                                                                    : undefined
                                                            }
                                                            className={cn(
                                                                'flex items-center justify-between py-3 px-4 rounded-lg transition-colors',
                                                                'border border-border dark:border-border-dark',
                                                                link.comingSoon
                                                                    ? 'cursor-not-allowed opacity-60'
                                                                    : 'hover:bg-surface dark:hover:bg-surface-secondary-dark hover:border-primary/50',
                                                            )}
                                                        >
                                                            <div className="flex items-center gap-3">
                                                                <link.icon className="w-5 h-5 text-text-secondary dark:text-text-secondary-dark" />
                                                                <div>
                                                                    <span className="text-sm font-medium text-text dark:text-text-dark">
                                                                        {link.label}
                                                                    </span>
                                                                    {link.comingSoon && (
                                                                        <span
                                                                            className={cn(
                                                                                'ml-2 px-2 py-0.5 text-xs rounded-full',
                                                                                'bg-yellow-100 dark:bg-yellow-900/30',
                                                                                'text-yellow-700 dark:text-yellow-400',
                                                                            )}
                                                                        >
                                                                            {t('links.comingSoon')}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                            </div>
                                                            {link.external && !link.comingSoon && (
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
                                                        process.env.NEXT_PUBLIC_APP_VERSION || '1.0.0',
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
