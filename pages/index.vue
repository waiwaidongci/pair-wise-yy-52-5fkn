<script setup lang="ts">
import { useOperationsStore } from '~/stores/operations'

const store = useOperationsStore()
const { data } = await useFetch('/api/operations')
const { reconnect } = useRealtime((event) => {
  if (event.type === 'connection') store.connection = event.payload.startsWith('在线') ? '在线' : '重连中'
  if (event.type === 'permit-update') store.latestAlert = event.payload
})
const counts = computed(() => ({
  active: store.permits.filter((item) => ['执行中', '待结束'].includes(item.status)).length,
  pending: store.permits.filter((item) => ['待复核', '待执行'].includes(item.status)).length,
  conflicts: store.permits.filter((item) => item.reviewRequired).length,
}))
const unresolved = computed(() => store.pendingItems.filter((item) => !item.resolved))
const outboxPending = computed(() => store.outbox.filter((item) => item.status === '待上传').sort((a, b) => a.seq - b.seq))
const kindColor: Record<string, string> = { 冲突: 'red', 版本过期: 'amber', 作废结果: 'orange', 离线合并: 'blue' }
const opKindLabel: Record<string, string> = { step: '步骤', advance: '推进', isolation: '隔离点' }
</script>

<template>
  <div class="page">
    <div class="head">
      <div><p class="eyebrow">现场安全运行</p><h1 class="page-title">隔离与作业许可总览</h1><p class="muted">设备状态、隔离锁定、跨班组冲突和许可流转集中于同一视图。</p></div>
      <div class="inline wrap"><UButton :color="store.connection === '在线' ? 'gray' : 'amber'" variant="outline" icon="i-heroicons-arrow-path" @click="store.toggleConnection()">{{ store.connection === '在线' ? '模拟断网' : `恢复连接（${outboxPending.length} 项待传）` }}</UButton><UButton color="primary" icon="i-heroicons-document-plus" @click="navigateTo('/permits?new=1')">申请作业许可</UButton></div>
    </div>
    <UAlert v-if="store.latestAlert" class="mb-4" color="amber" variant="soft" icon="i-heroicons-exclamation-triangle" title="实时冲突提醒" :description="store.latestAlert" :actions="[{ label: '协调并确认', click: store.acceptAlert }]" />

    <section v-if="unresolved.length" class="panel p-4 pending-panel">
      <div class="panel-head"><div><h2>待负责人协调</h2><p class="muted">冲突复核、过期操作与作废结果在此挂起，处理前不得推进</p></div><UBadge color="red" variant="subtle">{{ unresolved.length }} 项待处理</UBadge></div>
      <div v-for="item in unresolved" :key="item.id" class="pending-row">
        <UBadge :color="kindColor[item.kind] ?? 'gray'" variant="subtle">{{ item.kind }}</UBadge>
        <div class="pending-body"><b>{{ item.title }}</b><small>{{ item.detail }}</small></div>
        <UButton size="xs" color="primary" variant="outline" @click="store.resolvePending(item.id)">协调并确认</UButton>
      </div>
    </section>

    <section v-if="store.outbox.length" class="panel p-4 pending-panel">
      <div class="panel-head"><div><h2>本机待传操作</h2><p class="muted">断网期间按顺序暂存，恢复后逐一合并；版本过期的操作驳回且不覆盖新状态</p></div><UBadge :color="outboxPending.length ? 'amber' : 'gray'" variant="subtle">{{ outboxPending.length }} 项待上传</UBadge></div>
      <div v-for="op in [...store.outbox].sort((a, b) => a.seq - b.seq)" :key="op.id" class="pending-row">
        <UBadge :color="op.status === '已应用' ? 'green' : op.status === '已驳回' ? 'red' : 'amber'" variant="subtle">{{ op.status }}</UBadge>
        <div class="pending-body"><b>OP-{{ op.seq }} · {{ opKindLabel[op.kind] }} · {{ op.permitId }}</b><small>基于 r{{ op.baseRevision }} · {{ op.createdAt }}<span v-if="op.rejectReason"> · {{ op.rejectReason }}</span></small></div>
      </div>
      <UButton v-if="outboxPending.length" block color="primary" variant="outline" class="mt-3" icon="i-heroicons-arrow-path" @click="store.flushOutbox()">按序重传 {{ outboxPending.length }} 项</UButton>
    </section>

    <section class="grid metrics">
      <article class="panel metric"><span>执行中许可</span><strong>{{ counts.active }}</strong><small>3 个班组在场</small></article>
      <article class="panel metric"><span>待复核 / 待执行</span><strong>{{ counts.pending }}</strong><small>最早 18:00 开工</small></article>
      <article class="panel metric"><span>隔离冲突</span><strong class="danger">{{ counts.conflicts }}</strong><small>必须复核后推进</small></article>
      <article class="panel metric"><span>设备在线</span><strong>{{ data?.onlineDevices }}/{{ data?.totalDevices }}</strong><small>平均风速 {{ data?.windSpeed }} m/s</small></article>
    </section>
    <section class="grid main-grid">
      <article class="panel p-4">
        <div class="panel-head"><div><h2>当前作业状态</h2><p class="muted">按风险和开始时间排序</p></div><UBadge color="blue" variant="subtle">版本 r{{ data?.revision }}</UBadge></div>
        <div class="table-scroll"><table class="data-table"><thead><tr><th>许可 / 作业</th><th>设备</th><th>负责人</th><th>时间窗</th><th>状态</th><th></th></tr></thead><tbody>
          <tr v-for="permit in store.permits" :key="permit.id"><td><b>{{ permit.id }}</b><small class="block muted">{{ permit.title }}</small></td><td>{{ permit.device }}</td><td>{{ permit.owner }} · {{ permit.crew }}</td><td>{{ permit.window }}</td><td><UBadge :color="permit.reviewRequired ? 'red' : permit.status === '执行中' ? 'green' : 'amber'" variant="subtle">{{ permit.reviewRequired ? '待复核冲突' : permit.status }}</UBadge></td><td><UButton size="xs" variant="ghost" @click="navigateTo(`/permits?id=${permit.id}`)">进入</UButton></td></tr>
        </tbody></table></div>
      </article>
      <aside class="grid side-grid">
        <article class="panel p-4"><h2>设备状态</h2><div class="device-row"><span class="dot green" /><div><b>WTG-01 ~ WTG-28</b><small>正常运行</small></div><UBadge color="green">28</UBadge></div><div class="device-row"><span class="dot amber" /><div><b>WTG-03、LINE-A2</b><small>检修隔离中</small></div><UBadge color="amber">2</UBadge></div><div class="device-row"><span class="dot red" /><div><b>BOX-12</b><small>待执行许可</small></div><UBadge color="red">1</UBadge></div></article>
        <article class="panel p-4"><h2>现场条件</h2><div class="condition"><span>轮毂高度风速</span><b>10.8 m/s</b></div><div class="condition"><span>能见度</span><b>12 km</b></div><div class="condition"><span>高空作业</span><b class="danger">暂停</b></div><div class="condition"><span>下一次窗口</span><b>17:40 复核</b></div></article>
      </aside>
    </section>
  </div>
