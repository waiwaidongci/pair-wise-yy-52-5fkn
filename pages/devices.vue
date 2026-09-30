<script setup lang="ts">
import { useOperationsStore } from '~/stores/operations'

const store = useOperationsStore()
const selectedDevice = ref('BUS-A')

const deviceResources: Record<string, string[]> = {
  'WTG-03': ['WTG-03'],
  'LINE-A2': ['LINE-A2'],
  'BOX-12': ['BOX-12'],
  'BUS-A': ['BUS-A'],
}

const selectedPoints = computed(() =>
  store.permits
    .flatMap((permit) => permit.isolationPoints.map((point) => ({ point, permit })))
    .filter(({ point }) => point.resource === selectedDevice.value || point.device.includes(selectedDevice.value)),
)

const resourceCrews = computed(() => {
  const map = new Map<string, Set<string>>()
  for (const permit of store.permits) {
    for (const point of permit.isolationPoints) {
      if (point.state === '已恢复') continue
      if (!map.has(point.resource)) map.set(point.resource, new Set())
      map.get(point.resource)!.add(permit.crew)
    }
  }
  return map
})

const devices = computed(() => [
  { id: 'WTG-03', name: '3 号风力发电机组', state: '检修隔离', load: '0 kW', crew: '机务二班' },
  { id: 'LINE-A2', name: 'A2 集电线路', state: '待隔离', load: '0.8 MW', crew: '线路一班' },
  { id: 'BOX-12', name: '12 号箱式变压器', state: '重算退回复核', load: '2.4 MW', crew: '电气一班' },
  { id: 'BUS-A', name: 'A 段 35kV 母线（共享边界）', state: (resourceCrews.value.get('BUS-A')?.size ?? 0) > 1 ? '跨班组共用' : '运行', load: '18.6 MW', crew: [...(resourceCrews.value.get('BUS-A') ?? ['公用'])].join(' / ') },
])

const busConflicts = computed(() => {
  const list = new Map<string, { permitId: string; crew: string; reason: string }>()
  for (const permit of store.permits) {
    for (const conflict of permit.conflicts.filter((c) => c.severity === 'hard')) {
      list.set(`${permit.id}-${conflict.otherPermitId}`, { permitId: permit.id, crew: permit.crew, reason: conflict.reason })
    }
  }
  return [...list.values()]
})
</script>

<template>
  <div class="page">
    <div class="head"><div><p class="eyebrow">LOCKOUT / TAGOUT</p><h1 class="page-title">设备隔离与锁定点</h1><p class="muted">隔离点状态一经变更，许可、班组占用与冲突在同一条链路立即重算并留痕。</p></div><UButton color="gray" variant="outline" :icon="store.connection === '在线' ? 'i-heroicons-signal-slash' : 'i-heroicons-arrow-path'" @click="store.connection === '在线' ? store.markOffline() : store.reconnect()">{{ store.connection === '在线' ? '模拟断网' : '重连合并' }}</UButton></div>
    <div class="device-grid">
      <article v-for="device in devices" :key="device.id" class="panel device" :class="{ active: selectedDevice === device.id }" @click="selectedDevice = device.id"><div class="inline justify-between"><UBadge variant="subtle">{{ device.id }}</UBadge><UBadge :color="device.state.includes('运行') ? 'green' : device.state.includes('跨') ? 'red' : 'amber'" variant="subtle">{{ device.state }}</UBadge></div><h2>{{ device.name }}</h2><div class="kv"><span>当前负荷</span><b>{{ device.load }}</b></div><div class="kv"><span>占用班组（重算）</span><b>{{ resourceCrews.get(deviceResources[device.id]?.[0] ?? device.id)?.size ?? 0 }} 个 · {{ device.crew }}</b></div></article>
    </div>
    <section class="grid lower"><article class="panel p-4"><h2>{{ selectedDevice }} · 隔离检查单</h2><div v-for="{ point, permit } in selectedPoints" :key="point.id" class="point"><div class="lock-icon"><UIcon :name="point.state === '已隔离' ? 'i-heroicons-lock-closed' : point.state === '已恢复' ? 'i-heroicons-lock-open' : 'i-heroicons-key'" /></div><div><b>{{ point.label }}</b><small>{{ permit.crew }} · {{ permit.id }} · {{ point.type }} · {{ point.id }}</small></div><UBadge :color="point.state === '已隔离' ? 'green' : point.state === '已恢复' ? 'gray' : 'amber'" variant="subtle">{{ point.state }}</UBadge><UButton size="xs" variant="outline" @click.stop="store.cyclePoint(permit.id, point.id)">变更状态</UButton></div><UAlert v-if="!selectedPoints.length" color="gray" title="该资源暂无隔离点" description="可在许可中新建隔离点并关联资源。" /></article><article class="panel p-4"><h2>交叉冲突检测（统一重算输出）</h2>
      <UAlert v-if="!busConflicts.length" color="green" variant="soft" title="当前无未协调跨班组冲突" description="共享资源占用与作业窗口经重算链路检查通过；值班负责人的协调决策仍锁定边界快照。" />
      <div v-for="(conflict, index) in busConflicts" :key="`${conflict.permitId}-${index}`" class="conflict-row"><div><b class="danger">{{ conflict.permitId }}</b><p class="muted small">{{ conflict.reason }}</p></div><UButton size="xs" color="red" variant="soft" @click="navigateTo('/#coordination')">去协调</UButton></div>
      <h3>锁定器具台账</h3><div class="tool"><span>LK-2107</span><b>WTG-03 · 周野</b></div><div class="tool"><span>LK-2118</span><b>LINE-A2 · 待领用</b></div><div class="tool"><span>GND-042</span><b>17 号杆 · 谭勇</b></div>
    </article></section>
  </div>
</template>

<style scoped>
.head{display:flex;justify-content:space-between;margin-bottom:18px}.head h1{margin:3px 0 7px}.head p{margin:0}.eyebrow{font-size:12px;color:#2563eb;font-weight:700}.device-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}.device{padding:16px;cursor:pointer}.device.active{border-color:#2563eb;box-shadow:0 0 0 2px #dbeafe}.device h2{font-size:16px;margin:14px 0}.kv{display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid #edf0f5;font-size:13px}.kv span{color:#667085}.lower{grid-template-columns:1.3fr .7fr;gap:16px}.panel h2{font-size:17px;margin:0 0 14px}.point{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid #edf0f5}.point>div:nth-child(2){flex:1}.point b,.point small{display:block}.point small{color:#667085;margin-top:4px}.lock-icon{display:grid;place-items:center;width:34px;height:34px;background:#eff6ff;color:#2563eb;border-radius:7px}.conflict-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #edf0f5}.tool{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #edf0f5}.tool span{color:#2563eb;font-family:monospace}.tool b{font-size:13px}.small{font-size:12px}
@media(max-width:1050px){.device-grid{grid-template-columns:1fr 1fr}.lower{grid-template-columns:1fr}}@media(max-width:600px){.head{flex-direction:column;gap:12px}.device-grid{grid-template-columns:1fr}}
</style>
