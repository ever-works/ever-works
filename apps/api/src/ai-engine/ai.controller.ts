import { Body, Controller, NotFoundException, Post } from "@nestjs/common";
import { Agent } from "./agent";
import { DataRepository } from "src/data-generator/data-repository";
import { GithubService } from "src/git/github.service";
import { User } from "src/entities/user.entity";
import { ItemData } from "./ai-engine.service";
import { Directory } from "src/entities/directory.entity";

@Controller()
export class AiController {
    constructor(
        private readonly githubService: GithubService,
        private readonly agent: Agent
    ) {}

    @Post('ai')
    async invoke(
        @Body('slug') slug: string,
        @Body() body: { message: string }
    ) {
        const directory = await Directory.findMock(slug);
        if (!directory) {
            throw new NotFoundException('Directory not found');
        }

        const user = await User.sessionMock();
        const dirRepo = await this.githubService.clone(directory.owner, directory.getDataRepo(), user.getGitToken());
        const data = await DataRepository.create(dirRepo);
        const response = await this.agent.generateItems(body.message) as ItemData[];
        const existing = await data.getItems();
        console.log('Generated items:', response);
        const dedup = await this.agent.deduplicate(response, existing)

        return dedup;
    }
}
