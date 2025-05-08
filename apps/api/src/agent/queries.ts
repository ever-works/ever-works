import { HumanMessagePromptTemplate } from '@langchain/core/prompts';
import { ChatOpenAI } from '@langchain/openai';
import { Logger } from '@nestjs/common';
import { formatDate } from 'date-fns';
import { z } from 'zod';

const QUERY_PROMPT = `
# Role: Directory Content Scout AI

## Goal:
Generate effective search engine queries to discover websites, lists, articles, or existing directories containing items relevant to a user-specified directory topic. The aim is to find sources for populating a new directory website.

## Input Task Description:
<content>
{task}
</content>

## Constraints & Instructions:
1.  **Maximum Queries:** Generate no more than {max} queries.
2.  **Query Focus:** Prioritize queries likely to yield *lists*, *collections*, *roundups*, or *directories* of items (e.g., "best [type] for [purpose]", "list of [topic] resources", "top [category] in [location/field]", "comparison of [item type]").
3.  **"Awesome List" Inclusion:** If the task involves topics commonly curated in "awesome lists" (like software, development tools, learning resources, datasets, APIs, frameworks, etc.), *definitely* include queries like "awesome [topic]" or "awesome list [topic]". Evaluate task relevance for this.
4.  **Diversity:** Generate a mix of query types to cover different angles of the topic.
5.  **Relevance:** Ensure queries directly target the core subject of the user's task. Avoid overly broad or tangential queries.
6.  **Output Format:** Present the queries as a simple list, one query per line.

## Context (Use if relevant for time-sensitive topics):
Today is {day}, {datetime}.

## Generated Search Queries:
`.trim();

const queriesOutputSchema = z.object({
  queries: z.array(z.string()),
});

/**
 * Generates search queries for a given task.
 *
 * @param task User's prompt.
 * @param max The maximum number of queries to generate.
 * @returns An array of search queries.
 */
export async function generateQueries(
  task: string,
  max = 5,
): Promise<string[]> {
  Logger.log('Generating queries', 'Agent');

  const llm = new ChatOpenAI({
    model: process.env.OPENAI_MODEL || 'gpt-4.1',
    temperature: 0.6,
  });

  const now = new Date();
  const prompt = HumanMessagePromptTemplate.fromTemplate(QUERY_PROMPT);

  const result = await prompt
    .pipe(llm.withStructuredOutput(queriesOutputSchema))
    .invoke({
      task,
      max,
      day: formatDate(now, 'cccc'),
      datetime: formatDate(now, 'yyyy-MM-dd HH:mm'),
    });

  return result.queries.slice(0, max).map((q) => stripQuotes(q));
}

function stripQuotes(str: string): string {
  if (str.startsWith('"') && str.endsWith('"')) {
    return str.slice(1, -1);
  }

  if (str.startsWith("'") && str.endsWith("'")) {
    return str.slice(1, -1);
  }

  return str;
}
