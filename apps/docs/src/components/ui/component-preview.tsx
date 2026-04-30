import React from "react";
import Tabs from "@theme/Tabs";
import TabItem from "@theme/TabItem";
import CodeBlock from "@theme/CodeBlock";

export default function ComponentPreview({
  children,
  code,
  language = "tsx",
}: {
  children: React.ReactNode;
  code: string;
  language: string;
}) {
  return (
    <Tabs groupId={code}>
      <TabItem value="preview" label="Preview" default>
        <div className="bg-[#f6f8fa] dark:bg-[#282a36] rounded-lg p-2 max-w-fit">
          {children}
        </div>
      </TabItem>
      <TabItem value="code" label="Code">
        <CodeBlock language={language}>{code}</CodeBlock>
      </TabItem>
    </Tabs>
  );
}
