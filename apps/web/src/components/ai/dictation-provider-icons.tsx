import * as React from 'react';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

/**
 * Brand-mark badges for the dictation provider picker in `ChatDictation`.
 *
 * The `/transcription/providers` endpoint returns `{ id, name, isActive }`
 * only — no icon — so the mark is resolved client-side from the plugin id.
 * Ids come from `everworks.plugin.id` in each `packages/plugins/*` manifest.
 *
 * Same approach (and same caveat) as `settings/job-runtime-provider-icons`:
 * these are stylised marks in each vendor's signature colour, NOT the
 * vendors' official trademarked logos, drawn as inlined theme-agnostic SVGs
 * so a mid-tone badge with a white glyph reads correctly in light and dark
 * mode without per-theme variants. They can be swapped for official SVGs
 * later without touching the call site.
 *
 * Rendered through the generic `Select`'s `iconMap` prop, keyed by the value
 * each `<option>` declares in `data-icon`. A plugin that adds `transcribe()`
 * later — with an id nobody drew a mark for — falls back to a neutral
 * monogram rather than to nothing: `Select` only reserves the leading column
 * when `iconMap` has a hit, so a missing entry would pull that row's label
 * left and leave the list visibly ragged.
 */

interface GlyphProps {
    /** Rendered pixel size (width === height). */
    size?: number;
}

// Shared badge wrapper: a rounded square filled with `color`, `children` is
// the white glyph drawn on top (coordinates in a 20×20 viewBox).
function Badge({
    color,
    size = 14,
    children,
}: GlyphProps & { color: string; children: React.ReactNode }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 20 20"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
        >
            <rect x="0" y="0" width="20" height="20" rx="5" fill={color} />
            {children}
        </svg>
    );
}

// OpenAI — signature green; six-spoke rosette standing in for the knot.
function OpenAiIcon({ size }: GlyphProps) {
    return (
        <Badge color="#10A37F" size={size}>
            <g stroke="#FFFFFF" strokeWidth="1.4" strokeLinecap="round">
                <path d="M10 5.6v8.8M6.2 7.8l7.6 4.4M13.8 7.8l-7.6 4.4" />
            </g>
        </Badge>
    );
}

// Anthropic — clay orange; the Claude starburst, simplified to four rays.
function AnthropicIcon({ size }: GlyphProps) {
    return (
        <Badge color="#D97757" size={size}>
            <g stroke="#FFFFFF" strokeWidth="1.5" strokeLinecap="round">
                <path d="M10 5.4v9.2M5.4 10h9.2M6.9 6.9l6.2 6.2M13.1 6.9l-6.2 6.2" />
            </g>
        </Badge>
    );
}

// Google Gemini — brand blue; four-point spark.
function GoogleIcon({ size }: GlyphProps) {
    return (
        <Badge color="#4285F4" size={size}>
            <path
                d="M10 4.8c.35 2.7 1.5 4 4.2 4.4-2.7.4-3.85 1.7-4.2 4.4-.35-2.7-1.5-4-4.2-4.4 2.7-.4 3.85-1.7 4.2-4.4Z"
                fill="#FFFFFF"
            />
        </Badge>
    );
}

// Groq — brand vermilion; an LPU chip (die with pins).
function GroqIcon({ size }: GlyphProps) {
    return (
        <Badge color="#F55036" size={size}>
            <rect x="6.4" y="6.4" width="7.2" height="7.2" rx="1.6" fill="#FFFFFF" />
            <g stroke="#FFFFFF" strokeWidth="1.2" strokeLinecap="round">
                <path d="M8.4 4.6v1.4M11.6 4.6v1.4M8.4 14v1.4M11.6 14v1.4M4.6 8.4h1.4M4.6 11.6h1.4M14 8.4h1.4M14 11.6h1.4" />
            </g>
        </Badge>
    );
}