</template>

<style scoped>
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;margin-bottom:18px}.head h1{margin:3px 0 7px}.head p{margin:0}.eyebrow{font-size:12px;color:#2563eb;font-weight:700}.metrics{grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}.metric{padding:17px}.main-grid{grid-template-columns:minmax(0,1.65fr) minmax(290px,.7fr);gap:16px}.panel-head{display:flex;justify-content:space-between;margin-bottom:12px}.panel h2{font-size:17px;margin:0 0 12px}.panel-head h2{margin:0}.panel-head p{font-size:12px;margin:3px 0}.block,.device-row small{display:block}.side-grid{gap:14px}.device-row,.condition{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 0;border-bottom:1px solid #edf0f5}.device-row{justify-content:flex-start}.device-row div{flex:1}.dot{width:9px;height:9px;border-radius:50%}.dot.green{background:#22c55e}.dot.amber{background:#f59e0b}.dot.red{background:#ef4444}.condition{font-size:14px}.condition span{color:#667085}.pending-panel{margin-bottom:16px}.pending-row{display:flex;align-items:center;gap:12px;padding:11px 0;border-bottom:1px solid #edf0f5}.pending-row:last-of-type{border-bottom:0}.pending-body{flex:1;min-width:0}.pending-body b{display:block;font-size:14px}.pending-body small{display:block;color:#667085;margin-top:3px;font-size:12px}
@media(max-width:1100px){.metrics{grid-template-columns:1fr 1fr}.main-grid{grid-template-columns:1fr}}@media(max-width:620px){.head{flex-direction:column}.metrics{grid-template-columns:1fr}}
</style>
