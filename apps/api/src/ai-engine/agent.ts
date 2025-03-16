import { Injectable, Logger } from "@nestjs/common";
import { ChatOpenAI } from '@langchain/openai'
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";
import { SystemMessagePromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import { randomUUID } from "crypto";
import { formatDate } from 'date-fns';
import { RecentQueriesTool, SearchWebTool } from "./tools";
import { ItemData } from "./ai-engine.service";
import slugify from "slugify";
import { tavily } from "@tavily/core";

export const ItemGeneratedSchema = z.object({
    name: z.string(),
    source_url: z.string().describe('The URL of item`s official website/repository'),
    description: z.string(),
    category: z.string().optional().describe('The category of the item'),
    tags: z.array(z.string()).optional().describe('The tags of the item'),
})

@Injectable()
export class Agent {
    private readonly logger = new Logger(Agent.name);

    private async createAgent() {
        this.logger.log('Creating agent');
        const llm = this.getLLM();
        const checkpointer = new MemorySaver();
        const tools = [RecentQueriesTool, SearchWebTool];
        const now = new Date();

        const template = SystemMessagePromptTemplate.fromTemplate(
            "You are an expert in building directories websites." +
            "User may ask you about list of known software, tools, services, places etc\n\n." +
            "Your typical tool flow:\n" +
            "1. Call 'recent_queries' tool and use it to generate new, unique search query.\n" +
            "2. Call 'search_web' tool with generated query to get informations from the web.\n" +
            "\n" +
            `Today is {day} the {datetime}.`
        );

        const prompt = await template.format({
            day: formatDate(now, 'cccc'),
            datetime: formatDate(now, 'yyyy-MM-dd HH:mm'),
        });

        const agent = createReactAgent({
            llm,
            checkpointer,
            tools,
            prompt,
            name: 'directory_generator',
            responseFormat: z.object({
                items: z.array(ItemGeneratedSchema),
            }),
        });

        return agent;
    }

    private transformItem(item: ItemData) {
        return {
            slug: slugify(item.name, { lower: true, trim: true }),
            description: item.description,
        };
    }

    public async compare(oldItem: ItemData, newItem: ItemData) {
        this.logger.log('Comparing items: ' + oldItem.slug);
        const prompt = SystemMessagePromptTemplate.fromTemplate(
            "Compare two items' descriptions and return 'true' if new item is more relevant, " +
            "contains more details, it shows more features and is more comprehensive.\n" +
            "If items are similar enough or old item is better, return 'false'\n\n" +
            "old: ```{old}```\n\n" +
            "new: ```{new}```\n\n"
        );

        const llm = this.getLLM().withStructuredOutput(z.object({
            result: z.boolean(),
        }));

        const chain = prompt.pipe(llm);
        const result = await chain.invoke({
            old: JSON.stringify(this.transformItem(oldItem)),
            new: JSON.stringify(this.transformItem(newItem)),
        });

        this.logger.log(`New item for ${newItem.slug} is better: ${result.result}`);
        return result;
    }

    public async generateMarkdown(item: ItemData): Promise<string | undefined> {
        this.logger.log('Generating markdown for:  ' + item.slug);
        const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });
        const response = await tvly.extract([item.source_url], { includeImages: true });
        const crawled = response.results[0];
        if (!crawled) {
            this.logger.warn('Failed to extract content for "' + item.slug + '" from URL: ' + item.source_url);
            return;
        }

        const llm = this.getLLM(0.3); // for generating text it's fine to set higher temperature
        const prompt = SystemMessagePromptTemplate.fromTemplate(
            "Generate markdown for item.\n" +
            "name: {name}\n" +
            "description: {description}\n\n" +
            "Use informations below:\n" +
            "```{crawled}```"
        );

        const chain = prompt.pipe(llm);
        const result = await chain.invoke({
            name: item.name,
            description: item.description,
            crawled: JSON.stringify(crawled),
        });

        return result.content as string;
    }

    public async generateItems(directoryId: string, message: string) {
        this.logger.log('Invoking agent with message: "' + message + '"');
        this.logger.log('directoryId: ' + directoryId);
        const agent = await this.createAgent();
        const result = await agent.invoke(
            { messages: [new HumanMessage(message)], },
            { configurable: { thread_id: randomUUID() }, metadata: { directoryId } }
        );

        const generated = result.structuredResponse;
        this.logger.log(`Generated ${generated.items?.length || 0} items`);
        const items = generated.items || [];
        const mapped = items.map(item => ({ ...item, slug: slugify(item.name, { lower: true, trim: true }) }));
        console.log(mapped);

        return mapped;
    }

    private getLLM(temperature = 0) {
        const llm = new ChatOpenAI({
            model: 'gpt-4o-mini',
            temperature,
        });

        return llm;
    }
}
