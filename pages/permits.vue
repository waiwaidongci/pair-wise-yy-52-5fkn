<script setup lang="ts">
import { useOperationsStore } from '~/stores/operations'
import type { Permit } from '~/types'

const store = useOperationsStore()
const route = useRoute()
const selectedId = ref(String(route.query.id || store.permits[0]?.id))
const modal = ref(route.query.new === '1')
const form = reactive({ title: '', device: '', crew: '电气一班', owner: '孙禾', window: '09-30 08:00 — 12:00', risk: '二级' as Permit['risk'] })
const selected = computed(() => store.permits.find((item) => item.id === selectedId.value) ?? store.permits[0])
const completed = computed(() => selected.value ? Math.round(selected.value.steps.filter((step) => step.done).length / selected.value.steps.length * 100) : 0)
const statusIndex = computed(() => ['待复核', '待执行', '执行中', '待结束', '待关闭', '已完成'].indexOf(selected.value?.status ?? ''))
const hardConflicts = computed(() => (selected.value?.conflicts ?? []).filter((item) => item.severity === 'hard'))

function inferResource(device: string) {
  if (device.includes('母线') || device.includes('BUS')) return 'BUS-A'
  if (device.includes('LINE') || device.includes('线路')) return device.split(/\s|[·]/)[0] || 'LINE-A2'
  return device.split(/\s|[·]/)[0] || device
}

function createPermit() {
  if (!form.title.trim() || !form.device.trim()) return
  const resource = inferResource(form.device.trim())
  const permit: Permit = {
    id: `WP-${new Date().toISOString().slice(2, 10).replaceAll('-', '')}-${String(store.permits.length + 31).padStart(3, '0')}`,
    ...form, status: '待复核', revision: 1, reviewRequired: true, conflicts: [],
    isolationPoints: [{ id: `IP-${Date.now().toString().slice(-4)}`, device: form.device, resource, label: '主隔离点', type: '开关', state: '待操作' }],
    steps: [
      { id: 'ST-31', text: '核对设备双重编号与工作范围', done: false, owner: form.owner },
      { id: 'ST-32', text: '完成隔离、锁定、验电和接地', done: false, owner: form.owner, dependsOnBoundary: true },
    ],
  }
  store.addPermit(permit)
  selectedId.value = permit.id
  modal.value = false
}
</script>

<template>
  <div class="page">
    <div class="head"><div><p class="eyebrow">许可全生命周期</p><h1 class="page-title">作业许可证</h1><p class="muted">许可步骤、隔离点、班组占用共用同一条重算链路；边界一变，受影响许可立即退回复核，旧完成结果自动作废。</p></div><UButton icon="i-heroicons-plus" color="primary" @click="modal = true">新建许可</UButton></div>
    <div class="permit-layout">
      <aside class="panel permit-list">
        <button v-for="permit in store.permits" :key="permit.id" :class="{ active: permit.id === selectedId }" @click="selectedId = permit.id"><span><b>{{ permit.id }}</b><small>{{ permit.title }}</small></span><UBadge :color="permit.reviewRequired ? 'red' : permit.boundaryStale ? 'orange' : 'amber'" variant="subtle">{{ permit.reviewRequired ? '退回复核' : permit.status }}</UBadge></button>
      </aside>
      <section v-if="selected" class="grid detail-grid">
        <article class="panel p-4">
          <div class="detail-head"><div><small class="muted">{{ selected.id }} · 修订 r{{ selected.revision }}</small><h2>{{ selected.title }}</h2><p>{{ selected.device }} · {{ selected.window }} · {{ selected.crew }}</p></div><UBadge size="lg" :color="selected.reviewRequired ? 'red' : 'green'" variant="subtle">{{ selected.reviewRequired ? '待复核' : selected.status }}</UBadge></div>
          <div class="flow"><div v-for="(step,index) in ['申请','复核','执行','结束','关闭']" :key="step" :class="{ done: index <= statusIndex, current: index === statusIndex }"><i>{{ index + 1 }}</i><span>{{ step }}</span></div></div>
          <UAlert v-if="selected.boundaryStale" color="orange" variant="soft" class="mb-3" icon="i-heroicons-arrow-uturn-left" title="依赖旧边界的完成结果已作废" description="隔离边界在步骤确认后发生变化，相关步骤须按新边界重新验电、核位后才能继续推进。" />
          <UAlert v-for="conflict in hardConflicts" :key="`${conflict.resource}-${conflict.otherPermitId}`" color="red" variant="soft" class="mb-2" :title="`共用 ${conflict.resource} 与 ${conflict.otherCrew}${conflict.otherPermitId} 冲突`" :description="conflict.reason" />
          <h3>操作步骤</h3>
          <div v-for="step in selected.steps" :key="step.id" class="step" :class="{ stale: step.invalidated }">
            <UCheckbox :model-value="step.done && !step.invalidated" :disabled="step.invalidated" @update:model-value="store.toggleStep(selected.id, step.id)" />
            <div><b :class="{ completed: step.done, invalidated: step.invalidated }">{{ step.text }}</b><small>责任人 {{ step.owner }} · {{ step.evidence || (step.invalidated ? '原证据保留，结果已作废' : '尚未上传证据') }}</small><small v-if="step.invalidated" class="stale-text"><UIcon name="i-heroicons-exclamation-triangle" /> {{ step.invalidateReason }} · 完成于 {{ step.completedAt || '此前' }}</small></div>
            <UBadge v-if="step.dependsOnBoundary" color="blue" variant="subtle" size="xs">绑定边界</UBadge>
            <UButton size="xs" variant="ghost" icon="i-heroicons-camera">证据</UButton>
            <UButton v-if="step.invalidated" size="xs" color="red" variant="soft" @click="store.toggleStep(selected.id, step.id)">重新确认</UButton>
          </div>
          <UProgress :value="completed" class="mt-4" /><div class="inline justify-between mt-1"><span class="muted">步骤完成度（已作废步骤不计入）</span><b>{{ completed }}%</b></div>
        </article>
        <aside class="grid right">
          <article class="panel p-4"><h3>隔离点与锁定</h3><p class="muted small">点击「变更状态」模拟现场操作：每次变更都会立即重算全平台占用。</p><div v-for="point in selected.isolationPoints" :key="point.id" class="point"><span><b>{{ point.label }}</b><small>{{ point.device }} · {{ point.type }} · 资源 {{ point.resource }}</small></span><div class="inline"><UBadge :color="point.state === '已隔离' ? 'green' : point.state === '已恢复' ? 'gray' : 'amber'" variant="subtle">{{ point.state }}</UBadge><UButton size="xs" variant="outline" @click="store.cyclePoint(selected.id, point.id)">变更状态</UButton></div></div></article>
          <article class="panel p-4"><h3>流程操作</h3><p class="muted">推进前系统在同一条链路中重新检查隔离冲突、跨班组占用与旧边界结果。</p><UButton block color="primary" icon="i-heroicons-arrow-right-circle" @click="store.advancePermit(selected.id)">推进到下一状态</UButton><UButton block class="mt-2" color="gray" variant="outline" icon="i-heroicons-arrow-uturn-left">退回补件</UButton><UButton block class="mt-2" color="red" variant="soft" icon="i-heroicons-exclamation-triangle">申请紧急暂停</UButton></article>
        </aside>
      </section>
    </div>
    <UModal v-model="modal"><article class="p-5"><h2>申请作业许可</h2><p class="muted">提交后进入安全复核，设备隔离冲突会按统一重算链路自动校验。</p><div class="form-grid"><UFormGroup label="作业名称"><UInput v-model="form.title" /></UFormGroup><UFormGroup label="设备编号（含 BUS-A / LINE-A2 可自动关联共享资源）"><UInput v-model="form.device" /></UFormGroup><UFormGroup label="班组"><UInput v-model="form.crew" /></UFormGroup><UFormGroup label="负责人"><UInput v-model="form.owner" /></UFormGroup><UFormGroup label="计划窗口"><UInput v-model="form.window" /></UFormGroup><UFormGroup label="风险等级"><USelect v-model="form.risk" :options="['一级','二级','三级']" /></UFormGroup></div><div class="inline justify-end mt-4"><UButton color="gray" @click="modal = false">取消</UButton><UButton color="primary" :disabled="!form.title || !form.device" @click="createPermit">提交复核</UButton></div></article></UModal>
  </div>
