import {
    CATEGORY_ICON_LIBRARY,
    getFallbackIcon,
    lookupCuratedIcon,
} from '../curated-mapping';

describe('lookupCuratedIcon', () => {
    describe('null inputs', () => {
        it.each<[string, string | null | undefined]>([
            ['empty string', ''],
            ['whitespace only', '   '],
            ['undefined', undefined],
            ['null', null],
        ])('returns null for %s', (_, input) => {
            expect(lookupCuratedIcon(input as string)).toBeNull();
        });
    });

    describe('exact slug match', () => {
        it('matches a library key directly', () => {
            const icon = lookupCuratedIcon('rocket');
            expect(icon).not.toBeNull();
            expect(icon?.name).toBe('rocket');
        });

        it('normalizes spaces and underscores to hyphens', () => {
            expect(lookupCuratedIcon('map pin')?.name).toBe('map-pin');
            expect(lookupCuratedIcon('map_pin')?.name).toBe('map-pin');
            expect(lookupCuratedIcon('Map-Pin')?.name).toBe('map-pin');
        });
    });

    describe('keyword pattern match', () => {
        it.each<[string, string]>([
            ['Open-Source', 'code'],
            ['open source projects', 'code'],
            ['FOSS Tools', 'code'],
            ['Time-Tracking', 'clock'],
            ['Productivity', 'briefcase'],
            ['Free apps', 'gift'],
            ['AI Chatbots', 'brain'],
            ['Machine Learning', 'brain'],
            ['Cloud Storage', 'cloud'],
            ['SaaS', 'cloud'],
            ['SQL Databases', 'database'],
            ['Security Tools', 'shield'],
            ['Auth & Identity', 'shield'],
            ['Email Clients', 'mail'],
            ['Project Management', 'kanban'],
            ['Customer Support', 'headphones'],
            ['No-code Automation', 'workflow'],
            ['Container Orchestration', 'package'],
            ['DevOps', 'rocket'],
        ])('maps "%s" to %s', (name, expectedIconName) => {
            const icon = lookupCuratedIcon(name);
            expect(icon).not.toBeNull();
            expect(icon?.name).toBe(expectedIconName);
        });

        it('returns null for category names with no rule match', () => {
            expect(lookupCuratedIcon('Quantum Spectroscopy Hardware')).toBeNull();
            expect(lookupCuratedIcon('Astrophysics Telescopes')).toBeNull();
            expect(lookupCuratedIcon('Glassblowing Furnaces')).toBeNull();
        });

        it('prefers more-specific rules ordered first (time-tracking vs time)', () => {
            const tt = lookupCuratedIcon('Time-Tracking');
            const tt2 = lookupCuratedIcon('Time tracking apps');
            expect(tt?.name).toBe('clock');
            expect(tt2?.name).toBe('clock');
        });
    });
});

describe('getFallbackIcon', () => {
    it('returns the tag glyph from the library', () => {
        const icon = getFallbackIcon();
        expect(icon).toBeDefined();
        expect(icon.name).toBe('tag');
        expect(icon.svg).toContain('<svg');
        expect(icon.svg).toContain('</svg>');
    });
});

describe('CATEGORY_ICON_LIBRARY', () => {
    it('every entry has a name and a non-empty SVG', () => {
        for (const [key, icon] of Object.entries(CATEGORY_ICON_LIBRARY)) {
            expect(icon.name).toBe(key);
            expect(icon.svg.length).toBeGreaterThan(50);
            expect(icon.svg.startsWith('<svg')).toBe(true);
            expect(icon.svg.endsWith('</svg>')).toBe(true);
        }
    });

    it('every entry uses currentColor for stroke (themable)', () => {
        for (const icon of Object.values(CATEGORY_ICON_LIBRARY)) {
            expect(icon.svg).toContain('stroke="currentColor"');
        }
    });
});
