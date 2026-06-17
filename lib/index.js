var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
import z from "schemastery";
import { AbstractScheduleService } from "lfvs-core";
var Config = z.object({
  enablePolling: z.boolean().default(true).description("是否开启后台自动轮询扫描队列"),
  queueScanInterval: z.number().default(6e4).description("视频更新队列的扫描周期 (毫秒)"),
  uploaderScanInterval: z.number().default(6e5).description("UP主近期视频的轮询周期 (毫秒)"),
  normalMinInterval: z.number().default(300).description("常规模式：最小抓取间隔 (秒)"),
  normalMaxInterval: z.number().default(21600).description("常规模式：最大抓取间隔 (秒)"),
  normalDecayRate: z.number().step(0.01).default(0.05).description("常规模式：热度指数衰减率"),
  approachingMinInterval: z.number().default(60).description("逼近里程碑模式：最小抓取间隔 (秒)"),
  approachingMaxInterval: z.number().default(3600).description("逼近里程碑模式：最大抓取间隔 (秒)"),
  proximitySensitivity: z.number().default(5).description("逼近模式：距离敏感度系数"),
  jitterPercentage: z.number().step(0.01).default(0.1).description("防止并发的随机抖动百分比 (0~1)"),
  maxVideoProcess: z.number().default(200).description("单次轮询更新的视频最大数量"),
  maxUploaderProcess: z.number().default(300).description("单次轮询扫描的 UP 主最大数量")
});
var YoutubeScheduleService = class extends AbstractScheduleService {
  static {
    __name(this, "YoutubeScheduleService");
  }
  platform = "youtube";
  logPrefix = "youtube-schedule";
  constructor(ctx, config) {
    super(ctx, "lfvs.youtube.schedule", config);
    ctx.inject(["webui"], (ctx2) => {
      ctx2.webui.addEntry({
        modulePath: "lfvs-youtube-schedule",
        baseUrl: import.meta.url,
        source: "../client/index.ts",
        manifest: "../dist/manifest.json"
      }, {
        "youtube-schedule/status": /* @__PURE__ */ __name(() => {
          const stats = this.lastRoundStats;
          return {
            ...stats,
            load: stats.maxVideoProcess > 0 ? stats.totalProcessed / stats.maxVideoProcess : 0
          };
        }, "youtube-schedule/status")
      });
    });
  }
};
var apply = /* @__PURE__ */ __name((ctx, config) => {
  ctx.plugin(YoutubeScheduleService, config);
}, "apply");
export {
  Config,
  YoutubeScheduleService,
  apply
};
