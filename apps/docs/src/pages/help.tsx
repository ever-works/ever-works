/**
 * Copyright (c) 2017-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { translate } from '@docusaurus/Translate';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Heading from '@theme/Heading';
import Layout from '@theme/Layout';
import clsx from 'clsx';
import HelpPageItems from '../components/HomepageFeatures/help';
import styles from './users.module.css';

function HelpPageHeader() {
	const { i18n } = useDocusaurusContext();
	const currentLocale = i18n.currentLocale;
	return (
		<header className={clsx('hero ', styles.heroBanner)}>
			<div className="container text--left">
				<Heading as="h2" className="hero__title">
					{translate({ id: 'help.message', message: 'Need help?' }, currentLocale)}
				</Heading>
				<p className="hero__subtitle">
					{translate(
						{
							id: 'help.description',
							message: 'This project is maintained by a dedicated group of people.'
						},
						currentLocale
					)}
				</p>
			</div>
		</header>
	);
}

export default function Help() {
	const { siteConfig } = useDocusaurusContext();
	return (
		<Layout title={`Help us ${siteConfig.title}`} description={siteConfig.tagline}>
			<HelpPageHeader />
			<main>
				<HelpPageItems />
			</main>
		</Layout>
	);
}
