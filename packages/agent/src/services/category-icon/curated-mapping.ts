/**
 * Curated category-name → SVG icon mapping (Tier 1 of icon resolution).
 *
 * Why: AI-generated SVGs are visually inconsistent and cost ~$0.01-0.05 per
 * call. ~80% of categories Ever Works classifiers produce match well-known
 * concepts (Productivity, Open-Source, Time-Tracking, …) for which a small
 * library of hand-picked Lucide icons gives instant, free, visually
 * consistent results. Tier 2 (AI generation) only fires for the long tail.
 *
 * The icons themselves are minimal Lucide-style SVG markup (24×24 viewBox,
 * 2px stroke, currentColor) embedded as strings to keep the agent package
 * dependency-free of React/Lucide. Source: lucide.dev (ISC license).
 */

export interface CuratedIcon {
    /** Lucide icon name — useful for debugging / future swaps. */
    readonly name: string;
    /** Inline SVG markup. 24×24 viewBox, currentColor stroke, no width/height. */
    readonly svg: string;
}

const SVG_OPEN =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
const SVG_CLOSE = '</svg>';

const wrap = (paths: string): string => `${SVG_OPEN}${paths}${SVG_CLOSE}`;

/**
 * Library of curated icons keyed by short slug. Add new entries here and
 * reference them from KEYWORD_RULES below.
 */
