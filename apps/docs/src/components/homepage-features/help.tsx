import Heading from "@theme/Heading";
import clsx from "clsx";
import styles from "./styles.module.css";
const HelpListItem = [
  {
    title: "Browse Docs",
    description: <>Learn more using the documentation on this site.</>,
  },
  {
    title: "Join the community",
    description: <>Ask questions about the documentation and project</>,
  },
  {
    title: "Stay up to date",
    description: <>Find out what's new with this project</>,
  },
];

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
          {HelpListItem.map((props, idx) => (
            <HelpFeature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