</template>

<style scoped>
.head{display:flex;justify-content:space-between;gap:16px;margin-bottom:18px}.head h1{margin:3px 0 7px}.head p{margin:0}.eyebrow{font-size:12px;color:#2563eb;font-weight:700}.permit-layout{display:grid;grid-template-columns:300px minmax(0,1fr);gap:16px}.permit-list{padding:8px;height:fit-content}.permit-list button{width:100%;display:flex;justify-content:space-between;align-items:center;gap:8px;padding:13px 11px;border:0;background:transparent;border-radius:7px;text-align:left;color:inherit;cursor:pointer}.permit-list button:hover,.permit-list button.active{background:#eff6ff}.permit-list b,.permit-list small{display:block}.permit-list small{color:#667085;margin-top:4px;font-size:12px}.detail-grid{grid-template-columns:minmax(0,1.5fr) minmax(280px,.65fr);gap:16px}.right{height:fit-content;gap:14px}.detail-head{display:flex;justify-content:space-between;gap:10px;margin-bottom:16px}.detail-head h2{margin:4px 0}.detail-head p{margin:0;color:#667085}.flow{display:grid;grid-template-columns:repeat(5,1fr);margin:20px 0}.flow>div{position:relative;text-align:center;color:#94a3b8}.flow>div:after{content:"";position:absolute;left:55%;right:-45%;top:13px;height:2px;background:#e2e8f0}.flow>div:last-child:after{display:none}.flow i{position:relative;z-index:1;display:grid;place-items:center;width:28px;height:28px;margin:auto;border-radius:50%;background:#e2e8f0;font-style:normal;font-size:12px}.flow span{display:block;font-size:12px;margin-top:5px}.flow .done{color:#2563eb}.flow .done i{background:#2563eb;color:#fff}.flow .done:after{background:#2563eb}.panel h3{font-size:15px;margin:18px 0 10px}.small{font-size:12px}.step{display:flex;align-items:flex-start;gap:10px;padding:12px 0;border-bottom:1px solid #edf0f5}.step.stale{background:#fff7ed;border-radius:6px;padding-left:8px;padding-right:8px}.step div{flex:1}.step small{display:block;color:#667085;margin-top:4px}.step .completed{text-decoration:line-through;color:#667085}.step .invalidated{color:#c2410c;text-decoration:line-through}.stale-text{color:#c2410c}.point{display:flex;justify-content:space-between;gap:8px;align-items:center;padding:11px 0;border-bottom:1px solid #edf0f5}.point b,.point small{display:block}.point small{color:#667085;margin-top:4px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:18px 0}.mt-2{margin-top:8px}
@media(max-width:980px){.permit-layout{grid-template-columns:1fr}.permit-list{display:flex;overflow:auto}.permit-list button{min-width:230px}.detail-grid{grid-template-columns:1fr}}@media(max-width:620px){.head{flex-direction:column}.form-grid{grid-template-columns:1fr}}
</style>
