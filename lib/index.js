var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
import { Service } from "cordis";
import z from "schemastery";
import { DETAILED_MILESTONES } from "lfvs-core";
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
var YoutubeScheduleService = class extends Service {
  constructor(ctx, config) {
    super(ctx, "lfvs.youtube.schedule");
    this.config = config;
    Promise.resolve().then(() => this.start());
  }
  config;
  static {
    __name(this, "YoutubeScheduleService");
  }
  static inject = ["database", "timer", "lfvs.core", "logger"];
  platform = "youtube";
  isUpdatingVideos = false;
  isScanningUploaders = false;
  videoIntervalId;
  uploaderIntervalId;
  async start() {
    if (!this.config.enablePolling) return;
    this.ctx.on("lfvs/adapter-online", (platform) => {
      if (platform === this.platform) {
        this.startPolling();
      }
    });
    this.ctx.on("lfvs/adapter-offline", (platform) => {
      if (platform === this.platform) {
        this.stopPolling();
      }
    });
    if (this.ctx.get("lfvs.core").getAdapter(this.platform)) {
      this.startPolling();
    }
  }
  startPolling() {
    if (this.videoIntervalId) return;
    this.videoIntervalId = this.ctx.timer.setInterval(() => this.updateVideos(), this.config.queueScanInterval);
    this.uploaderIntervalId = this.ctx.timer.setInterval(() => this.scanUploaders(), this.config.uploaderScanInterval);
    this.ctx.setTimeout(() => {
      this.updateVideos();
      this.scanUploaders();
    }, 1500);
  }
  stopPolling() {
    if (this.videoIntervalId) this.videoIntervalId();
    if (this.uploaderIntervalId) this.uploaderIntervalId();
    this.videoIntervalId = void 0;
    this.uploaderIntervalId = void 0;
  }
  calculateHybridInterval(viewDelta, timeDeltaInMinutes, distanceToNextMilestone) {
    const isApproaching = distanceToNextMilestone !== null;
    const MIN_INTERVAL_SECONDS = isApproaching ? this.config.approachingMinInterval : this.config.normalMinInterval;
    const MAX_INTERVAL_SECONDS = isApproaching ? this.config.approachingMaxInterval : this.config.normalMaxInterval;
    const DECAY_RATE = this.config.normalDecayRate;
    const JITTER_PERCENTAGE = this.config.jitterPercentage;
    if (timeDeltaInMinutes <= 0) return MAX_INTERVAL_SECONDS;
    const viewsPerMinute = viewDelta / timeDeltaInMinutes;
    let baseInterval = MIN_INTERVAL_SECONDS + (MAX_INTERVAL_SECONDS - MIN_INTERVAL_SECONDS) * Math.exp(-DECAY_RATE * viewsPerMinute);
    if (isApproaching && distanceToNextMilestone > 0) {
      const proximityFactor = 1 - Math.exp(-this.config.proximitySensitivity * (distanceToNextMilestone / 1e5));
      const proximityAdjustedInterval = MIN_INTERVAL_SECONDS + (baseInterval - MIN_INTERVAL_SECONDS) * proximityFactor;
      baseInterval = proximityAdjustedInterval;
    }
    const jitter = (Math.random() * 2 - 1) * baseInterval * JITTER_PERCENTAGE;
    const finalInterval = baseInterval + jitter;
    return Math.max(MIN_INTERVAL_SECONDS, Math.min(MAX_INTERVAL_SECONDS, finalInterval));
  }
  async updateVideos() {
    if (this.isUpdatingVideos) return;
    this.isUpdatingVideos = true;
    const roundStart = Date.now();
    const windowMs = this.config.queueScanInterval;
    const MAX_PROCESS = this.config.maxVideoProcess;
    const MIN_INTERVAL_MS = windowMs / MAX_PROCESS;
    let totalSuccess = 0;
    let totalFailure = 0;
    let totalProcessed = 0;
    try {
      const now = /* @__PURE__ */ new Date();
      const dbStart = Date.now();
      const videosToUpdate = await this.ctx.database.get("lfvs_video", {
        isSubscribed: true,
        status: "active",
        platform: this.platform,
        nextUpdateAt: { $lte: now }
      }, { limit: MAX_PROCESS, sort: { nextUpdateAt: "asc" } });
      const dbCostMs = Date.now() - dbStart;
      if (videosToUpdate.length === 0) return;
      this.ctx.emit("lfvs/schedule-round-start", this.platform, "video", dbCostMs, videosToUpdate.length);
      const intervalMs = Math.max(MIN_INTERVAL_MS, windowMs / videosToUpdate.length);
      totalProcessed = videosToUpdate.length;
      await Promise.all(videosToUpdate.map(async (video, index) => {
        await new Promise((resolve) => setTimeout(resolve, index * intervalMs));
        const result = await this.processSingleVideo(video);
        if (result) totalSuccess++;
        else totalFailure++;
      }));
    } finally {
      this.isUpdatingVideos = false;
      if (totalProcessed > 0) {
        this.ctx.emit("lfvs/schedule-round-end", this.platform, "video", totalProcessed, totalSuccess, totalFailure, Date.now() - roundStart);
      }
    }
  }
  async processSingleVideo(video) {
    const adapter = this.ctx.get("lfvs.core").getAdapter(this.platform);
    if (!adapter) return false;
    const now = /* @__PURE__ */ new Date();
    const start = Date.now();
    try {
      const res = await adapter.getVideoInfoAndStats(video.videoId);
      const costMs = Date.now() - start;
      if (res.status === "not_found") {
        await this.ctx.database.set("lfvs_video", { id: video.id }, {
          status: "deleted",
          isSubscribed: false
        });
        this.ctx.emit("lfvs/resource-deleted", this.platform, "video", video.videoId);
        this.ctx.emit("lfvs/video-updated", this.platform, video.videoId, "not_found", costMs);
        return true;
      }
      if (res.status === "error") {
        const retryDelaySeconds = 20 * 60;
        await this.ctx.database.set("lfvs_video", { id: video.id }, {
          nextUpdateAt: new Date(Date.now() + retryDelaySeconds * 1e3)
        });
        this.ctx.emit("lfvs/video-updated", this.platform, video.videoId, "error", costMs);
        return false;
      }
      const { stat: newStat, info } = res.data;
      let videoUploaderId = video.uploaderId;
      let needsMetadataUpdate = false;
      if (info && (!videoUploaderId || !video.title || !video.pic || !video.pubdate)) {
        if (!videoUploaderId && info.uploader) {
          const upCheck = await this.ctx.database.get("lfvs_uploader", {
            uid: info.uploader.uid,
            platform: this.platform
          }, ["id"]);
          if (upCheck.length > 0) {
            videoUploaderId = upCheck[0].id;
          } else {
            const createdUp = await this.ctx.database.create("lfvs_uploader", {
              uid: info.uploader.uid,
              name: info.uploader.name,
              platform: this.platform,
              isSubscribed: false,
              status: "active"
            });
            videoUploaderId = createdUp.id;
          }
        }
        needsMetadataUpdate = true;
      }
      const latestStats = await this.ctx.database.get("lfvs_video_stat", { videoId: video.id }, {
        sort: { timestamp: "desc" },
        limit: 1
      });
      const latestStat = latestStats[0];
      let dataHasChanged = true;
      if (latestStat) {
        if (newStat.view === latestStat.view && newStat.danmaku === latestStat.danmaku && newStat.reply === latestStat.reply && newStat.favorite === latestStat.favorite && newStat.coin === latestStat.coin && newStat.share === latestStat.share && newStat.like === latestStat.like) {
          dataHasChanged = false;
        }
      }
      const milestonesToCreate = [];
      if (dataHasChanged && latestStat) {
        const milestonesCrossed = DETAILED_MILESTONES.filter((m) => latestStat.view < m && (newStat.view || 0) >= m);
        if (milestonesCrossed.length > 0) {
          const fullStat = {
            id: 0,
            videoId: video.id,
            timestamp: now,
            view: newStat.view || 0,
            danmaku: newStat.danmaku || 0,
            reply: newStat.reply || 0,
            favorite: newStat.favorite || 0,
            coin: newStat.coin || 0,
            share: newStat.share || 0,
            like: newStat.like || 0
          };
          for (const milestone of milestonesCrossed) {
            milestonesToCreate.push({ videoId: video.id, milestoneView: milestone, achievedAt: now });
            this.ctx.emit("lfvs/milestone-reached", video, milestone, fullStat);
          }
        }
      }
      let newInterval;
      let distance = null;
      const nextMilestone = DETAILED_MILESTONES.find((m) => m > (newStat.view || 0));
      if (nextMilestone && (newStat.view || 0) >= nextMilestone * 0.9) {
        distance = nextMilestone - (newStat.view || 0);
      }
      if (latestStat) {
        const viewDelta = dataHasChanged ? (newStat.view || 0) - latestStat.view : 0;
        const timeDelta = (now.getTime() - latestStat.timestamp.getTime()) / (1e3 * 60);
        newInterval = this.calculateHybridInterval(viewDelta, timeDelta, distance);
      } else {
        newInterval = 300;
        this.ctx.emit("lfvs/new-video-found", video);
      }
      const nextUpdateAt = new Date(Date.now() + newInterval * 1e3);
      if (dataHasChanged) {
        await this.ctx.database.create("lfvs_video_stat", {
          videoId: video.id,
          timestamp: now,
          view: newStat.view || 0,
          danmaku: newStat.danmaku || 0,
          reply: newStat.reply || 0,
          favorite: newStat.favorite || 0,
          coin: newStat.coin || 0,
          share: newStat.share || 0,
          like: newStat.like || 0
        });
        if (milestonesToCreate.length > 0) {
          await this.ctx.database.upsert("lfvs_milestone", milestonesToCreate);
        }
      } else if (latestStat) {
        await this.ctx.database.set("lfvs_video_stat", { id: latestStat.id }, { timestamp: now });
      }
      const updatePayload = {
        updateInterval: Math.round(newInterval),
        nextUpdateAt,
        title: info.title,
        pic: info.pic,
        currentView: newStat.view || 0
      };
      if (needsMetadataUpdate) {
        if (videoUploaderId) updatePayload.uploaderId = videoUploaderId;
        if (info.pubdate) updatePayload.pubdate = info.pubdate;
      }
      await this.ctx.database.set("lfvs_video", { id: video.id }, updatePayload);
      const fullNewStat = { id: 0, videoId: video.id, timestamp: now, view: newStat.view || 0, danmaku: newStat.danmaku || 0, reply: newStat.reply || 0, favorite: newStat.favorite || 0, coin: newStat.coin || 0, share: newStat.share || 0, like: newStat.like || 0 };
      this.ctx.emit("lfvs/video-updated", this.platform, video.videoId, "success", costMs, latestStat, fullNewStat);
      return true;
    } catch (error) {
      return false;
    }
  }
  async scanUploaders() {
    if (this.isScanningUploaders) return;
    this.isScanningUploaders = true;
    const roundStart = Date.now();
    const adapter = this.ctx.get("lfvs.core").getAdapter(this.platform);
    if (!adapter) {
      this.isScanningUploaders = false;
      return;
    }
    try {
      const dbStart = Date.now();
      const uploaders = await this.ctx.database.get("lfvs_uploader", {
        isSubscribed: true,
        status: "active",
        platform: this.platform
      }, { limit: this.config.maxUploaderProcess, sort: { id: "asc" } });
      const dbCostMs = Date.now() - dbStart;
      if (uploaders.length > 0) {
        this.ctx.emit("lfvs/schedule-round-start", this.platform, "uploader", dbCostMs, uploaders.length);
      }
      let totalSuccess = 0;
      let totalFailure = 0;
      for (const uploader of uploaders) {
        const res = await adapter.getUploaderRecentVideos(uploader.uid);
        if (res.status === "not_found") {
          await this.ctx.database.set("lfvs_uploader", { id: uploader.id }, { status: "deleted", isSubscribed: false });
          this.ctx.emit("lfvs/resource-deleted", this.platform, "uploader", uploader.uid);
          totalSuccess++;
          continue;
        } else if (res.status === "error") {
          totalFailure++;
          continue;
        }
        totalSuccess++;
        const recentVideos = res.data;
        if (recentVideos.length === 0) continue;
        const videoIds = recentVideos.map((v) => v.videoId);
        const existingVideosDb = await this.ctx.database.get("lfvs_video", {
          videoId: videoIds,
          platform: this.platform
        }, ["videoId"]);
        const existingVideoIds = new Set(existingVideosDb.map((v) => v.videoId));
        let uploaderNameUpdated = false;
        const now = /* @__PURE__ */ new Date();
        for (const vInfo of recentVideos) {
          if (!existingVideoIds.has(vInfo.videoId)) {
            if (!uploaderNameUpdated && uploader.name !== vInfo.uploader.name) {
              await this.ctx.database.set("lfvs_uploader", { id: uploader.id }, { name: vInfo.uploader.name });
              uploaderNameUpdated = true;
            }
            const newVideo = await this.ctx.database.create("lfvs_video", {
              videoId: vInfo.videoId,
              platform: this.platform,
              title: vInfo.title,
              pic: vInfo.pic,
              pubdate: vInfo.pubdate,
              uploaderId: uploader.id,
              isSubscribed: true,
              nextUpdateAt: now,
              updateInterval: 300,
              currentView: 0,
              status: "active"
            });
            existingVideoIds.add(vInfo.videoId);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (uploaders.length > 0) {
        this.ctx.emit("lfvs/schedule-round-end", this.platform, "uploader", uploaders.length, totalSuccess, totalFailure, Date.now() - roundStart);
      }
    } finally {
      this.isScanningUploaders = false;
    }
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
