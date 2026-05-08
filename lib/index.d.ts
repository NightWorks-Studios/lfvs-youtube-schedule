import { Context, Service } from 'cordis';
import z from 'schemastery';
export interface Config {
    enablePolling: boolean;
    queueScanInterval: number;
    uploaderScanInterval: number;
    normalMinInterval: number;
    normalMaxInterval: number;
    normalDecayRate: number;
    approachingMinInterval: number;
    approachingMaxInterval: number;
    proximitySensitivity: number;
    jitterPercentage: number;
}
export declare const Config: z<Config>;
export declare class YoutubeScheduleService extends Service {
    config: Config;
    static inject: string[];
    platform: string;
    private isUpdatingVideos;
    private isScanningUploaders;
    private videoIntervalId?;
    private uploaderIntervalId?;
    constructor(ctx: Context, config: Config);
    protected start(): Promise<void>;
    private startPolling;
    private stopPolling;
    private calculateHybridInterval;
    private updateVideos;
    private processSingleVideo;
    private scanUploaders;
}
export declare const apply: (ctx: Context, config: Config) => void;