export const CATEGORY_ICON_LIBRARY: Readonly<Record<string, CuratedIcon>> = Object.freeze({
    code: {
        name: 'code',
        svg: wrap('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
    },
    'code-2': {
        name: 'code-2',
        svg: wrap('<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>'),
    },
    briefcase: {
        name: 'briefcase',
        svg: wrap(
            '<rect width="20" height="14" x="2" y="7" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
        ),
    },
    clock: {
        name: 'clock',
        svg: wrap('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
    },
    gift: {
        name: 'gift',
        svg: wrap(
            '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>',
        ),
    },
    brain: {
        name: 'brain',
        svg: wrap(
            '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>',
        ),
    },
    cloud: {
        name: 'cloud',
        svg: wrap('<path d="M17.5 19a4.5 4.5 0 1 0-1.42-8.78 7 7 0 1 0-13.04 3.78"/>'),
    },
    database: {
        name: 'database',
        svg: wrap(
            '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
        ),
    },
    search: {
        name: 'search',
        svg: wrap('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
    },
    shield: {
        name: 'shield',
        svg: wrap(
            '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
        ),
    },
    'chart-bar': {
        name: 'chart-bar',
        svg: wrap(
            '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 16h2"/><path d="M11 12h2"/><path d="M15 8h2"/>',
        ),
    },
    'message-circle': {
        name: 'message-circle',
        svg: wrap('<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>'),
    },
    mail: {
        name: 'mail',
        svg: wrap(
            '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
        ),
    },
    calendar: {
        name: 'calendar',
        svg: wrap(
            '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
        ),
    },
    music: {
        name: 'music',
        svg: wrap(
            '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
        ),
    },
    video: {
        name: 'video',
        svg: wrap(
            '<path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/>',
        ),
    },
    camera: {
        name: 'camera',
        svg: wrap(
            '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
        ),
    },
    palette: {
        name: 'palette',
        svg: wrap(
            '<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
        ),
    },
    terminal: {
        name: 'terminal',
        svg: wrap('<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>'),
    },
    'file-text': {
        name: 'file-text',
        svg: wrap(
            '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/>',
        ),
    },
    'check-square': {
        name: 'check-square',
        svg: wrap(
            '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
        ),
    },
    'book-open': {
        name: 'book-open',
        svg: wrap(
            '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
        ),
    },
    newspaper: {
        name: 'newspaper',
        svg: wrap(
            '<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8z"/>',
        ),
    },
    users: {
        name: 'users',
        svg: wrap(
            '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
        ),
    },
    gamepad: {
        name: 'gamepad',
        svg: wrap(
            '<line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258a3.998 3.998 0 0 0-3.995-3.742Z"/>',
        ),
    },
    'dollar-sign': {
        name: 'dollar-sign',
        svg: wrap(
            '<line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
        ),
    },
    'shopping-cart': {
        name: 'shopping-cart',
        svg: wrap(
            '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
        ),
    },
    plane: {
        name: 'plane',
        svg: wrap(
            '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
        ),
    },
    heart: {
        name: 'heart',
        svg: wrap(
            '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
        ),
    },
    'cloud-sun': {
        name: 'cloud-sun',
        svg: wrap(
            '<path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/>',
        ),
    },
    'map-pin': {
        name: 'map-pin',
        svg: wrap(
            '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
        ),
    },
    activity: {
        name: 'activity',
        svg: wrap(
            '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.5.5 0 0 1-.96 0L9.68 3.18a.5.5 0 0 0-.96 0l-2.35 8.36A2 2 0 0 1 4.44 13H2"/>',
        ),
    },
    flask: {
        name: 'flask',
        svg: wrap(
            '<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/>',
        ),
    },
    rocket: {
        name: 'rocket',
        svg: wrap(
            '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
        ),
    },
    package: {
        name: 'package',
        svg: wrap(
            '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="m7.5 4.27 9 5.15"/>',
        ),
    },
    plug: {
        name: 'plug',
        svg: wrap(
            '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
        ),
    },
    workflow: {
        name: 'workflow',
        svg: wrap(
            '<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>',
        ),
    },
    globe: {
        name: 'globe',
        svg: wrap(
            '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
        ),
    },
    archive: {
        name: 'archive',
        svg: wrap(
            '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
        ),
    },
    headphones: {
        name: 'headphones',
        svg: wrap(
            '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4a1 1 0 0 1-1-1zm18 0h-3a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h2a1 1 0 0 0 1-1z"/><path d="M21 14a9 9 0 0 0-18 0"/>',
        ),
    },
    'user-check': {
        name: 'user-check',
        svg: wrap(
            '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/>',
        ),
    },
    kanban: {
        name: 'kanban',
        svg: wrap('<path d="M6 5v11"/><path d="M12 5v6"/><path d="M18 5v14"/>'),
    },
    tag: {
        name: 'tag',
        svg: wrap(
            '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
        ),
    },
});

export type CuratedIconKey = keyof typeof CATEGORY_ICON_LIBRARY;

interface KeywordRule {
    readonly patterns: readonly RegExp[];
    readonly iconKey: CuratedIconKey;
}

/**
 * Ordered match rules: first hit wins. More-specific patterns should
 * appear before more-general ones (e.g. `time-tracking` before `time`).
 */
const KEYWORD_RULES: readonly KeywordRule[] = [
    { patterns: [/\btime[-\s]?tracking\b/i, /\btimesheet/i], iconKey: 'clock' },
    { patterns: [/\bopen[-\s]?source\b/i, /\bfoss\b/i, /\boss\b/i], iconKey: 'code' },
    {
        patterns: [/\bcommercial\b/i, /\benterprise\b/i, /\bbusiness\b/i, /\bb2b\b/i],
        iconKey: 'briefcase',
    },
    { patterns: [/\bproductivity\b/i], iconKey: 'briefcase' },
    { patterns: [/\bfree(ware)?\b/i, /\bgift\b/i, /\bfreemium\b/i], iconKey: 'gift' },
    { patterns: [/\b(?:ai|gpt|llm|machine[-\s]?learning|neural)\b/i], iconKey: 'brain' },
    { patterns: [/\b(?:cloud|saas|paas|iaas)\b/i], iconKey: 'cloud' },
    {
        patterns: [/\bdatabase\b/i, /\bdb\b/i, /\bdata[-\s]?store\b/i, /\bsql\b/i, /\bnosql\b/i],
        iconKey: 'database',
    },
    { patterns: [/\bsearch\b/i, /\bdiscover/i], iconKey: 'search' },
    {
        patterns: [/\b(?:security|auth|encryption|privacy|firewall|antivirus)\b/i],
        iconKey: 'shield',
    },
    { patterns: [/\b(?:analytic|metric|dashboard|insight|report)/i], iconKey: 'chart-bar' },
    { patterns: [/\b(?:chat|messaging|messenger|im)\b/i], iconKey: 'message-circle' },
    { patterns: [/\b(?:email|mail|inbox|smtp)\b/i], iconKey: 'mail' },
    { patterns: [/\b(?:calendar|schedul|booking|appointment)/i], iconKey: 'calendar' },
    { patterns: [/\b(?:music|audio|podcast|sound)\b/i], iconKey: 'music' },
    { patterns: [/\b(?:video|stream|broadcast)/i], iconKey: 'video' },
    { patterns: [/\b(?:photo|camera|image)\b/i], iconKey: 'camera' },
    { patterns: [/\b(?:design|graphics|illustrat|sketch|figma)/i], iconKey: 'palette' },
    {
        patterns: [/\b(?:cli|terminal|shell|console)\b/i, /\b(?:ide|editor)\b/i],
        iconKey: 'terminal',
    },
    {
        patterns: [/\b(?:dev|developer)[-\s]?tools?\b/i, /\bcoding\b/i, /\bprogramming\b/i],
        iconKey: 'code-2',
    },
    { patterns: [/\b(?:notes?|journal|document|wiki|knowledge)\b/i], iconKey: 'file-text' },
    { patterns: [/\b(?:todo|tasks?|gtd|reminder)\b/i], iconKey: 'check-square' },
    {
        patterns: [/\b(?:education|learn|course|training|tutorial|book|read)/i],
        iconKey: 'book-open',
    },
    { patterns: [/\b(?:news|newsletter|rss)\b/i], iconKey: 'newspaper' },
    { patterns: [/\b(?:social|community|forum|network)/i], iconKey: 'users' },
    { patterns: [/\bgam(?:ing|es?)\b/i], iconKey: 'gamepad' },
    {
        patterns: [/\b(?:finance|banking|crypto|payment|invest|fintech|accounting)/i],
        iconKey: 'dollar-sign',
    },
    {
        patterns: [/\b(?:shopping|ecommerce|retail|marketplace|store)\b/i],
        iconKey: 'shopping-cart',
    },
    { patterns: [/\b(?:travel|flight|hotel|tourism|booking)\b/i], iconKey: 'plane' },
    { patterns: [/\b(?:health|fitness|medical|wellness|workout)\b/i], iconKey: 'heart' },
    { patterns: [/\b(?:weather|climate|forecast)\b/i], iconKey: 'cloud-sun' },
    { patterns: [/\b(?:maps?|navigation|geo|location)/i], iconKey: 'map-pin' },
    { patterns: [/\b(?:monitor|observ|logging|tracing|alerting)/i], iconKey: 'activity' },
    {
        patterns: [/\b(?:test|qa|quality[-\s]?assurance|automated[-\s]?testing)\b/i],
        iconKey: 'flask',
    },
    { patterns: [/\b(?:deployment|devops|ci[-\s]?cd|hosting)\b/i], iconKey: 'rocket' },
    { patterns: [/\b(?:container|docker|kubernetes|k8s|orchestrat)/i], iconKey: 'package' },
    { patterns: [/\b(?:api|microservice|webhook|integration|service)\b/i], iconKey: 'plug' },
    { patterns: [/\b(?:collaboration|teamwork)\b/i, /\bteams?\b/i], iconKey: 'users' },
    { patterns: [/\b(?:project[-\s]?management|pm|agile|scrum|kanban)\b/i], iconKey: 'kanban' },
    { patterns: [/\b(?:crm|customer[-\s]?support|helpdesk|ticketing)\b/i], iconKey: 'headphones' },
    {
        patterns: [/\b(?:hr|hrm|human[-\s]?resources|recruit|hiring|payroll)\b/i],
        iconKey: 'user-check',
    },
    {
        patterns: [/\b(?:automation|workflow|rpa|no[-\s]?code|low[-\s]?code|zapier)\b/i],
        iconKey: 'workflow',
    },
    { patterns: [/\b(?:vpn|networking|proxy|browser|web)\b/i], iconKey: 'globe' },
    { patterns: [/\b(?:backup|archive|storage)\b/i], iconKey: 'archive' },
];

const FALLBACK_ICON_KEY: CuratedIconKey = 'tag';

/**
 * Resolve a category name to a curated icon. Returns null when the name
 * doesn't match any known concept — the caller should fall back to AI
 * generation (Tier 2) or {@link getFallbackIcon}.
 */
export function lookupCuratedIcon(categoryName: string): CuratedIcon | null {
    if (!categoryName) {
        return null;
    }

    const normalized = categoryName.toLowerCase().trim();
    if (!normalized) {
        return null;
    }

    // Exact slug match against the library (e.g. "code-2", "rocket").
    const slugified = normalized.replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (slugified && slugified in CATEGORY_ICON_LIBRARY) {
        return CATEGORY_ICON_LIBRARY[slugified];
    }

    // Pattern-based keyword match — first rule whose pattern hits wins.
    for (const rule of KEYWORD_RULES) {
        if (rule.patterns.some((re) => re.test(normalized))) {
            return CATEGORY_ICON_LIBRARY[rule.iconKey];
        }
    }

    return null;
}

/** Default "?" / generic-tag icon used when no other source produces SVG. */
export function getFallbackIcon(): CuratedIcon {
    return CATEGORY_ICON_LIBRARY[FALLBACK_ICON_KEY];
}
