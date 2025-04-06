import { HumanMessagePromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";
import { Logger } from "@nestjs/common";
import { formatDate } from "date-fns";
import { z } from "zod";

const QUERY_PROMPT = `
You are directory website builder and your task is to generate search queries to find relevant information on the web, based on given task:
<content>
{task}
</content>

Max {max} queries are expected!
Today is {day} the {datetime}.
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
export async function generateQueries(task: string, max = 5): Promise<string[]> {
    Logger.log('Generating queries', 'Agent');

    const llm = new ChatOpenAI({
        model: 'gpt-4o',
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

    return result.queries
        .slice(0, max)
        .map(q => stripQuotes(q));
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
