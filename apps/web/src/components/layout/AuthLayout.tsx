'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Sparkles, LayoutTemplate, Database } from 'lucide-react';
import Image from 'next/image';
import DotLottiePlayer from '../ui/DotLottiePlayer';

interface AuthLayoutProps {
    children: React.ReactNode;
    title: string;
    subtitle: string;
    formWidth?: string;
    mLeft?: string;
    innerMaxWidth?: string;
}

// ─── Icon component type used by benefit items ──────────────────────────────
type IconType = React.ComponentType<any>;

// ─── Cycling benefit card ────────────────────────────────────────────────────
type BenefitItem = {
    title: string;
    desc: string;
    icon: IconType;
    color: 'violet' | 'indigo' | 'blue';
};

function BenefitCarousel({ items }: { items: BenefitItem[] }) {
    const [active, setActive] = useState(0);
    const [phase, setPhase] = useState<'in' | 'out'>('in');
    const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        const id = setInterval(() => {
            setPhase('out');
            timeoutRef.current = setTimeout(() => {
                setActive((p) => (p + 1) % items.length);
                setPhase('in');
            }, 380);
        }, 3400);
        return () => {
            clearInterval(id);
            if (timeoutRef.current !== null) {
                clearTimeout(timeoutRef.current);
            }
        };
    }, [items.length]);

    let item = items[active];

    const palette = {
        violet: {
            card: 'bg-violet-500/10 border-violet-500/25',
            icon: 'bg-violet-500/20 border-violet-500/30 text-violet-300',
            dot: 'bg-violet-400',
            title: 'text-violet-200',
        },
        indigo: {
            card: 'bg-indigo-500/10 border-indigo-500/25',
            icon: 'bg-indigo-500/20 border-indigo-500/30 text-indigo-300',
            dot: 'bg-indigo-400',
            title: 'text-indigo-200',
        },
        blue: {
            card: 'bg-blue-500/10 border-blue-500/25',
            icon: 'bg-blue-500/20 border-blue-500/30 text-blue-300',
            dot: 'bg-blue-400',
            title: 'text-blue-200',
        },
    } as const;

    let c = palette[item.color];

    return (
        <div className="w-full max-w-xs">
            <div
                className={`rounded-2xl border p-5 pt-8 relative ${c.card}`}
                style={{
                    opacity: phase === 'in' ? 1 : 0,
                    transform: phase === 'in' ? 'translateY(0px)' : 'translateY(10px)',
                    transition: 'opacity 380ms ease, transform 380ms ease',
                }}
            >
                <div
                    className={`w-10 h-10 absolute rounded-xl top-1.5 right-1.5 flex items-center justify-center border mb-4 ${c.icon}`}
                >
                    {React.createElement(item.icon, { size: 20, strokeWidth: 1.5 })}
                </div>
                <h3 className={`text-sm font-semibold mb-1 ${c.title}`}>{item.title}</h3>
                <p className="text-xs text-slate-400 leading-relaxed">{item.desc}</p>
            </div>

            {/* dot strip */}
            <div className="flex items-center justify-center gap-1.5 mt-3">
                {items.map((item, i) => (
                    <span
                        key={i}
                        className={`block rounded-full transition-all duration-300 ${
                            i === active ? palette[item.color].dot : 'bg-slate-500/50'
                        }`}
                        style={{
                            width: i === active ? 20 : 6,
                            height: 6,
                        }}
                    />
                ))}
            </div>
        </div>
    );
}

// ─── Animated background circles behind the player ─────────────────────────
function AnimatedBackgroundCircles() {
    return (
        <div className="absolute inset-0 flex items-center justify-center z-0 pointer-events-none">
            <span
                className="absolute rounded-full bg-violet-400/10 animate-ping"
                style={{
                    width: 240,
                    height: 240,
                    animationDuration: '3000ms',
                    animationDelay: '0ms',
                }}
            />
            <span
                className="absolute rounded-full bg-violet-400/20 animate-ping"
                style={{
                    width: 180,
                    height: 180,
                    animationDuration: '3000ms',
                    animationDelay: '600ms',
                }}
            />
            <span
                className="absolute rounded-full bg-violet-400/30 animate-ping"
                style={{
                    width: 100,
                    height: 100,
                    animationDuration: '3000ms',
                    animationDelay: '1200ms',
                }}
            />
        </div>
    );
}

// ─── How it works — four corner labels, appear sequentially then slow-bounce ─
const HOW_IT_WORKS = [
    {
        num: '01',
        key: 'feature.howItWorks.step1',
        pos: { top: '2%', right: 'calc(80%)' },
        align: 'right',
        delay: '0s',
    },
    {
        num: '02',
        key: 'feature.howItWorks.step2',
        pos: { top: '2%', left: 'calc(80%)' },
        align: 'left',
        delay: '0.25s',
    },
    {
        num: '03',
        key: 'feature.howItWorks.step3',
        pos: { bottom: '2%', right: 'calc(80%)' },
        align: 'right',
        delay: '0.5s',
    },
    {
        num: '04',
        key: 'feature.howItWorks.step4',
        pos: { bottom: '2%', left: 'calc(80%)' },
        align: 'left',
        delay: '0.75s',
    },
] as const;

