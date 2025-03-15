import { Body, Controller, NotFoundException, Post } from "@nestjs/common";
import { Agent } from "./agent";
import { DataRepository } from "../data-generator/data-repository";
import { GithubService } from "../git/github.service";
import { User } from "../entities/user.entity";
import { ItemData } from "./ai-engine.service";
import { Directory } from "../entities/directory.entity";

@Controller()
export class AiController {
    constructor(
        private readonly githubService: GithubService,
        private readonly agent: Agent
    ) {}

    @Post('ai')
    async invoke(
        @Body() body: { slug: string, message: string }
    ) {
        const directory = await Directory.findMock(body.slug);
        if (!directory) {
            throw new NotFoundException('Directory not found');
        }

        const user = await User.sessionMock();
        const dirRepo = await this.githubService.clone(directory.owner, directory.getDataRepo(), user.getGitToken());
        const data = await DataRepository.create(dirRepo);
        const existing = await data.getItems();
        const response = await this.agent.generateItems(directory.id, body.message) as ItemData[];

        const returned = [];
        for (const item of response) {
            const existingItem = existing.find(i => i.slug === item.slug);
            if (!existingItem) {
                returned.push(item);
            } else {
                const { result } = await this.agent.compare(existingItem, item);
                if (result) {
                    returned.push(item);
                }
            }
        }

        return returned;
    }

    @Post('ai/markdown')
    async markdown() {
        const item: ItemData = {
            name: 'Hubstaff',
            source_url: 'https://hubstaff.com',
            description: 'Time tracking software with screenshots, activity levels, and in-depth reports.',
            category: 'Time Tracking',
            tags: ['time tracking', 'productivity'],
        }

        const markdown = await this.agent.generateMarkdown(item);

        return markdown;
    }
}
