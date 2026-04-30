import Translate from "@docusaurus/Translate";
import Heading from "@theme/Heading";

import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import clsx from "clsx";
import styles from "./users.module.css";

import Link from "@docusaurus/Link";
function UserspageHeader() {
  return (
    <header className={clsx("hero", styles.heroBanner)}>
      <div className="container">
        <Heading as="h1" className="hero__title text--primary">
          <Translate id="users.title" description="Users page heading">
            Who is Using This?
          </Translate>
        </Heading>
        <p className="hero__subtitle text--primary">
          <Translate
            id="users.subtitle"
            description="Users page subtitle"
          >
            This project is used by many folks
          </Translate>
        </p>
        <div className="logos">
          <a href="https://www.facebook.com">
            <img src="/img/docusaurus.svg" alt="User1" title="User1" />
          </a>
        </div>

        <p className="hero__subtitle text--primary">
          <Translate
            id="users.callToAction"
            description="Users page call to action"
          >
            Are you using this project?
          </Translate>
        </p>
        <div className={styles.buttons}>
          <Link
            className="button button--outline button--primary button--lg text-text--primary border--primary"
            to="/"
          >
            <Translate
              id="users.addCompany"
              description="Button label to add company"
            >
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
