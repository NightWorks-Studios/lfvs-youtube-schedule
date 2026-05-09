import { Context, Service } from 'cordis'
import z from 'schemastery'
import {} from '@cordisjs/plugin-timer'
import {} from '@cordisjs/plugin-database'
import { DETAILED_MILESTONES, LfvsVideo, LfvsVideoStat } from 'lfvs-core'

export interface Config {
  enablePolling: boolean
  queueScanInterval: number
  uploaderScanInterval: number
  normalMinInterval: number
  normalMaxInterval: number
  normalDecayRate: number
  approachingMinInterval: number
  approachingMaxInterval: number
  proximitySensitivity: number
  jitterPercentage: number
  maxVideoProcess: number
  maxUploaderProcess: number
}

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

export class YoutubeScheduleService extends Service {
  static inject = ['database', 'timer', 'lfvs.core', 'logger']
  public platform = 'youtube'

  private isUpdatingVideos = false
  private isScanningUploaders = false
  private videoIntervalId?: () => void
  private uploaderIntervalId?: () => void

  private abortController: AbortController

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'lfvs.youtube.schedule')
    this.abortController = new AbortController()

    ctx.effect(() => {
      return () => {
        this.abortController.abort()
      }
    })
    Promise.resolve().then(() => this.start().catch(e => {
      this.ctx.emit('lfvs/log', 'youtube-schedule', 'error', `启动失败: ${e.message}`)
    }))
  }

  protected async start() {
    if (!this.config.enablePolling) return

    this.ctx.on('lfvs/adapter-online', (platform) => {
      if (platform === this.platform) {
        this.startPolling()
      }
    })

    this.ctx.on('lfvs/adapter-offline', (platform) => {
      if (platform === this.platform) {
        this.stopPolling()
      }
    })

    if (this.ctx.get('lfvs.core').getAdapter(this.platform)) {
      this.startPolling()
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve, reject) => {
      if (this.abortController.signal.aborted) {
        return reject(new Error('Context disposed'))
      }

      const timer = setTimeout(() => {
        this.abortController.signal.removeEventListener('abort', abortHandler)
        resolve()
      }, ms)

      const abortHandler = () => {
        clearTimeout(timer)
        reject(new Error('Context disposed'))
      }

      this.abortController.signal.addEventListener('abort', abortHandler)
    })
  }

  private startPolling() {
    if (this.videoIntervalId) return
    this.videoIntervalId = this.ctx.timer.setInterval(() => this.updateVideos(), this.config.queueScanInterval)
    this.uploaderIntervalId = this.ctx.timer.setInterval(() => this.scanUploaders(), this.config.uploaderScanInterval)
    
    this.ctx.setTimeout(() => {
      this.updateVideos()
      this.scanUploaders()
    }, 1500)
  }

  private stopPolling() {
    if (this.videoIntervalId) this.videoIntervalId()
    if (this.uploaderIntervalId) this.uploaderIntervalId()
    this.videoIntervalId = undefined
    this.uploaderIntervalId = undefined
  }

  private calculateHybridInterval(viewDelta: number, timeDeltaInMinutes: number, distanceToNextMilestone: number | null): number {
    const isApproaching = distanceToNextMilestone !== null
    const MIN_INTERVAL_SECONDS = isApproaching ? this.config.approachingMinInterval : this.config.normalMinInterval
    const MAX_INTERVAL_SECONDS = isApproaching ? this.config.approachingMaxInterval : this.config.normalMaxInterval
    const DECAY_RATE = this.config.normalDecayRate
    const JITTER_PERCENTAGE = this.config.jitterPercentage

    if (timeDeltaInMinutes <= 0) return MAX_INTERVAL_SECONDS
    
    const viewsPerMinute = viewDelta / timeDeltaInMinutes
    let baseInterval = MIN_INTERVAL_SECONDS + (MAX_INTERVAL_SECONDS - MIN_INTERVAL_SECONDS) * Math.exp(-DECAY_RATE * viewsPerMinute)

    if (isApproaching && distanceToNextMilestone > 0) {
      const proximityFactor = 1 - Math.exp(-this.config.proximitySensitivity * (distanceToNextMilestone / 100000))
      const proximityAdjustedInterval = MIN_INTERVAL_SECONDS + (baseInterval - MIN_INTERVAL_SECONDS) * proximityFactor
      baseInterval = proximityAdjustedInterval
    }

    const jitter = (Math.random() * 2 - 1) * baseInterval * JITTER_PERCENTAGE
    const finalInterval = baseInterval + jitter
    return Math.max(MIN_INTERVAL_SECONDS, Math.min(MAX_INTERVAL_SECONDS, finalInterval))
  }

  private async updateVideos() {
    if (this.isUpdatingVideos) return
    this.isUpdatingVideos = true

    const roundStart = Date.now()
    const windowMs = this.config.queueScanInterval
    const MAX_PROCESS = this.config.maxVideoProcess
    const MIN_INTERVAL_MS = windowMs / MAX_PROCESS

    let totalSuccess = 0
    let totalFailure = 0
    let totalProcessed = 0

    try {
      const now = new Date()

      const dbStart = Date.now()
      const videosToUpdate = await this.ctx.database.get('lfvs_video', {
        isSubscribed: true,
        status: 'active',
        platform: this.platform,
        nextUpdateAt: { $lte: now }
      }, { limit: MAX_PROCESS, sort: { nextUpdateAt: 'asc' } })
      const dbCostMs = Date.now() - dbStart

      if (videosToUpdate.length === 0) return

      this.ctx.emit('lfvs/schedule-round-start', this.platform, 'video', dbCostMs, videosToUpdate.length)

      const intervalMs = Math.max(MIN_INTERVAL_MS, windowMs / videosToUpdate.length)
      totalProcessed = videosToUpdate.length

      for (const video of videosToUpdate) {
        if (this.abortController.signal.aborted) break
        try {
          const result = await this.processSingleVideo(video)
          if (result) totalSuccess++
          else totalFailure++
        } catch (error: any) {
          if (error.message === 'Context disposed') break
          totalFailure++
          this.ctx.emit('lfvs/log', 'youtube-schedule', 'error', `updateVideos 异常: ${error.message}`)
        }
        // 串行间隔，避免 API 过载
        if (!this.abortController.signal.aborted) {
          try { await this.sleep(intervalMs) } catch { break }
        }
      }

    } finally {
      this.isUpdatingVideos = false
      if (totalProcessed > 0 && !this.abortController.signal.aborted) {
        this.ctx.emit('lfvs/schedule-round-end', this.platform, 'video', totalProcessed, totalSuccess, totalFailure, Date.now() - roundStart)
      }
    }
  }

  private async processSingleVideo(video: LfvsVideo): Promise<boolean> {
    const adapter = this.ctx.get('lfvs.core').getAdapter(this.platform)
    if (!adapter) return false
    
    const now = new Date()
    const start = Date.now()
    
    try {
      const res = await adapter.getVideoInfoAndStats(video.videoId)
      const costMs = Date.now() - start
      
      if (res.status === 'not_found') {
        await this.ctx.database.set('lfvs_video', { id: video.id }, {
          status: 'deleted',
          isSubscribed: false
        })
        this.ctx.emit('lfvs/resource-deleted', this.platform, 'video', video.videoId)
        this.ctx.emit('lfvs/video-updated', this.platform, video.videoId, 'not_found', costMs)
        return true
      }

      if (res.status === 'error') {
        const retryDelaySeconds = 20 * 60
        await this.ctx.database.set('lfvs_video', { id: video.id }, {
          nextUpdateAt: new Date(Date.now() + retryDelaySeconds * 1000)
        })
        this.ctx.emit('lfvs/video-updated', this.platform, video.videoId, 'error', costMs)
        return false
      }

      const { stat: newStat, info } = res.data
      
      // Auto-Heal Mechanism
      let videoUploaderId = video.uploaderId
      let needsMetadataUpdate = false
      if (info && (!videoUploaderId || !video.title || !video.pic || !video.pubdate)) {
        if (!videoUploaderId && info.uploader) {
          const upCheck = await this.ctx.database.get('lfvs_uploader', { 
            uid: info.uploader.uid, 
            platform: this.platform 
          }, ['id'])
          
          if (upCheck.length > 0) {
            videoUploaderId = upCheck[0].id
          } else {
            const createdUp = await this.ctx.database.create('lfvs_uploader', {
              uid: info.uploader.uid,
              name: info.uploader.name,
              platform: this.platform,
              isSubscribed: false,
              status: 'active'
            })
            videoUploaderId = createdUp.id
          }
        }
        needsMetadataUpdate = true
      }
      
      const latestStats = await this.ctx.database.get('lfvs_video_stat', { videoId: video.id }, {
        sort: { timestamp: 'desc' },
        limit: 1
      })
      const latestStat = latestStats[0]

      let dataHasChanged = true
      if (latestStat) {
        const n = (v: number | null | undefined) => v ?? 0
        if (
          n(newStat.view) === latestStat.view && n(newStat.danmaku) === latestStat.danmaku &&
          n(newStat.reply) === latestStat.reply && n(newStat.favorite) === latestStat.favorite &&
          n(newStat.coin) === latestStat.coin && n(newStat.share) === latestStat.share &&
          n(newStat.like) === latestStat.like
        ) {
          dataHasChanged = false
        }
      }

      const milestonesToCreate: any[] = []

      if (dataHasChanged && latestStat) {
        const milestonesCrossed = DETAILED_MILESTONES.filter(m => latestStat.view < m && (newStat.view || 0) >= m)
        if (milestonesCrossed.length > 0) {
          const fullStat: LfvsVideoStat = { 
            id: 0, videoId: video.id, timestamp: now, 
            view: newStat.view || 0,
            danmaku: newStat.danmaku || 0,
            reply: newStat.reply || 0,
            favorite: newStat.favorite || 0,
            coin: newStat.coin || 0,
            share: newStat.share || 0,
            like: newStat.like || 0
          }
          for (const milestone of milestonesCrossed) {
            milestonesToCreate.push({ videoId: video.id, milestoneView: milestone, achievedAt: now })
            this.ctx.emit('lfvs/milestone-reached', video as LfvsVideo, milestone, fullStat)
          }
        }
      }

      let newInterval: number
      let distance: number | null = null
      const nextMilestone = DETAILED_MILESTONES.find(m => m > (newStat.view || 0))
      
      if (nextMilestone && (newStat.view || 0) >= nextMilestone * 0.9) {
        distance = nextMilestone - (newStat.view || 0)
      }

      if (latestStat) {
        const viewDelta = dataHasChanged ? (newStat.view || 0) - latestStat.view : 0
        const timeDelta = (now.getTime() - latestStat.timestamp.getTime()) / (1000 * 60)
        newInterval = this.calculateHybridInterval(viewDelta, timeDelta, distance)
      } else {
        newInterval = 300 // 第一次扫描到后下一次扫描时间固定为5分钟
        this.ctx.emit('lfvs/new-video-found', video as LfvsVideo)
      }

      const nextUpdateAt = new Date(Date.now() + newInterval * 1000)

      if (dataHasChanged) {
        await this.ctx.database.create('lfvs_video_stat', { 
          videoId: video.id, timestamp: now,
          view: newStat.view || 0,
          danmaku: newStat.danmaku || 0,
          reply: newStat.reply || 0,
          favorite: newStat.favorite || 0,
          coin: newStat.coin || 0,
          share: newStat.share || 0,
          like: newStat.like || 0
        })
        if (milestonesToCreate.length > 0) {
          await this.ctx.database.upsert('lfvs_milestone', milestonesToCreate)
        }
      } else if (latestStat) {
        await this.ctx.database.set('lfvs_video_stat', { id: latestStat.id }, { timestamp: now })
      }

      const updatePayload: any = {
        updateInterval: Math.round(newInterval),
        nextUpdateAt: nextUpdateAt,
        title: info.title,
        pic: info.pic,
        currentView: newStat.view || 0
      }
      
      if (needsMetadataUpdate) {
        if (videoUploaderId) updatePayload.uploaderId = videoUploaderId
        if (info.pubdate) updatePayload.pubdate = info.pubdate
      }

      await this.ctx.database.set('lfvs_video', { id: video.id }, updatePayload)

      const fullNewStat: LfvsVideoStat = { id: 0, videoId: video.id, timestamp: now, view: newStat.view||0, danmaku: newStat.danmaku||0, reply: newStat.reply||0, favorite: newStat.favorite||0, coin: newStat.coin||0, share: newStat.share||0, like: newStat.like||0 }
      this.ctx.emit('lfvs/video-updated', this.platform, video.videoId, 'success', costMs, latestStat as any, fullNewStat)
      return true
    } catch (error: any) {
      this.ctx.emit('lfvs/log', 'youtube-schedule', 'error',
        `processSingleVideo 异常 [${video.videoId}]: ${error.message}`, error.stack)
      return false
    }
  }

  private async scanUploaders() {
    if (this.isScanningUploaders) return
    this.isScanningUploaders = true

    const roundStart = Date.now()
    const adapter = this.ctx.get('lfvs.core').getAdapter(this.platform)
    if (!adapter) {
      this.isScanningUploaders = false
      return
    }

    try {
      const dbStart = Date.now()
      const uploaders = await this.ctx.database.get('lfvs_uploader', {
        isSubscribed: true,
        status: 'active',
        platform: this.platform
      }, { limit: this.config.maxUploaderProcess, sort: { id: 'asc' } })
      const dbCostMs = Date.now() - dbStart

      if (uploaders.length > 0) {
        this.ctx.emit('lfvs/schedule-round-start', this.platform, 'uploader', dbCostMs, uploaders.length)
      }

      let totalSuccess = 0
      let totalFailure = 0

      for (const uploader of uploaders) {
        if (this.abortController.signal.aborted) break
        const res = await adapter.getUploaderRecentVideos(uploader.uid)
        
        if (res.status === 'not_found') {
          await this.ctx.database.set('lfvs_uploader', { id: uploader.id }, { status: 'deleted', isSubscribed: false })
          this.ctx.emit('lfvs/resource-deleted', this.platform, 'uploader', uploader.uid)
          totalSuccess++
          continue
        } else if (res.status === 'error') {
          totalFailure++
          continue
        }

        totalSuccess++
        const recentVideos = res.data
        if (recentVideos.length === 0) continue

        // 优化: 一次性查询当前 UP 主在这个平台下的所有已有视频，避免在循环中重复查询
        const videoIds = recentVideos.map(v => v.videoId)
        const existingVideosDb = await this.ctx.database.get('lfvs_video', { 
          videoId: videoIds, 
          platform: this.platform 
        }, ['videoId'])
        const existingVideoIds = new Set(existingVideosDb.map(v => v.videoId))

        let uploaderNameUpdated = false
        const now = new Date()

        for (const vInfo of recentVideos) {
          if (!existingVideoIds.has(vInfo.videoId)) {
            // 只在发现新视频且未更新过名字时，更新一次 UP 主名字
            if (!uploaderNameUpdated && uploader.name !== vInfo.uploader.name) {
              await this.ctx.database.set('lfvs_uploader', { id: uploader.id }, { name: vInfo.uploader.name })
              uploaderNameUpdated = true
            }
            
            const newVideo = await this.ctx.database.create('lfvs_video', {
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
              status: 'active'
            })

            existingVideoIds.add(vInfo.videoId) // 更新内存中的集合
          }
        }
        try {
          await this.sleep(500)
        } catch (error: any) {
          if (error.message === 'Context disposed') break
          throw error
        }
      }

      if (uploaders.length > 0 && !this.abortController.signal.aborted) {
        this.ctx.emit('lfvs/schedule-round-end', this.platform, 'uploader', uploaders.length, totalSuccess, totalFailure, Date.now() - roundStart)
      }
    } finally {
      this.isScanningUploaders = false
    }
  }
}

export const apply = (ctx: Context, config: Config) => {
  ctx.plugin(YoutubeScheduleService, config)
}
