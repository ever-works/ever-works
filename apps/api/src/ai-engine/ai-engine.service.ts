import { Injectable } from '@nestjs/common';

interface ItemData {
    name: string;
    description: string;
    source_url: string;
}

const data: Array<ItemData> = [
    {
        name: 'Ever Clock',
        description: 'Open Time Tracking Platform (WIP)',
        source_url: 'https://github.com/ever-co/ever-cloc',
    },
    {
        name: 'ActivityWatch',
        description: 'Free and open-source automated time tracker. Cross-platform, extensible, privacy-focused.',
        source_url: 'https://activitywatch.net/',
    },
    {
        name: 'Timewarrior',
        description: 'Commandline Time Tracking and Reporting.',
        source_url: 'https://github.com/GothenburgBitFactory/timewarrior',

    },
    {
        name: 'Time Tracker',
        description: 'Time Tracker, to be the best time tracker for browsers',
        source_url: 'https://www.wfhg.cc/',
    },
    {
        name: 'TomeTracker',
        description: 'Time tracking app using localstorage.',
        source_url: 'https://github.com/tommerty/TomeTracker',
    },
]

@Injectable()
export class AiEngineService {
    async getItemsList() {
        return data;
    }
}
