import { Injectable } from '@nestjs/common';

export interface ItemData {
    name: string;
    description: string;
    source_url: string;
    category: string;
}

const data: Array<ItemData> = [
    {
        name: 'Ever Clock',
        description: 'Open Time Tracking Platform (WIP)',
        source_url: 'https://github.com/ever-co/ever-cloc',
        category: 'Open Source'
    },
    {
        name: 'ActivityWatch',
        description: 'Free and open-source automated time tracker. Cross-platform, extensible, privacy-focused.',
        source_url: 'https://activitywatch.net',
        category: 'Open Source'
    },
    {
        name: 'Timewarrior',
        description: 'Commandline Time Tracking and Reporting.',
        source_url: 'https://github.com/GothenburgBitFactory/timewarrior',
        category: 'Open Source'

    },
    {
        name: 'Time Tracker',
        description: 'Time Tracker, to be the best time tracker for browsers',
        source_url: 'https://www.wfhg.cc',
        category: 'Open Source'
    },
    {
        name: 'TomeTracker',
        description: 'Time tracking app using localstorage.',
        source_url: 'https://github.com/tommerty/TomeTracker',
        category: 'Open Source'
    },
    {
        name: 'HubStaff',
        description: 'One app to automate time-tracking processes, workforce management, and productivity metrics.',
        source_url: 'https://hubstaff.com',
        category: 'Commercial',
    },
    {
        name: 'TimeOS',
        description: 'AI productivity companion that captures and summarizes your day, organizes all relevant information within the right tool, and proactively surfaces the knowledge you need, when you need it.',
        source_url: 'https://www.timeos.ai',
        category: 'Commercial',
    },
    {
        name: 'Invobook',
        description: 'Self-hosted app for Time Tracking, Invoice Generation, Project & Client Management, built with Laravel & Filament.',
        source_url: 'https://github.com/Hasnayeen/invobook',
        category: 'Open Source',
    },
    {
        name: 'Titra',
        description: 'Modern open source project time tracking for freelancers and small teams.',
        source_url: 'https://titra.io/en',
        category: 'Open Source',
    },
    {
        name: 'Selfspy',
        description: 'Log everything you do on the computer, for statistics, future reference and all-around fun!',
        source_url: 'https://github.com/selfspy/selfspy',
        category: 'Open Source',
    }
]

@Injectable()
export class AiEngineService {
    async getItemsList() {
        return data;
    }
}
