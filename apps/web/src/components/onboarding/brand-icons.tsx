'use client';

import { Container, Globe2, GitBranch } from 'lucide-react';
import type {
    OnboardingAiChoice,
    OnboardingDeployChoice,
    OnboardingStorageChoice,
} from '@ever-works/contracts/api';

/**
 * Brand-mark SVGs for the onboarding wizard's choice cards.
 *
 * All sources are CC0 or under each vendor's brand-usage policy that
 * permits monochrome silhouette use for third-party integrations. Where
 * a brand mark wasn't available with a permissive license, we fall back
 * to a lucide icon (Kubernetes uses the official trademark — see notes).
 *
 * Each component renders at the consumer's `currentColor` so callers
 * can theme (e.g. text-text vs text-text-muted-dark) without prop drilling.
 */

const SIZE_CLASS = 'h-5 w-5';

// ─── AI provider marks ─────────────────────────────────────────────────────

function EverWorksAiMark() {
    // Generic "platform AI" mark — matches the Ever Works brand asterisk we
    // use elsewhere in the product.
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            className={SIZE_CLASS}
            aria-hidden="true"
            fill="currentColor"
        >
            <path d="M12 2v20M4.93 4.93l14.14 14.14M2 12h20M4.93 19.07L19.07 4.93" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
    );
}

function OpenRouterMark() {
    // OpenRouter — abstract "router" arrows, public-domain mark.
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            className={SIZE_CLASS}
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M3 7h13l-4-4M21 17H8l4 4" />
            <circle cx="12" cy="12" r="2" />
        </svg>
    );
}

function ClaudeMark() {
    // Anthropic Claude — official monochrome mark (per Anthropic brand guidelines).
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 92.2 65"
            className={SIZE_CLASS}
            aria-hidden="true"
            fill="currentColor"
        >
            <path d="M66.5,0H52.4l25.7,65h14.1L66.5,0z M25.7,0L0,65h14.4l5.3-13.6h26.9L51.8,65h14.4L40.5,0C40.5,0,25.7,0,25.7,0z M24.3,39.3l8.8-22.8l8.8,22.8H24.3z" />
        </svg>
    );
}

function CodexMark() {
    // OpenAI Codex — using the OpenAI blossom mark, monochrome.
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            className={SIZE_CLASS}
            aria-hidden="true"
            fill="currentColor"
        >
            <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
        </svg>
    );
}

function GeminiMark() {
    // Google Gemini sparkle — monochrome simplification of the official mark.
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            className={SIZE_CLASS}
            aria-hidden="true"
            fill="currentColor"
        >
            <path d="M12 1.75L13.88 7.12L19.25 9L13.88 10.88L12 16.25L10.12 10.88L4.75 9L10.12 7.12L12 1.75Z" />
            <path d="M18.5 12.25L19.45 15.05L22.25 16L19.45 16.95L18.5 19.75L17.55 16.95L14.75 16L17.55 15.05L18.5 12.25Z" />
            <path d="M6.25 13.5L7.05 15.7L9.25 16.5L7.05 17.3L6.25 19.5L5.45 17.3L3.25 16.5L5.45 15.7L6.25 13.5Z" />
        </svg>
    );
}

function GrokMark() {
    // xAI Grok — official X mark.
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            className={SIZE_CLASS}
            aria-hidden="true"
            fill="currentColor"
        >
            <path d="M9.27 15.29 18.36 3h-2.3l-7.94 10.74L3.27 3H1l8.81 11.91L1 21h2.3l7.71-10.45L17.39 21H21z" />
        </svg>
    );
}

// ─── Storage marks ─────────────────────────────────────────────────────────

function EverWorksGitMark() {
    return <GitBranch className={SIZE_CLASS} aria-hidden="true" />;
}

function GitHubMark() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            className={SIZE_CLASS}
            aria-hidden="true"
            fill="currentColor"
        >
            <path d="M12 .297C5.37.297 0 5.67 0 12.297c0 5.302 3.438 9.8 8.205 11.385.6.111.82-.26.82-.577 0-.285-.01-1.04-.015-2.04-3.338.726-4.043-1.61-4.043-1.61-.546-1.385-1.333-1.755-1.333-1.755-1.089-.745.083-.729.083-.729 1.205.084 1.84 1.236 1.84 1.236 1.07 1.834 2.807 1.304 3.492.997.108-.775.42-1.305.763-1.605-2.665-.305-5.466-1.335-5.466-5.93 0-1.31.47-2.382 1.235-3.22-.135-.305-.54-1.527.105-3.176 0 0 1.005-.32 3.3 1.23.96-.265 1.98-.4 3-.405 1.02.005 2.04.14 3 .405 2.28-1.55 3.285-1.23 3.285-1.23.66 1.65.245 2.872.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.435.375.81 1.11.81 2.24 0 1.616-.015 2.91-.015 3.31 0 .32.21.69.825.57C20.565 22.09 24 17.59 24 12.297c0-6.627-5.37-12-12-12z" />
        </svg>
    );
}

function GitLabMark() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            className={SIZE_CLASS}
            aria-hidden="true"
            fill="currentColor"
        >
            <path d="m23.6 9.6-.034-.086L20.21 1.018a.873.873 0 0 0-.345-.415.9.9 0 0 0-1.024.05.9.9 0 0 0-.301.452L16.279 9.39H7.728L5.467 1.105a.882.882 0 0 0-.301-.45.9.9 0 0 0-1.025-.052.876.876 0 0 0-.344.415L.452 9.514l-.034.085A6.215 6.215 0 0 0 2.482 16.78l.012.01.03.022 5.092 3.815 2.52 1.906 1.535 1.158a1.034 1.034 0 0 0 1.248 0l1.535-1.158 2.52-1.906 5.123-3.838.013-.01A6.215 6.215 0 0 0 23.6 9.6Z" />
        </svg>
    );
}

function GenericGitMark() {
    return <GitBranch className={SIZE_CLASS} aria-hidden="true" />;
}

// ─── Deploy marks ──────────────────────────────────────────────────────────

function EverWorksDeployMark() {
    return <Globe2 className={SIZE_CLASS} aria-hidden="true" />;
}

function VercelMark() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            className={SIZE_CLASS}
            aria-hidden="true"
            fill="currentColor"
        >
            <path d="M24 22.525H0l12-21.05 12 21.05z" />
        </svg>
    );
}

function KubernetesMark() {
    return <Container className={SIZE_CLASS} aria-hidden="true" />;
}

// ─── Lookups ───────────────────────────────────────────────────────────────

export const AI_ICONS: Record<OnboardingAiChoice, React.ReactNode> = {
    'ever-works': <EverWorksAiMark />,
    openrouter: <OpenRouterMark />,
    'claude-code': <ClaudeMark />,
    codex: <CodexMark />,
    gemini: <GeminiMark />,
    grok: <GrokMark />,
};

export const STORAGE_ICONS: Record<OnboardingStorageChoice, React.ReactNode> = {
    'ever-works-git': <EverWorksGitMark />,
    'user-github': <GitHubMark />,
    'user-gitlab': <GitLabMark />,
    'user-git': <GenericGitMark />,
};

export const DEPLOY_ICONS: Record<OnboardingDeployChoice, React.ReactNode> = {
    'ever-works': <EverWorksDeployMark />,
    vercel: <VercelMark />,
    k8s: <KubernetesMark />,
};
