<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { send } from '@cordisjs/client'

const data = ref<any>(null)
let timer: number | undefined

const fetchStatus = async () => {
  try { data.value = await send('youtube-schedule/status') } catch {}
}

onMounted(() => { fetchStatus(); timer = window.setInterval(fetchStatus, 500) })
onUnmounted(() => { if (timer !== undefined) clearInterval(timer) })

const pct = (v: number) => Math.min(100, Math.round(v * 100))
const getColor = (v: number) => v > 0.8 ? '#f56c6c' : v > 0.5 ? '#e6a23c' : '#67c23a'

const statusClass = computed(() => {
  if (!data.value) return 'off'
  return data.value.isRunning ? 'run' : 'ok'
})
const statusText = computed(() => {
  if (!data.value) return '离线'
  return data.value.isRunning ? '轮询中' : '空闲'
})

const liveProgress = computed(() => {
  if (!data.value?.isRunning || !data.value.currentTotal) return null
  return {
    pct: Math.round((data.value.currentProcessed / data.value.currentTotal) * 100),
    done: data.value.currentProcessed,
    total: data.value.currentTotal,
    ok: data.value.currentSuccess,
    fail: data.value.currentFailure,
  }
})
</script>

<template>
  <k-slot-item :order="897">
    <k-card class="lfvs-load-card">
      <div class="card-head">
        <span class="card-title">YouTube 调度器</span>
        <span class="badge" :class="statusClass">{{ statusText }}</span>
      </div>
      <template v-if="data">
        <template v-if="liveProgress">
          <div class="bar-row">
            <span class="bar-label">进度</span>
            <el-progress :percentage="liveProgress.pct" :color="'#409eff'" :show-text="false" :stroke-width="8" class="bar" />
            <span class="bar-num">{{ liveProgress.done }}<small> / {{ liveProgress.total }}</small></span>
          </div>
          <div class="live-detail">
            <span class="live-ok">✓ {{ liveProgress.ok }}</span>
            <span class="live-fail" v-if="liveProgress.fail">✗ {{ liveProgress.fail }}</span>
          </div>
        </template>
        <template v-else>
          <div class="bar-row">
            <span class="bar-label">负载</span>
            <el-progress :percentage="pct(data.load)" :color="getColor(data.load)" :show-text="false" :stroke-width="8" class="bar" />
            <span class="bar-num">{{ data.totalProcessed }}<small> / {{ data.maxVideoProcess }}</small></span>
          </div>
        </template>
      </template>
      <div v-else class="card-empty">等待连接…</div>
    </k-card>
  </k-slot-item>
</template>

<style scoped>
.lfvs-load-card { height: 100%; }
.card-head {
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;
}
.card-title { font-weight: 600; font-size: 1.05rem; }
.badge {
  font-size: 0.8rem; padding: 2px 10px; border-radius: 10px; font-weight: 500;
}
.badge.ok  { background: rgba(103,194,58,0.15); color: #67c23a; }
.badge.run { background: rgba(64,158,255,0.15); color: #409eff; }
.badge.off { background: rgba(144,147,153,0.15); color: #909399; }
.bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.bar-label {
  font-size: 0.9rem; color: var(--k-text-light, #888); width: 52px; flex-shrink: 0;
}
.bar { flex: 1; min-width: 0; }
.bar-num {
  font-size: 0.85rem; font-variant-numeric: tabular-nums;
  text-align: right; min-width: 90px; flex-shrink: 0;
}
.bar-num small { color: var(--k-text-light, #888); }
.live-detail {
  display: flex; gap: 12px; font-size: 0.85rem; margin-top: 2px;
}
.live-ok { color: #67c23a; }
.live-fail { color: #f56c6c; }
.card-empty { color: var(--k-text-light, #888); font-size: 0.9rem; }
</style>
