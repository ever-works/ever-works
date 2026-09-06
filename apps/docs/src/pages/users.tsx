import Translate from '@docusaurus/Translate';
import Heading from '@theme/Heading';

import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import clsx from 'clsx';
import styles from './users.module.css';

import Link from '@docusaurus/Link';

// EW-266 — this page used to carry the stock Docusaurus scaffold content: a
// "User1" placeholder logo (`/img/docusaurus.svg`) linking to facebook.com, and
// an "Add your company" button that pointed back at the site root. Both are
// replaced with real Ever Works destinations so every link on the page resolves
// somewhere useful.
const SHOWCASE_SUBMISSION_URL = 'https://github.com/ever-works/ever-works/issues/new';

function UserspageHeader() {
	return (
		<header className={clsx('hero', styles.heroBanner)}>
			<div className="container">
				<Heading as="h1" className="hero__title text--primary">
					<Translate id="users.title" description="Users page heading">
						Who is Using Ever Works?
					</Translate>
				</Heading>
				<p className="hero__subtitle text--primary">
					<Translate id="users.subtitle" description="Users page subtitle">
						Ever Works powers directories, blogs and other content-rich sites that AI agents build, deploy
						and keep up to date.
					</Translate>
				</p>

				<p className="hero__subtitle text--primary">
					<Translate id="users.callToAction" description="Users page call to action">
						Are you using Ever Works? Tell us about it and we will add you to this page.
					</Translate>
				</p>
				<div className={styles.buttons}>
					<Link
						className="button button--outline button--primary button--lg text-text--primary border--primary"
						to={SHOWCASE_SUBMISSION_URL}
					>
						<Translate id="users.addCompany" description="Button label to add company">
							Add your company
						</Translate>
					</Link>
				</div>
			</div>
		</header>
	);
}

export default function Users() {
	const { siteConfig } = useDocusaurusContext();
	return (
		<Layout title={`${siteConfig.title}`} description={siteConfig.tagline}>
			<UserspageHeader />
		</Layout>
	);
}
