import { Injectable, Logger } from "@nestjs/common";
import { ChatOpenAI } from '@langchain/openai'
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage } from "@langchain/core/messages";
import { SystemMessagePromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";
import { randomUUID } from "crypto";
import { formatDate } from 'date-fns';
import { getLastSearches, RecentQueriesTool, SearchWebTool } from "./tools";
import { ItemData } from "./ai-engine.service";
import slugify from "slugify";

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
            `\nToday is {day} the {datetime}.`
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
                items: z.array(z.object({
                    name: z.string(),
                    source_url: z.string().describe('The URL of item`s official website/repository'),
                    description: z.string(),
                    category: z.string().optional().describe('The category of the item'),
                    tags: z.array(z.string()).optional().describe('The tags of the item'),
                })),
            }),
        });

        return agent;
    }

    private transformItem(item: ItemData) {
        return {
            slug: slugify(item.name, { lower: true, trim: true }),
            name: item.name,
            description: item.description,
        };
    }

    public async deduplicate(generated: ItemData[], existing: ItemData[]) {
        const prompt = SystemMessagePromptTemplate.fromTemplate(
            "Compare and return only items from input that doesn't already exist in data.\n\n" +
            "input: ```{input}```\n\n" +
            "data: ```{data}```\n\n"
        );

        const llm = this.getLLM().withStructuredOutput(z.object({
            items: z.array(
                z.object({
                    slug: z.string(),
                    name: z.string(),
                    description: z.string(),
                }))
        }));

        const chain = prompt.pipe(llm)
        const result = await chain.invoke({
            input: JSON.stringify(generated.map(this.transformItem)),
            data: JSON.stringify(existing.map(this.transformItem)),
        });

        return result;
    }

    public async generateItems(directoryId: string, message: string) {
        this.logger.log('Invoking agent with message: "' + message + '"');
        this.logger.log('directoryId: ' + directoryId);
        const agent = await this.createAgent();
        const result = await agent.invoke(
            { messages: [new HumanMessage(message)],  },
            { configurable: { thread_id: randomUUID() }, metadata: { directoryId } }
        );

        const generated = result.structuredResponse;
        this.logger.log(`Generated ${generated.items?.length || 0} items`);
        const items = generated.items || [];
        const mapped = items.map(item => ({ ...item, slug: slugify(item.name, { lower: true, trim: true }) }));
        console.log(mapped);

        return mapped;
    }

    private getLLM() {
        const llm = new ChatOpenAI({
            model: 'gpt-4o-mini',
            temperature: 0,
        });

        return llm;
    }
}
