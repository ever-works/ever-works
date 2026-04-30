import type { Config } from '@docusaurus/types';
import path from 'path';
import { themes as prismThemes } from 'prism-react-renderer';

const SENTRY_DNS = process.env.NEXT_PUBLIC_SENTRY_DNS || null;
const ALGOLIA_APP_ID = process.env.ALGOLIA_APP_ID || null;
const ALGOLIA_API_KEY = process.env.ALGOLIA_API_KEY || null;
const ALGOLIA_INDEX_NAME = process.env.ALGOLIA_INDEX_NAME || null;
const HAS_ALGOLIA_CREDENTIALS = ALGOLIA_APP_ID && ALGOLIA_API_KEY && ALGOLIA_INDEX_NAME;
require('dotenv').config();
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
	tagline: 'Modern Directory Website Solution',
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
	staticDirectories: ['../../docs/assets', 'static'],
	// Even if you don't use internationalization, you can use this field to set
	// useful metadata like html lang. For example, if your site is Chinese, you
	// may want to replace "en" with "zh-Hans".
	i18n: {
		path: 'i18n',
		defaultLocale: 'en',
		locales: ['en', 'fr', 'ar', 'bg', 'zh', 'nl', 'de', 'he', 'it', 'pl', 'pt', 'ru', 'es']
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
					editUrl: 'https://github.com/ever-works/ever-works/tree/main/'
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
								href: 'https://stackoverflow.com/questions/tagged/ever-works-website-template'
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
				copyright: `Copyright © 2024-Present <a href="https://ever.co/" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: underline;">Ever Co. LTD.</a>`
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
		EVER_WORKS_WEBSITE_TEMPLATE_API_URL: process.env.EVER_WORKS_WEBSITE_TEMPLATE_API_URL,
		footerData: {
			description: 'Ever Works is an open-source modern directory website solution.',
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
					description: 'Modern Directory Website Solution',
					icon: '/img/ever-works.svg'
				}
			],
			companyInfo: {
				copyright: `Copyright © ${new Date().getFullYear()} Ever Co. LTD. All Rights Reserved.`,
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