function HowItWorks() {
    const t = useTranslations('layout.auth');
    const [shown, setShown] = useState(0);

    useEffect(() => {
        if (shown >= HOW_IT_WORKS.length) return;
        const id = setTimeout(() => setShown((p) => p + 1), 700);
        return () => clearTimeout(id);
    }, [shown]);

    return (
        <>
            {HOW_IT_WORKS.map((step, i) => {
                const visible = i < shown;
                return (
                    <div
                        key={i}
                        className="absolute pointer-events-none"
                        style={{
                            ...step.pos,
                            textAlign: step.align as React.CSSProperties['textAlign'],
                            opacity: visible ? 1 : 0,
                            transform: visible ? 'translateY(0px)' : 'translateY(10px)',
                            transition: 'opacity 600ms ease, transform 600ms ease',
                        }}
                    >
                        {/* inner wrapper handles the bounce */}
                        <div
                            className={visible ? 'animate-bounce' : ''}
                            style={{ animationDuration: '3.2s', animationDelay: step.delay }}
                        >
                            <div
                                className="flex items-center gap-2 px-3 py-2 rounded-xl border border-white/10 bg-white/5 backdrop-blur-md shadow-lg w-44"
                                style={{
                                    flexDirection: step.align === 'right' ? 'row-reverse' : 'row',
                                }}
                            >
                                <span className="shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-violet-500/30 text-violet-300 text-[10px] font-bold">
                                    {step.num}
                                </span>
                                <span className="text-[11px] font-medium text-white/70 leading-snug">
                                    {t(step.key as any)}
                                </span>
                            </div>
                        </div>
                    </div>
                );
            })}
        </>
    );
}

// ─── Component ────────────────────────────────────────────────────────────────
export function AuthLayout({
    children,
    title,
    subtitle,
    formWidth = 'lg:w-1/2',
    innerMaxWidth = 'max-w-md',
    mLeft = 'lg:ml-10',
}: AuthLayoutProps) {
    const t = useTranslations('layout.auth');

    return (
        <div className="bg-background dark:bg-surface-dark">
            <div className="flex">
                {/* ── Left side – form ── */}
                <div
                    className={`w-full ${formWidth} min-h-screen flex items-center justify-center px-8 py-12 ${mLeft}`}
                >
                    <div className={`w-full ${innerMaxWidth} px-12`}>
                        <div className="mb-8 mt-5">
                            <h1 className="text-3xl font-bold text-text dark:text-text-dark mb-2">
                                {title}
                            </h1>
                            <p className="text-text-secondary dark:text-text-secondary-dark">
                                {subtitle}
                            </p>
                        </div>

                        {children}
                    </div>
                </div>

                {/* ── Right side – animated work showcase ── */}
                <div
                    className={`hidden lg:flex lg:fixed lg:top-0 lg:right-0 lg:h-screen lg:w-1/2 overflow-hidden items-center justify-center px-10`}
                >
                    {/* solid background */}
                    <div className="absolute inset-0 bg-auth-bg dark:bg-auth-bg/90" />

                    {/* content */}
                    <div className="relative z-20 flex flex-col items-center justify-center gap-10 w-full h-full">
                        <Image
                            src="/bg-cards.png"
                            alt=""
                            width={480}
                            height={900}
                            className="object-contain object-left filter brightness-200 absolute top-0 left-0 w-full rotate-180 h-auto"
                        />

                        {/* headline */}
                        <div className="text-center">
                            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-violet-500/15 backdrop-blur-sm border border-violet-500/30 mb-4">
                                <span className="relative flex size-3">
                                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-75"></span>
                                    <span className="relative inline-flex size-3 rounded-full bg-violet-400"></span>
                                </span>
                                <span className="text-sm font-medium text-violet-300 tracking-wide">
                                    {t('feature.badge')}
                                </span>
                            </div>
                            <h2 className="text-3xl font-bold text-white mb-2">
                                {t('feature.title')}
                            </h2>
                            <p className="text-sm text-slate-400 max-w-sm mx-auto leading-relaxed">
                                {t('feature.subtitle')}
                            </p>
                        </div>

                        {/* player + corner labels */}
                        <div className="relative flex items-center justify-center">
                            <div className="relative w-70 h-70">
                                <AnimatedBackgroundCircles />
                                <DotLottiePlayer className="w-70 h-70 relative z-20" />
                                <HowItWorks />
                            </div>
                        </div>

                        {/* cycling benefit card */}
                        <BenefitCarousel
                            items={[
                                {
                                    title: t('feature.benefits.ai.title'),
                                    desc: t('feature.benefits.ai.description'),
                                    icon: Sparkles as IconType,
                                    color: 'violet',
                                },
                                {
                                    title: t('feature.benefits.templates.title'),
                                    desc: t('feature.benefits.templates.description'),
                                    icon: LayoutTemplate as IconType,
                                    color: 'indigo',
                                },
                                {
                                    title: t('feature.benefits.management.title'),
                                    desc: t('feature.benefits.management.description'),
                                    icon: Database as IconType,
                                    color: 'blue',
                                },
                            ]}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
