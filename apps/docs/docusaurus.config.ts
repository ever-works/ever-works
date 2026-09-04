import type { Config } from '@docusaurus/types';
import path from 'path';
import { themes as prismThemes } from 'prism-react-renderer';

const SENTRY_DNS = process.env.NEXT_PUBLIC_SENTRY_DNS || null;
const ALGOLIA_APP_ID = process.env.ALGOLIA_APP_ID || null;
const ALGOLIA_API_KEY = process.env.ALGOLIA_API_KEY || null;
const ALGOLIA_INDEX_NAME = process.env.ALGOLIA_INDEX_NAME || null;
const HAS_ALGOLIA_CREDENTIALS = ALGOLIA_APP_ID && ALGOLIA_API_KEY && ALGOLIA_INDEX_NAME;
require('dotenv').config();

// Locales to BUILD. Docusaurus builds a full copy of the site per locale, so building
// the untranslated locales (only `fr` has any translations under apps/docs/i18n/) produced
// ~7,800 pages of en-duplicate content and overflowed the CI docker tmpfs (ENOSPC), failing
// the ever-works-docs build leg. Build only locales that have real content; override with
// DOCS_BUILD_LOCALES (comma-separated) to add a locale back once it's translated. The full
// aspirational set is kept below for reference so nothing is lost.
const ALL_LOCALES = ['en', 'fr', 'ar', 'bg', 'zh', 'nl', 'de', 'he', 'it', 'pl', 'pt', 'ru', 'es'];
const DOCS_BUILD_LOCALES = (process.env.DOCS_BUILD_LOCALES || 'en,fr')
	.split(',')
	.map((s) => s.trim())
	.filter((s) => ALL_LOCALES.includes(s));
