<script setup lang="ts">
import { useOperationsStore } from '~/stores/operations'

const store = useOperationsStore()
const { data } = await useFetch('/api/operations')
useRealtime((event) => {
  if (event.type === 'connection') {
    const online = event.payload.startsWith('在线')
    if (!online) store.markOffline()
  }
  if (event.type === 'permit-update') store.latestAlert = event.payload
})
const counts = computed(() => ({
  active: store.permits.filter((item) => ['执行中', '待结束'].includes(item.status)).length,
  pending: store.permits.filter((item) => ['待复核', '待执行'].includes(item.status)).length,
  conflicts: store.permits.filter((item) => item.reviewRequired).length,
}))
const pendingFollowUps = computed(() => store.followUps.filter((item) => item.status === '待处理'))
const coordinated = computed(() => store.followUps.filter((item) => item.status === '已协调'))
const resourceOccupancy = computed(() =>
  ['BUS-A', 'LINE-A2', 'BOX-12', 'WTG-03', 'BOX-03'].map((resource) => {
    const holders = store.permits.filter((p) => p.isolationPoints.some((pt) => pt.resource === resource && pt.state !== '已恢复'))
    return { resource, crews: [...new Set(holders.map((p) => p.crew))], labels: holders.map((p) => `${p.crew}${p.id.slice(-3)}`) }
  }),
)

function permitLabel(id: string) {
  const permit = store.permits.find((item) => item.id === id)
  return permit ? `${id} ${permit.title}` : id
}
function resolveDefault(followUp: ReturnType<typeof pendingFollowUps>['value'][number]) {
  if (followUp.kind === '冲突协调') {
    store.coordinate(followUp.id, '同意按先后顺序作业，共用隔离边界由值班负责人统一发布，不允许同时开工')
  } else {
    store.resolveFollowUp(followUp.id, '已人工核对服务器新状态，确认按新状态执行，旧操作不再重放')
  }
}
</script>

<template>
  <div class="page">
    <div class="head">
      <div><p class="eyebrow">现场安全运行</p><h1 class="page-title">隔离与作业许可总览</h1><p class="muted">许可步骤、隔离点、班组占用、冲突复核与留痕在同一条重算链路内联动。</p></div>
      <div class="inline wrap"><UButton color="gray" variant="outline" icon="i-heroicons-arrow-path" @click="navigateTo('/permits')">查看许可</UButton><UButton color="primary" icon="i-heroicons-document-plus" @click="navigateTo('/permits?new=1')">申请作业许可</UButton></div>
    </div>
    <UAlert v-if="store.latestAlert" class="mb-4" color="amber" variant="soft" icon="i-heroicons-exclamation-triangle" title="实时冲突提醒" :description="store.latestAlert" :actions="[{ label: '前往协调', click: () => navigateTo('/#coordination') }]" />

    <section v-if="store.connection === '重连中'" class="panel p-4 mb-4 offline-bar">
      <div class="inline wrap justify-between">
        <div><b>离线模式：本机操作已入队列，重连后按顺序合并</b>
          <p class="muted mt-1">本机待合并 <b class="warning">{{ store.outbox.length }}</b> 项 · 缓存对端推进意图 <b>{{ store.remoteIntents.length }}</b> 项 · 版本过期的操作不会覆盖新状态</p>
        </div>
        <div class="inline">
          <UButton color="gray" variant="outline" icon="i-heroicons-bolt" @click="store.simulateRemoteIntent">模拟对端推进</UButton>
          <UButton color="amber" variant="soft" icon="i-heroicons-arrow-path" @click="store.reconnect">立即重连合并</UButton>
        </div>
      </div>
      <div v-if="store.outbox.length" class="queue mt-3">
        <span v-for="op in store.outbox" :key="op.id" class="queue-item"><UBadge size="xs" color="amber" variant="subtle">r{{ op.baseRevision }}</UBadge>{{ op.label }}</span>
      </div>
    </section>

    <section class="grid metrics">
      <article class="panel metric"><span>执行中许可</span><strong>{{ counts.active }}</strong><small>{{ new Set(store.permits.map(p => p.crew)).size }} 个班组在场</small></article>
      <article class="panel metric"><span>待复核 / 待执行</span><strong>{{ counts.pending }}</strong><small>重算退回立即生效</small></article>
      <article class="panel metric"><span>复核退回 / 冲突</span><strong class="danger">{{ counts.conflicts }}</strong><small>必须协调后推进</small></article>
      <article class="panel metric"><span>设备在线</span><strong>{{ data?.onlineDevices }}/{{ data?.totalDevices }}</strong><small>平均风速 {{ data?.windSpeed }} m/s</small></article>
    </section>

    <section id="coordination" class="panel p-4 mb-4">
      <div class="panel-head"><div><h2>待负责人协调（{{ pendingFollowUps.length }}）</h2><p class="muted">未决共享边界冲突、版本过期拦截与旧边界作废统一在此分派；协调决策锁定边界快照，边界再变自动失效。</p></div></div>
      <div v-if="!pendingFollowUps.length" class="empty">当前没有待处理项，所有共享边界均已有序占用或已完成协调。</div>
      <div v-for="followUp in pendingFollowUps" :key="followUp.id" class="fu-row">
        <div>
          <div class="inline wrap"><UBadge :color="followUp.kind === '冲突协调' ? 'red' : 'orange'" variant="subtle">{{ followUp.kind }}</UBadge><b>{{ followUp.title }}</b><span class="muted small">责任人 {{ followUp.owner }} · {{ followUp.createdAt }}</span></div>
          <p class="muted mt-1">{{ followUp.detail }}</p>
          <p class="small"><span v-for="id in followUp.permitIds" :key="id" class="permit-chip" @click="navigateTo(`/permits?id=${id}`)">{{ permitLabel(id) }}</span></p>
        </div>
        <div class="fu-actions">
          <UButton v-if="followUp.kind === '冲突协调'" size="sm" color="primary" icon="i-heroicons-check-badge" @click="resolveDefault(followUp)">协调放行</UButton>
          <UButton size="sm" color="gray" variant="outline" @click="store.resolveFollowUp(followUp.id, '值班负责人已核对并关闭')">人工关闭</UButton>
        </div>
      </div>
      <div v-if="coordinated.length" class="coordinated mt-3">
        <span class="muted small">已协调（边界再变将自动退回）：</span>
        <span v-for="item in coordinated" :key="item.id" class="done-chip"><UIcon name="i-heroicons-shield-check" />{{ item.title }} · {{ item.resolvedAt }}</span>
      </div>
    </section>

    <section class="grid main-grid">
      <article class="panel p-4">
        <div class="panel-head"><div><h2>当前作业状态</h2><p class="muted">状态、冲突与作废标记每次变更后全量重算</p></div><UBadge color="blue" variant="subtle">统一链路</UBadge></div>
        <div class="table-scroll"><table class="data-table"><thead><tr><th>许可 / 作业</th><th>班组</th><th>时间窗</th><th>状态</th><th>冲突</th><th></th></tr></thead><tbody>
          <tr v-for="permit in store.permits" :key="permit.id"><td><b>{{ permit.id }}</b><small class="block muted">{{ permit.title }}</small></td><td>{{ permit.crew }}<small class="block muted">{{ permit.owner }}</small></td><td>{{ permit.window }}</td><td><UBadge :color="permit.reviewRequired ? 'red' : permit.status === '执行中' ? 'green' : 'amber'" variant="subtle">{{ permit.reviewRequired ? '已退回复核' : permit.status }}</UBadge><UBadge v-if="permit.boundaryStale" color="orange" variant="subtle" class="ml-1">旧结果作废</UBadge></td><td><span v-for="conflict in permit.conflicts.filter(c => c.severity === 'hard')" :key="`${conflict.resource}-${conflict.otherPermitId}`"><UBadge color="red" variant="subtle" size="xs">{{ conflict.resource }} 与 {{ conflict.otherPermitId }}</UBadge> </span><span v-if="!permit.conflicts.some(c => c.severity === 'hard')" class="muted">—</span></td><td><UButton size="xs" variant="ghost" @click="navigateTo(`/permits?id=${permit.id}`)">进入</UButton></td></tr>
        </tbody></table></div>
      </article>
      <aside class="grid side-grid">
        <article class="panel p-4"><h2>共享资源占用</h2>
          <div v-for="item in resourceOccupancy" :key="item.resource" class="device-row"><span class="dot" :class="item.crews.length > 1 ? 'red' : item.crews.length ? 'amber' : 'green'" /><div><b>{{ item.resource }}</b><small>{{ item.labels.join('、') || '无占用' }}</small></div><UBadge :color="item.crews.length > 1 ? 'red' : 'green'" variant="subtle">{{ item.crews.length }} 班组</UBadge></div>
        </article>
        <article class="panel p-4"><h2>现场条件</h2><div class="condition"><span>轮毂高度风速</span><b>10.8 m/s</b></div><div class="condition"><span>能见度</span><b>12 km</b></div><div class="condition"><span>高空作业</span><b class="danger">暂停</b></div><div class="condition"><span>下一次窗口</span><b>17:40 复核</b></div></article>
      </aside>
    </section>
  </div>
