import {
    EVER_STATS_DEFAULT_ENABLED,
    isEverStatsModuleEnabled,
    readEverStatsConfig,
    readWorksStatsFeatures,
} from '../ever-stats-config';

/**
 * The environment of the statistics module, read once: default OFF (opt in
 * with `EVER_STATS_ENABLED=true`), off with anything but `true`; the base URL
 * policy (https, or http for a private host only, never with credentials);
 * install source and country declared, never inferred; the interval floor
 * outside tests; strict feature booleans.
 */
describe('ever-stats-config', () => {
    it('is off by default: EVER_STATS_DEFAULT_ENABLED is false', () => {
        expect(EVER_STATS_DEFAULT_ENABLED).toBe(false);
    });

    it.each([
        [{}, false],
        [{ EVER_STATS_ENABLED: '' }, false],
        [{ EVER_STATS_ENABLED: '  ' }, false],
        [{ EVER_STATS_ENABLED: 'true' }, true],
        [{ EVER_STATS_ENABLED: ' true ' }, true],
        [{ EVER_STATS_ENABLED: 'false' }, false],
        [{ EVER_STATS_ENABLED: 'False' }, false],
        [{ EVER_STATS_ENABLED: 'TRUE' }, false],
        [{ EVER_STATS_ENABLED: '1' }, false],
        [{ EVER_STATS_ENABLED: '0' }, false],
        [{ EVER_STATS_ENABLED: 'off' }, false],
    ])('%j ⇒ enabled %s', (env, enabled) => {
        expect(isEverStatsModuleEnabled(env)).toBe(enabled);
        expect(readEverStatsConfig(env).enabled).toBe(enabled);
    });

    it.each([
        [{}, true],
        [{ EVER_STATS_ENABLED: '' }, true],
        [{ EVER_STATS_ENABLED: 'true' }, true],
        [{ EVER_STATS_ENABLED: 'false' }, false],
        [{ EVER_STATS_ENABLED: '0' }, false],
    ])(
        'with the default flipped back to on, %j ⇒ enabled %s (the previous behaviour)',
        (env, enabled) => {
            expect(isEverStatsModuleEnabled(env, true)).toBe(enabled);
        },
    );

    it('EVER_STATS_ENABLED overrides the default in both directions', () => {
        expect(isEverStatsModuleEnabled({ EVER_STATS_ENABLED: 'true' }, false)).toBe(true);
        expect(isEverStatsModuleEnabled({ EVER_STATS_ENABLED: 'false' }, true)).toBe(false);
    });

    it('defaults to off, the Ever Platform API, self-hosted, ZZ, daily, ever-stats-sink', () => {
        expect(readEverStatsConfig({})).toMatchObject({
            enabled: false,
            apiBaseUrl: 'https://api.ever.co',
            apiBaseUrlUsable: true,
            installSource: 'self-hosted',
            country: 'ZZ',
            sendIntervalS: 86_400,
            sinkPluginId: 'ever-stats-sink',
            warnings: [],
        });
    });

    it.each([
        ['https://stats.example.com/', 'https://stats.example.com'],
        ['https://stats.example.com/base/', 'https://stats.example.com/base'],
        ['http://localhost:4010', 'http://localhost:4010'],
        ['http://127.0.0.1:4010', 'http://127.0.0.1:4010'],
        ['http://10.1.2.3', 'http://10.1.2.3'],
        ['http://172.20.0.5:8080', 'http://172.20.0.5:8080'],
        ['http://192.168.1.10', 'http://192.168.1.10'],
        ['http://mock-platform:4010', 'http://mock-platform:4010'],
    ])('accepts %s', (raw, normalised) => {
        expect(readEverStatsConfig({ EVER_STATS_API_URL: raw })).toMatchObject({
            apiBaseUrl: normalised,
            apiBaseUrlUsable: true,
        });
    });

    it.each([
        'http://stats.example.com',
        'http://8.8.8.8',
        'https://user:pass@stats.example.com',
        'https://stats.example.com/?token=x',
        'ftp://stats.example.com',
        'not a url',
    ])('refuses %s — and never falls back to another host', (raw) => {
        const config = readEverStatsConfig({ EVER_STATS_API_URL: raw });
        expect(config.apiBaseUrlUsable).toBe(false);
        expect(config.warnings).toContain('EVER_STATS_API_URL:refused');
    });

    it('prefers EVER_STATS_API_URL over EVER_PLATFORM_API_URL', () => {
        expect(
            readEverStatsConfig({
                EVER_PLATFORM_API_URL: 'https://platform.example.test',
                EVER_STATS_API_URL: 'https://stats.example.com',
            }).apiBaseUrl,
        ).toBe('https://stats.example.com');
        expect(
            readEverStatsConfig({ EVER_PLATFORM_API_URL: 'https://platform.example.test' })
                .apiBaseUrl,
        ).toBe('https://platform.example.test');
    });

    it.each([
        ['cloud', 'cloud'],
        ['self-hosted', 'self-hosted'],
        ['ever.sh', 'ever.sh'],
        ['works_app', 'works_app'],
        ['desktop', 'desktop'],
        ['partner:acme-hosting', 'partner:acme-hosting'],
        ['partner:Acme', 'self-hosted'],
        ['https://acme.example', 'self-hosted'],
    ])('install source %s ⇒ %s', (raw, expected) => {
        expect(readEverStatsConfig({ EVER_INSTALL_SOURCE: raw }).installSource).toBe(expected);
    });

    it.each([
        ['DE', 'DE'],
        ['fr', 'FR'],
        ['Germany', 'ZZ'],
        ['D', 'ZZ'],
    ])('country %s ⇒ %s', (raw, expected) => {
        expect(readEverStatsConfig({ EVER_STATS_COUNTRY: raw }).country).toBe(expected);
    });

    it('keeps the interval floor outside tests', () => {
        expect(
            readEverStatsConfig({ EVER_STATS_SEND_INTERVAL_S: '5', NODE_ENV: 'production' }),
        ).toMatchObject({
            sendIntervalS: 3_600,
            warnings: ['EVER_STATS_SEND_INTERVAL_S:raised_to_floor'],
        });
        expect(
            readEverStatsConfig({ EVER_STATS_SEND_INTERVAL_S: '5', NODE_ENV: 'test' })
                .sendIntervalS,
        ).toBe(5);
        expect(
            readEverStatsConfig({ EVER_STATS_SEND_INTERVAL_S: '5', CI: 'true' }).sendIntervalS,
        ).toBe(5);
        expect(readEverStatsConfig({ EVER_STATS_SEND_INTERVAL_S: 'soon' }).sendIntervalS).toBe(
            86_400,
        );
    });

    it('reads feature switches strictly and only reports them', () => {
        expect(
            readWorksStatsFeatures({
                EVER_WORKS_APP_WORKS_ENABLED: 'TRUE',
                EVER_WORKS_APP_LAUNCHER_ENABLED: 'true',
                PLUGIN_DISTRIBUTION_MODE: 'Dynamic',
                DEPLOY_EVER_WORKS_ENABLED: '1',
                SUBSCRIPTIONS_ENABLED: 'true',
                EVER_WORKS_MCP_AUTH_MODE: '',
            }),
        ).toEqual({
            app_works_enabled: false,
            app_launcher_enabled: true,
            dynamic_plugins: true,
            deploy_ever_works_enabled: false,
            subscriptions_enabled: true,
            mcp_enabled: false,
        });
    });

    it('reports malformed values by name only, never their content', () => {
        const config = readEverStatsConfig({
            EVER_STATS_ENABLED: 'secret-word',
            EVER_STATS_COUNTRY: 'secret-word',
            EVER_INSTALL_SOURCE: 'secret-word',
            EVER_WORKS_STATS_SINK: 'Secret Word',
        });
        expect(config.warnings.join(' ')).not.toMatch(/secret/i);
        expect(config.warnings).toEqual(
            expect.arrayContaining([
                'EVER_STATS_ENABLED:unrecognised_value_treated_as_off',
                'EVER_STATS_COUNTRY:malformed',
                'EVER_INSTALL_SOURCE:malformed',
                'EVER_WORKS_STATS_SINK:malformed',
            ]),
        );
    });
});
