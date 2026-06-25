'use client';

import { Fragment, type ReactNode } from 'react';
import {
    Dialog,
    DialogPanel,
    DialogTitle,
    Disclosure,
    DisclosureButton,
    DisclosurePanel,
    Transition,
    TransitionChild,
} from '@headlessui/react';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from 'next-intl';
import {
    X,
    ExternalLink,
    BookOpen,
    Keyboard,
    Github,
    Bug,
    MessageCircle,
    LifeBuoy,
    ChevronDown,
    Server,
    Lightbulb,
    type LucideIcon,
} from 'lucide-react';

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
const GITHUB_URL = 'https://github.com/ever-works/ever-works';
const ISSUES_URL = 'https://github.com/ever-works/ever-works/issues';
const DISCUSSIONS_URL = 'https://github.com/ever-works/ever-works/discussions';

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || '1.0.0';
const APP_ENV = process.env.NEXT_PUBLIC_APP_ENV || process.env.NODE_ENV || 'production';
const STATUS_URL = process.env.NEXT_PUBLIC_STATUS_URL;

// Shared visual tokens so every block reads with the same rhythm.
const CARD = 'overflow-hidden rounded-xl border border-border dark:border-border-dark';
const DIVIDE = 'divide-y divide-border dark:divide-border-dark';
const ROW = 'flex items-center justify-between gap-3 px-4 py-2.5';

function SectionHeading({
    icon: Icon,
    children,
    trailing,
}: {
    icon?: LucideIcon;
    children: ReactNode;
    trailing?: ReactNode;
}) {
    return (
        <h3
            className={cn(
                'mb-3 flex items-center gap-2',
                'text-[11px] font-semibold uppercase tracking-wider',
                'text-text-secondary dark:text-text-secondary-dark',
            )}
        >
            {Icon && <Icon className="h-3.5 w-3.5" aria-hidden="true" />}
            <span>{children}</span>
            {trailing && <span className="ml-auto">{trailing}</span>}
        </h3>
    );
}