// Mistral — brand orange; the stacked bars of the wordmark.
function MistralIcon({ size }: GlyphProps) {
    return (
        <Badge color="#FF7000" size={size}>
            <g fill="#FFFFFF">
                <rect x="4.8" y="6" width="10.4" height="1.8" rx="0.4" />
                <rect x="4.8" y="9.1" width="10.4" height="1.8" rx="0.4" />
                <rect x="4.8" y="12.2" width="10.4" height="1.8" rx="0.4" />
            </g>
        </Badge>
    );
}

// Ollama — near-black; the llama head, reduced to a muzzle and two ears.
function OllamaIcon({ size }: GlyphProps) {
    return (
        <Badge color="#111111" size={size}>
            <g fill="#FFFFFF">
                <rect x="6.1" y="4.4" width="1.9" height="4.2" rx="0.95" />
                <rect x="12" y="4.4" width="1.9" height="4.2" rx="0.95" />
                <rect x="6.4" y="8.2" width="7.2" height="7.2" rx="3" />
            </g>
        </Badge>
    );
}

// OpenRouter — indigo; two arrows routing past each other.
function OpenRouterIcon({ size }: GlyphProps) {
    return (
        <Badge color="#6467F2" size={size}>
            <g stroke="#FFFFFF" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4.8 7.6h3.4l3 4.8h3.9M11.6 5.9l2 1.7-2 1.7M11.6 10.7l2 1.7-2 1.7" />
            </g>
        </Badge>
    );
}

// Vercel AI Gateway — black; the Vercel triangle.
function VercelIcon({ size }: GlyphProps) {
    return (
        <Badge color="#000000" size={size}>
            <path d="M10 5.4 15.2 14.6H4.8L10 5.4Z" fill="#FFFFFF" />
        </Badge>
    );
}

/**
 * Fallback for a provider with no drawn mark: its first letter in a neutral
 * chip. Deliberately theme-toned rather than coloured — inventing a brand
 * colour for an unknown vendor would read as an official mark that is wrong.
 */
function MonogramIcon({ label, size = 14 }: GlyphProps & { label: string }) {
    const letter = label.trim().charAt(0).toUpperCase() || '?';
    return (
        <span
            aria-hidden="true"
            style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }}
            className={cn(
                'flex shrink-0 items-center justify-center rounded-lg font-semibold leading-none',
                'bg-surface-secondary text-text-muted dark:bg-white/10 dark:text-text-muted-dark',
            )}
        >
            {letter}
        </span>
    );
}

const ICON_BY_PROVIDER: Record<string, (props: GlyphProps) => React.ReactElement> = {
    openai: OpenAiIcon,
    anthropic: AnthropicIcon,
    google: GoogleIcon,
    groq: GroqIcon,
    mistral: MistralIcon,
    ollama: OllamaIcon,
    openrouter: OpenRouterIcon,
    'vercel-ai-gateway': VercelIcon,
};

/**
 * `data-icon` value for the "defer to the activated plugin" option. Not a
 * plugin id, so it cannot collide with one.
 */
export const DICTATION_AUTO_ICON_KEY = 'auto';

/** The neutral spark standing in for "defer to the activated plugin". */
const AUTO_ICON = (
    <Sparkles aria-hidden="true" className="size-3.5 text-text-muted dark:text-text-muted-dark" />
);

/**
 * Builds the `iconMap` for the `Select` from the providers the endpoint
 * actually returned: brand badge where one is drawn, monogram of the display
 * name otherwise, plus the auto option. Keyed off the live list rather than
 * off `ICON_BY_PROVIDER` so EVERY option gets an icon — an id with no entry
 * still needs the leading column, or its row sits out of line with the rest.
 *
 * Memoise at the call site; the returned nodes are new on every call.
 */
export function buildDictationProviderIcons(
    providers: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): Record<string, React.ReactNode> {
    const map: Record<string, React.ReactNode> = { [DICTATION_AUTO_ICON_KEY]: AUTO_ICON };
    for (const provider of providers) {
        const Icon = ICON_BY_PROVIDER[provider.id];
        map[provider.id] = Icon ? (
            <Icon size={14} />
        ) : (
            <MonogramIcon label={provider.name || provider.id} size={14} />
        );
    }
    return map;
}
