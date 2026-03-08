'use client';

import { useState } from 'react';
import Image from 'next/image';
import { useLocale } from 'next-intl';
import { useRouter, usePathname } from '@/i18n/navigation';
import { LOCALES } from '@/lib/constants';
import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

type Locale = (typeof LOCALES)[number];

const LOCALE_NAMES: Record<Locale, string> = {
    en: 'En',
    ar: 'Ar',
    bg: 'Bg',
    de: 'De',
    es: 'Es',
    fr: 'Fr',
    he: 'He',
    hi: 'Hi',
    id: 'Id',
    it: 'It',
    ja: 'Ja',
    ko: 'Ko',
    nl: 'Nl',
    pl: 'Pl',
    pt: 'Pt',
    ru: 'Ru',
    th: 'Th',
    tr: 'Tr',
    uk: 'Uk',
    vi: 'Vi',
    zh: 'Zh',
} as const;

const LOCALE_EMOJI_FALLBACK: Partial<Record<Locale, string>> = {
    en: '🇺🇸',
    ar: '🇸🇦',
    bg: '🇧🇬',
    de: '🇩🇪',
    es: '🇪🇸',
    fr: '🇫🇷',
    he: '🇮🇱',
    hi: '🇮🇳',
    id: '🇮🇩',
    it: '🇮🇹',
    ja: '🇯🇵',
    ko: '🇰🇷',
    nl: '🇳🇱',
    pl: '🇵🇱',
    pt: '🇵🇹',
    ru: '🇷🇺',
    th: '🇹🇭',
    tr: '🇹🇷',
    uk: '🇺🇦',
    vi: '🇻🇳',
    zh: '🇨🇳',
};

function FlagImage({
    locale,
    className,
    width = 18,
    height = 14,
}: {
    locale: Locale;
    className?: string;
    width?: number;
    height?: number;
}) {
    const [errored, setErrored] = useState(false);

    if (errored) {
        const emoji = LOCALE_EMOJI_FALLBACK[locale] ?? '🏳';
        return (
            <span
                style={{ width, height }}
                className={cn(
                    'inline-flex shrink-0 items-center justify-center rounded-[2px] bg-muted text-sm leading-none',
                    className,
                )}
                aria-hidden="true"
            >
                {emoji}
            </span>
        );
    }

    return (
        <Image
            src={`/flags/${locale}.svg`}
            alt=""
            aria-hidden="true"
            width={width}
            height={height}
            className={cn('shrink-0 rounded-[2px]', className)}
            onError={() => setErrored(true)}
            unoptimized
        />
    );
}

interface LanguageSelectorProps {
    className?: string;
}

export function LanguageSelector({ className }: LanguageSelectorProps) {
    const locale = useLocale() as Locale;
    const router = useRouter();
    const pathname = usePathname();

    const handleLocaleChange = (newLocale: Locale) => {
        router.replace(pathname, { locale: newLocale });
    };

    const currentLocaleName = LOCALE_NAMES[locale] || LOCALE_NAMES.en;

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    suppressHydrationWarning
                    type="button"
                    className={cn(
                        'inline-flex items-center justify-center',
                        'h-8 min-w-20 px-2 text-xs font-normal',
                        'rounded-md transition-all duration-200',
                        'bg-surface-secondary dark:bg-surface-secondary-dark',
                        'border border-border dark:border-border-dark',
                        'text-text dark:text-text-dark',
                        'hover:bg-surface-tertiary dark:hover:bg-surface-tertiary-dark',
                        'hover:border-border-secondary dark:hover:border-border-secondary-dark',
                        'focus:outline-none focus:ring-1 focus:ring-primary/20',
                        'active:scale-[0.98] ',
                        'cursor-pointer',
                        className,
                    )}
                    aria-label="Select language"
                >
                    <FlagImage locale={locale} className="mr-2" width={18} height={14} />
                    <span className="text-xs leading-tight whitespace-nowrap">
                        {currentLocaleName}
                    </span>
                    <ChevronDown
                        className="ml-2 w-3.5 h-3.5 opacity-60 shrink-0"
                        aria-hidden="true"
                    />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="min-w-16">
                {LOCALES.map((loc) => {
                    const isActive = locale === loc;
                    return (
                        <DropdownMenuItem
                            key={loc}
                            onClick={() => handleLocaleChange(loc)}
                            className={cn(
                                'flex items-center gap-2 mb-px py-1 hover:bg-surface-tertiary/50 hover:dark:bg-surface-tertiary-dark/70',
                                isActive &&
                                    'bg-surface-tertiary dark:bg-surface-tertiary-dark/80 cursor-pointer font-medium',
                                !isActive && 'cursor-pointer',
                            )}
                        >
                            <FlagImage locale={loc} className="shrink-0" width={18} height={14} />
                            <span>{LOCALE_NAMES[loc]}</span>
                        </DropdownMenuItem>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