export function HelpDrawer({ open, onClose, onboarding }: HelpDrawerProps) {
    const t = useTranslations('dashboard.header.help');
    const tCommon = useTranslations('common.ui');

    const quickTips = [
        { icon: '1', text: t('quickTips.tip1') },
        { icon: '2', text: t('quickTips.tip2') },
        { icon: '3', text: t('quickTips.tip3') },
        { icon: '4', text: t('quickTips.tip4') },
    ];

    const keyboardShortcuts = [
        { keys: ['Ctrl', 'K'], label: t('shortcuts.search') },
        { keys: ['C'], label: t('shortcuts.newWork') },
        { keys: ['?'], label: t('shortcuts.help') },
    ];

    const faqs = [
        { q: t('faq.q1'), a: t('faq.a1'), href: DOCS_URL },
        { q: t('faq.q2'), a: t('faq.a2'), href: `${DOCS_URL}/integrations` },
        { q: t('faq.q3'), a: t('faq.a3'), href: DOCS_URL },
    ];

    const links = [
        { label: t('links.docs'), href: DOCS_URL, icon: BookOpen },
        { label: t('links.github'), href: GITHUB_URL, icon: Github },
        { label: t('links.issues'), href: ISSUES_URL, icon: Bug },
        { label: t('links.community'), href: DISCUSSIONS_URL, icon: MessageCircle },
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
                                                'sticky top-0 z-10 px-6 py-4',
                                                'bg-white/90 dark:bg-surface-dark/90 backdrop-blur',
                                                'border-b border-border dark:border-border-dark',
                                            )}
                                        >
                                            <div className="flex items-center justify-between">
                                                <DialogTitle
                                                    className={cn(
                                                        'text-base font-semibold',
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
                                                    <span className="sr-only">{tCommon('close')}</span>
                                                </button>
                                            </div>
                                            <p className="mt-1 text-xs text-text-secondary dark:text-text-secondary-dark">
                                                {t('subtitle')}
                                            </p>
                                        </div>

                                        {/* Content */}
                                        <div className="flex-1 px-6 py-6 space-y-7">
                                            {onboarding && (
                                                <section>
                                                    <SectionHeading>
                                                        {t('onboarding.title')}
                                                    </SectionHeading>
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            onboarding.onOpen();
                                                            onClose();
                                                        }}
                                                        className={cn(
                                                            CARD,
                                                            'w-full p-4 text-left transition-colors',
                                                            'bg-surface dark:bg-surface-secondary-dark',
                                                            'hover:border-primary/50',
                                                        )}
                                                    >
                                                        <div className="flex items-start justify-between gap-3">
                                                            <div className="space-y-1">
                                                                <p className="text-xs font-medium text-text dark:text-text-dark">
                                                                    {t('onboarding.action', {
                                                                        currentStep:
                                                                            onboarding.currentStep,
                                                                        totalSteps:
                                                                            onboarding.totalSteps,
                                                                    })}
                                                                </p>
                                                                <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                                                    {t('onboarding.description')}
                                                                </p>
                                                            </div>
                                                            <BookOpen className="h-5 w-5 flex-shrink-0 text-text-secondary dark:text-text-secondary-dark" />
                                                        </div>
                                                    </button>
                                                </section>
                                            )}

                                            {/* Quick Tips */}
                                            <section>
                                                <SectionHeading icon={Lightbulb}>
                                                    {t('quickTips.title')}
                                                </SectionHeading>
                                                <div className={cn(CARD, DIVIDE)}>
                                                    {quickTips.map((tip, index) => (
                                                        <div
                                                            key={index}
                                                            className="flex items-start gap-3 px-4 py-2.5"
                                                        >
                                                            <span
                                                                className={cn(
                                                                    'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full',
                                                                    'bg-primary/10 text-primary',
                                                                    'text-[10px] font-semibold',
                                                                )}
                                                            >
                                                                {tip.icon}
                                                            </span>
                                                            <span className="text-xs leading-relaxed text-text dark:text-text-dark">
                                                                {tip.text}
                                                            </span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </section>

                                            {/* Keyboard Shortcuts */}
                                            <section>
                                                <SectionHeading icon={Keyboard}>
                                                    {t('shortcuts.title')}
                                                </SectionHeading>
                                                <div className={cn(CARD, DIVIDE)}>
                                                    {keyboardShortcuts.map((shortcut, index) => (
                                                        <div key={index} className={ROW}>
                                                            <span className="text-xs text-text dark:text-text-dark">
                                                                {shortcut.label}
                                                            </span>
                                                            <div className="flex items-center gap-1">
                                                                {shortcut.keys.map((key, keyIndex) => (
                                                                    <Fragment key={`key-${keyIndex}`}>
                                                                        <kbd
                                                                            className={cn(
                                                                                'min-w-[1.5rem] text-center px-1.5 py-0.5 rounded',
                                                                                'text-[11px] font-medium',
                                                                                'bg-surface dark:bg-surface-dark',
                                                                                'border border-border dark:border-border-dark',
                                                                                'text-text-secondary dark:text-text-secondary-dark',
                                                                            )}
                                                                        >
                                                                            {key}
                                                                        </kbd>
                                                                        {keyIndex <
                                                                            shortcut.keys.length -
                                                                                1 && (
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

                                            {/* FAQ */}
                                            <section>
                                                <SectionHeading>{t('faq.title')}</SectionHeading>
                                                <div className="space-y-2">
                                                    {faqs.map((faq, index) => (
                                                        <Disclosure key={index}>
                                                            {({ open }) => (
                                                                <div className={CARD}>
                                                                    <DisclosureButton
                                                                        className={cn(
                                                                            'flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left',
                                                                            'transition-colors',
                                                                            'hover:bg-surface dark:hover:bg-surface-secondary-dark',
                                                                        )}
                                                                    >
                                                                        <span className="text-xs font-medium text-text dark:text-text-dark">
                                                                            {faq.q}
                                                                        </span>
                                                                        <ChevronDown
                                                                            className={cn(
                                                                                'h-4 w-4 flex-shrink-0 transition-transform',
                                                                                'text-text-muted dark:text-text-muted-dark',
                                                                                open && 'rotate-180',
                                                                            )}
                                                                            aria-hidden="true"
                                                                        />
                                                                    </DisclosureButton>
                                                                    <DisclosurePanel className="border-t border-border px-4 py-2.5 text-xs leading-relaxed text-text-secondary dark:border-border-dark dark:text-text-secondary-dark">
                                                                        {faq.a}
                                                                        {faq.href && (
                                                                            <a
                                                                                href={faq.href}
                                                                                target="_blank"
                                                                                rel="noopener noreferrer"
                                                                                className={cn(
                                                                                    'mt-2 inline-flex items-center gap-1 font-medium',
                                                                                    'text-primary hover:underline dark:text-primary-dark',
                                                                                )}
                                                                            >
                                                                                {t('faq.learnMore')}
                                                                                <ExternalLink
                                                                                    className="h-3 w-3"
                                                                                    aria-hidden="true"
                                                                                />
                                                                            </a>
                                                                        )}
                                                                    </DisclosurePanel>
                                                                </div>
                                                            )}
                                                        </Disclosure>
                                                    ))}
                                                </div>
                                            </section>

                                            {/* Resources */}
                                            <section>
                                                <SectionHeading>{t('links.title')}</SectionHeading>
                                                <div className={cn(CARD, DIVIDE)}>
                                                    {links.map((link, index) => (
                                                        <a
                                                            key={index}
                                                            href={link.href}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className={cn(
                                                                ROW,
                                                                'transition-colors',
                                                                'hover:bg-surface dark:hover:bg-surface-secondary-dark',
                                                            )}
                                                        >
                                                            <span className="flex items-center gap-3">
                                                                <link.icon className="w-4 h-4 text-text-secondary dark:text-text-secondary-dark" />
                                                                <span className="text-xs font-medium text-text dark:text-text-dark">
                                                                    {link.label}
                                                                </span>
                                                            </span>
                                                            <ExternalLink className="w-3.5 h-3.5 text-text-muted dark:text-text-muted-dark" />
                                                        </a>
                                                    ))}
                                                </div>
                                            </section>

                                            {/* Support */}
                                            <section>
                                                <div
                                                    className={cn(
                                                        'rounded-xl border border-primary/20 bg-primary/5 p-4',
                                                    )}
                                                >
                                                    <div className="flex items-start gap-3">
                                                        <LifeBuoy className="h-5 w-5 flex-shrink-0 text-primary" />
                                                        <div className="space-y-1">
                                                            <p className="text-xs font-semibold text-text dark:text-text-dark">
                                                                {t('support.title')}
                                                            </p>
                                                            <p className="text-xs leading-relaxed text-text-secondary dark:text-text-secondary-dark">
                                                                {t('support.description')}
                                                            </p>
                                                            <a
                                                                href={DISCUSSIONS_URL}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                className={cn(
                                                                    'mt-1 inline-flex items-center gap-1',
                                                                    'text-xs font-medium text-primary',
                                                                    'hover:underline',
                                                                )}
                                                            >
                                                                {t('support.action')}
                                                                <ExternalLink className="h-3 w-3" />
                                                            </a>
                                                        </div>
                                                    </div>
                                                </div>
                                            </section>

                                            {/* System */}
                                            <section>
                                                <SectionHeading icon={Server}>
                                                    {t('system.title')}
                                                </SectionHeading>
                                                <div className={cn(CARD, DIVIDE)}>
                                                    <div className={ROW}>
                                                        <span className="flex items-center gap-2 text-xs text-text dark:text-text-dark">
                                                            <span className="h-2 w-2 rounded-full bg-green-500" />
                                                            {t('system.operational')}
                                                        </span>
                                                        {STATUS_URL && (
                                                            <a
                                                                href={STATUS_URL}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                className="text-text-muted transition-colors hover:text-primary dark:text-text-muted-dark"
                                                            >
                                                                <ExternalLink className="h-3.5 w-3.5" />
                                                            </a>
                                                        )}
                                                    </div>
                                                    <div className={ROW}>
                                                        <span className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                                            {t('system.environment')}
                                                        </span>
                                                        <span className="text-xs font-medium capitalize text-text dark:text-text-dark">
                                                            {APP_ENV}
                                                        </span>
                                                    </div>
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
                                                {t('version', { version: APP_VERSION })}
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
