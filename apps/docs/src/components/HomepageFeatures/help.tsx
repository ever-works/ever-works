import { translate } from "@docusaurus/Translate";
import Heading from "@theme/Heading";
import clsx from "clsx";
import styles from "./styles.module.css";

function getHelpListItems() {
  return [
    {
      title: translate({
        id: "help.browseDocs.title",
        message: "Browse Docs",
        description: "Help page feature title for browsing docs",
      }),
      description: translate({
        id: "help.browseDocs.description",
        message: "Learn more using the documentation on this site.",
        description: "Help page feature description for browsing docs",
      }),
    },
    {
      title: translate({
        id: "help.joinCommunity.title",
        message: "Join the community",
        description: "Help page feature title for joining community",
      }),
      description: translate({
        id: "help.joinCommunity.description",
        message: "Ask questions about the documentation and project",
        description: "Help page feature description for joining community",
      }),
    },
    {
      title: translate({
        id: "help.stayUpToDate.title",
        message: "Stay up to date",
        description: "Help page feature title for staying up to date",
      }),
      description: translate({
        id: "help.stayUpToDate.description",
        message: "Find out what's new with this project",
        description: "Help page feature description for staying up to date",
      }),
    },
  ];
}

function HelpFeature({ title, description }) {
  return (
    <div className={clsx("col col--4")}>
      <div className="text--left padding-horiz--md">
        <Heading as="h2">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}
export default function HelpPageItems() {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {getHelpListItems().map((props, idx) => (
            <HelpFeature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
