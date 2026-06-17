import { Context } from 'cordis';
import z from 'schemastery';
import { AbstractScheduleService, ScheduleConfig } from 'lfvs-core';
export interface Config extends ScheduleConfig {
}
export declare const Config: z<Config>;
export declare class YoutubeScheduleService extends AbstractScheduleService {
    protected platform: string;
    protected logPrefix: string;
    constructor(ctx: Context, config: Config);
}
export declare const apply: (ctx: Context, config: Config) => void;