/** @type {import('@docusaurus/types').Config} */
const config: Config = {
	themes: [
		[
			'@easyops-cn/docusaurus-search-local',
			/** @type {import("@easyops-cn/docusaurus-search-local").PluginOptions} */
			{
				hashed: true,
				language: ['en', 'fr'],
				highlightSearchTermsOnTargetPage: true,
				explicitSearchResultPath: true,
				docsRouteBasePath: '/',
				docsDir: '../../docs'
			}
		],
		'@docusaurus/theme-mermaid'
	],
	plugins: [
		// Disable webpack's persistent filesystem cache for the one-shot CI build — with
		// multiple locales it accumulates GBs and contributed to the docker tmpfs ENOSPC.
		() => ({
			name: 'disable-webpack-persistent-cache',
			configureWebpack: () => ({ cache: false })
		}),
		// EW-266 — legacy `/docs/*` URLs.
		//
		// The docs are served from the SITE ROOT (`presets.classic.docs.routeBasePath`
		// is '/' below, and docs/index.md carries `slug: /`), so the landing page of
		// https://docs.ever.works IS the documentation — there is no separate marketing
		// homepage to redirect away from. What did NOT work were the older
		// https://docs.ever.works/docs and /docs/<page> links that are still out there in
		// issues, blog posts, READMEs and bookmarks: nginx's `try_files` answered them
		// with a 404 (see .deploy/docker/docs/nginx.conf).
		//
		// Emit a static client-side redirect page for `/docs` and for `/docs/<every doc
		// route>` so those links land on the real page instead of the 404. The plugin
		// hands `createRedirects` route paths with the baseUrl already stripped, so this
		// works unchanged for every locale build (en at '/', fr at '/fr/', ...).
		[
			'@docusaurus/plugin-client-redirects',
			{
				redirects: [{ from: '/docs', to: '/' }],
				createRedirects(existingPath: string) {
					// '/' is already covered by the explicit '/docs' -> '/' redirect above,
					// and anything that genuinely lives under /docs/ must not shadow itself.
					if (existingPath === '/' || existingPath === '/docs' || existingPath.startsWith('/docs/')) {
						return undefined;
					}
					return [`/docs${existingPath}`];
				}
			}
		],
		SENTRY_DNS &&
			process.env.NODE_ENV === 'production' && [
				'docusaurus-plugin-sentry',
				{
					DSN: process.env.NEXT_PUBLIC_SENTRY_DNS
				}
			]
	],
	// Add custom scripts here that would be placed in <script> tags.
	scripts: [{ src: 'https://buttons.github.io/buttons.js', async: true }],
	title: 'Ever Works', // Title for your website.
	tagline: 'The Workshop for AI',
	favicon: 'img/favicon.ico',
	// Set the production Url of your site here
	url: 'https://docs.ever.works', // Your website URL
	// Set the /<baseUrl>/ pathname under which your site is served
	// For GitHub pages deployment, it is often '/<projectName>/'
	baseUrl: '/',

	// GitHub pages deployment config.
	// If you aren't using GitHub pages, you don't need these.
	organizationName: 'ever-works',
	// Used for publishing and more
	projectName: 'ever-works-docs',

	onBrokenLinks: 'warn',
	markdown: {
		format: 'detect',
		mermaid: true,
		hooks: {
			onBrokenMarkdownLinks: 'warn'
		}
	},
	// Docusaurus built-in field — name is fixed by the framework, do NOT
	// rename to `staticWorks` (the bulk Directory→Work rename did this and
	// broke `pnpm --filter ever-works-docs build` with "field not recognized").
	staticDirectories: ['../../docs/assets', 'static'],
	// Even if you don't use internationalization, you can use this field to set
	// useful metadata like html lang. For example, if your site is Chinese, you
	// may want to replace "en" with "zh-Hans".
	i18n: {
		path: 'i18n',
		defaultLocale: 'en',
		// Build only locales with real content (see DOCS_BUILD_LOCALES above). Full set:
		// ['en','fr','ar','bg','zh','nl','de','he','it','pl','pt','ru','es']
		locales: DOCS_BUILD_LOCALES
	},
	presets: [
		[
			'classic',
			/** @type {import('@docusaurus/preset-classic').Options} */
			{
				blog: false,
				docs: {
					sidebarPath: './sidebarsPlatform.ts',
					path: '../../docs/',
					routeBasePath: '/',
					// EW-266 — the string form of `editUrl` is appended to the doc path as
					// Docusaurus sees it, i.e. relative to THIS folder. Because `path` reaches
					// out of the app (`../../docs/`), the string form produced dead links like
					// `.../tree/main/../../docs/index.md` on the "Edit this page" control of
					// every page. The callback form gets `docPath` relative to the docs folder,
					// so the URL can be built correctly — and non-default locales can point at
					// the translation file they would actually edit.
					editUrl: ({ locale, docPath }: { locale: string; docPath: string }) =>
						locale === 'en'
							? `https://github.com/ever-works/ever-works/edit/develop/docs/${docPath}`
							: `https://github.com/ever-works/ever-works/edit/develop/apps/docs/i18n/${locale}/docusaurus-plugin-content-docs/current/${docPath}`
				},
				theme: {
					customCss: './src/css/custom.css'
				}
			}
		]
	],
	themeConfig:
		/** @type {import('@docusaurus/preset-classic').ThemeConfig} */
		{
			// Replace with your project's social card
			image: '/overview.png',

			colorMode: {
				defaultMode: 'dark'
			},
			navbar: {
				style: 'dark',
				logo: {
					alt: 'Ever® Works Logo',
					srcDark: '/img/ever-works.svg',
					src: 'img/ever-works-dark.svg'
				},
				items: [
					{
						type: 'docSidebar',
						sidebarId: 'platformSidebar',
						position: 'left',
						label: 'Home'
					},
					{ to: '/help', label: 'Help', position: 'left' },
					{ to: '/support', label: 'Support', position: 'left' },
					{
						type: 'localeDropdown',
						position: 'right',
						className: 'header-locale-link'
					},
					{
						href: 'https://github.com/ever-works',
						label: 'GitHub',
						position: 'right',
						className: 'header-github-link'
					}
				]
			},
			footer: {
				style: 'dark',
				logo: {
					src: '/img/ever-works.svg',
					height: 40
				},
				links: [
					{
						title: 'Docs',
						items: [
							{
								label: 'Home',
								to: '/'
							},
							{
								label: 'Getting Started',
								to: '/getting-started'
							},
							{
								label: 'Architecture',
								to: '/architecture'
							}
						]
					},
					{
						title: 'Community',
						items: [
							{
								label: 'User Showcases',
								href: '/users'
							},
							{
								label: 'Stack Overflow',
								href: 'https://stackoverflow.com/questions/tagged/ever-works'
							},
							{
								label: 'Discord Chat',
								href: 'https://discord.gg/ever'
							},
							{
								label: 'Twitter',
								href: 'https://twitter.com/everworks'
							}
						]
					},
					{
						title: 'More',
						items: [
							{
								label: 'GitHub',
								href: 'https://github.com/ever-works/ever-works'
							}
						]
					}
				],
				// Fallback for the stock Docusaurus footer. The site renders the
				// swizzled footer instead, which reads
				// `customFields.footerData.companyInfo.copyright` below — keep the
				// two in sync (EW-266).
				copyright: `Copyright © 2024-Present <a href="https://ever.co/" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: underline;">Ever Co. LTD.</a> All Rights Reserved.`
			},
			algolia: HAS_ALGOLIA_CREDENTIALS
				? {
						// The application ID provided by Algolia
						appId: process.env.ALGOLIA_APP_ID,

						// Public API key: it is safe to commit it
						apiKey: process.env.ALGOLIA_API_KEY,

						// The index name to query
						indexName: process.env.ALGOLIA_INDEX_NAME,

						// Optional: see doc section below
						contextualSearch: true,

						// Optional: Replace parts of the item URLs from Algolia.
						replaceSearchResultPathname: undefined,

						// Optional: Algolia search parameters
						searchParameters: {},

						// Optional: path for search page that enabled by default (`false` to disable it)
						searchPagePath: 'search',

						// Optional: whether the insights feature is enabled or not on Docsearch (`false` by default)
						insights: false
					}
				: undefined,
			prism: {
				theme: prismThemes.github,
				darkTheme: prismThemes.dracula
			}
		},
	customFields: {
		footerData: {
			description:
				'Ever Works is an open agentic runtime that autonomously builds content-rich web apps and Git repositories.',
			socialLinks: [
				{
					title: 'GitHub',
					href: 'https://github.com/ever-works',
					icon: 'github'
				},
				{
					title: 'Twitter',
					href: 'https://twitter.com/everworks',
					icon: 'twitter'
				},
				{
					title: 'Discord',
					href: 'https://discord.gg/ever',
					icon: 'discord'
				}
			],
			systemStatus: {
				status: 'normal',
				message: 'All systems operational'
			},
			products: [
				{
					name: 'Ever Gauzy',
					href: 'https://gauzy.co',
					description: 'Open-Source Business Management Platform',
					icon: '/img/ever-works.svg'
				},
				{
					name: 'Ever Demand',
					href: 'https://ever.co/demand',
					description: 'Open-Source On-Demand Commerce Platform',
					icon: '/img/ever-works.svg'
				},
				{
					name: 'Ever Teams',
					href: 'https://ever.team',
					description: 'Open-Source Work & Project Management Platform',
					icon: '/img/ever-team.svg'
				},
				{
					name: 'Ever Works',
					href: 'https://ever.works',
					description: 'The Workshop for AI',
					icon: '/img/ever-works.svg'
				}
			],
			companyInfo: {
				// EW-266 — this is the copyright line the site actually renders: the
				// swizzled footer (src/theme/Footer/index.tsx) draws from
				// `customFields.footerData`, not from `themeConfig.footer.copyright`
				// above (that one only feeds the stock Docusaurus footer). Keep the two
				// strings in sync. It is a fixed range rather than
				// `new Date().getFullYear()` so the footer reads
				// "© 2024-Present", not just the current year.
				copyright: 'Copyright © 2024-Present Ever Co. LTD. All Rights Reserved.',
				disclaimer:
					'*All product names, logos, and brands are property of their respective owners. All company, product and service names used in this website are for identification purposes only. Use of these names, logos, and brands does not imply endorsement.',
				legalLinks: [
					{
						text: 'Privacy Policy',
						href: 'https://ever.co/privacy'
					},
					{
						text: 'Terms of Service',
						href: 'https://ever.co/tos'
					},
					{
						text: 'Cookie Policy',
						href: 'https://ever.co/cookies'
					}
				]
			}
		}
	}
};

export default config;
