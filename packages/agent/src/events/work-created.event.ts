import { Work } from '@src/entities';
import { BaseEvent } from './base';

export class WorkCreatedEvent extends BaseEvent {
    static EVENT_NAME = 'work.created';

    constructor(public readonly work: Work) {
        super();
    }
}
