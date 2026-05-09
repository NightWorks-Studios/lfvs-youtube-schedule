import { Context } from 'cordis'
import z from 'schemastery'
import {} from '@cordisjs/plugin-timer'
import {} from '@cordisjs/plugin-database'
import { AbstractScheduleService, ScheduleConfig } from 'lfvs-core'

export interface Config extends ScheduleConfig {}

export const Config: z<Config> = z.object({
  enablePolling: z.boolean().default(true).description('是否开启后台自动轮询扫描队列'),
  queueScanInterval: z.number().default(60000).description('视频更新队列的扫描周期 (毫秒)'),
  uploaderScanInterval: z.number().default(600000).description('UP主近期视频的轮询周期 (毫秒)'),
  normalMinInterval: z.number().default(300).description('常规模式：最小抓取间隔 (秒)'),
  normalMaxInterval: z.number().default(21600).description('常规模式：最大抓取间隔 (秒)'),
  normalDecayRate: z.number().step(0.01).default(0.05).description('常规模式：热度指数衰减率'),
  approachingMinInterval: z.number().default(60).description('逼近里程碑模式：最小抓取间隔 (秒)'),
  approachingMaxInterval: z.number().default(3600).description('逼近里程碑模式：最大抓取间隔 (秒)'),
  proximitySensitivity: z.number().default(5).description('逼近模式：距离敏感度系数'),
  jitterPercentage: z.number().step(0.01).default(0.1).description('防止并发的随机抖动百分比 (0~1)'),
  maxVideoProcess: z.number().default(200).description('单次轮询更新的视频最大数量'),
  maxUploaderProcess: z.number().default(300).description('单次轮询扫描的 UP 主最大数量')
})

export class YoutubeScheduleService extends AbstractScheduleService {
  protected platform = 'youtube'
  protected logPrefix = 'youtube-schedule'

  constructor(ctx: Context, config: Config) {
    super(ctx, 'lfvs.youtube.schedule', config)
  }
}

export const apply = (ctx: Context, config: Config) => {
  ctx.plugin(YoutubeScheduleService, config)
}