</template>

<style scoped>
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;margin-bottom:18px}.head h1{margin:3px 0 7px}.head p{margin:0}.eyebrow{font-size:12px;color:#2563eb;font-weight:700}.metrics{grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}.metric{padding:17px}.main-grid{grid-template-columns:minmax(0,1.65fr) minmax(290px,.7fr);gap:16px}.panel-head{display:flex;justify-content:space-between;margin-bottom:12px}.panel h2{font-size:17px;margin:0 0 12px}.panel-head h2{margin:0}.panel-head p{font-size:12px;margin:3px 0}.block,.device-row small{display:block}.side-grid{gap:14px}.device-row,.condition{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 0;border-bottom:1px solid #edf0f5}.device-row{justify-content:flex-start}.device-row div{flex:1}.dot{width:9px;height:9px;border-radius:50%;background:#f59e0b}.dot.green{background:#22c55e}.dot.amber{background:#f59e0b}.dot.red{background:#ef4444}.condition{font-size:14px}.condition span{color:#667085}.offline-bar{border-left:4px solid #d97706}.queue{display:flex;flex-wrap:wrap;gap:8px}.queue-item{display:inline-flex;align-items:center;gap:6px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:5px 9px;font-size:12px}.fu-row{display:flex;justify-content:space-between;gap:14px;align-items:center;padding:14px 0;border-bottom:1px solid #edf0f5}.fu-actions{display:flex;gap:8px;flex-shrink:0}.small{font-size:12px}.permit-chip{display:inline-block;background:#f1f5f9;border-radius:5px;padding:2px 8px;margin:4px 6px 0 0;cursor:pointer;font-family:monospace;color:#334155}.permit-chip:hover{background:#e2e8f0}.empty{color:#667085;font-size:13px;padding:10px 0}.coordinated{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.done-chip{display:inline-flex;gap:5px;align-items:center;background:#ecfdf5;color:#15803d;border-radius:5px;padding:3px 9px;font-size:12px}.ml-1{margin-left:4px}
@media(max-width:1100px){.metrics{grid-template-columns:1fr 1fr}.main-grid{grid-template-columns:1fr}}@media(max-width:620px){.head{flex-direction:column}.metrics{grid-template-columns:1fr}.fu-row{flex-direction:column;align-items:flex-start}}
</style>
