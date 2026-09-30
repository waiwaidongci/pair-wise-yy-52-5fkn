import { defineStore } from 'pinia'
import type { AuditEvent, LocalOp, OpKind, Permit, PendingItem, PointState } from '~/types'
import { auditEvents as seedAudit, permits as seedPermits } from '~/utils/mock'
import { isBoundaryStep, recomputeConflicts, SCHEMA_VERSION } from '~/utils/permits'

const STORAGE_KEY = 'yy52-permit-ops-v1'

function nowTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}
function uid(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4).toString(36).padStart(3, '0')}`
}

/** 旧版本本地数据升级：补齐新增字段，旧许可仍可打开 */
function migrate(raw: any): { schemaVersion: number; permits: Permit[]; audit: AuditEvent[]; pendingItems: PendingItem[]; outbox: LocalOp[] } {
  const version = Number(raw?.schemaVersion ?? 1)
  if (version >= SCHEMA_VERSION) {
    return {
      schemaVersion: version,
      permits: (raw.permits ?? []) as Permit[],
      audit: (raw.audit ?? []) as AuditEvent[],
      pendingItems: (raw.pendingItems ?? []) as PendingItem[],
      outbox: (raw.outbox ?? []) as LocalOp[],
    }
  }
  // v1 → v2：步骤补 stale 字段、许可补 reviewReason、新增待处理项与 outbox
  const permits: Permit[] = (raw.permits ?? []).map((p: any) => ({
    ...p,
    reviewReason: p.reviewReason ?? undefined,
    steps: (p.steps ?? []).map((s: any) => ({
      ...s,
      stale: s.stale ?? false,
      staleReason: s.staleReason ?? undefined,
      doneAt: s.doneAt ?? undefined,
    })),
  }))
  return {
    schemaVersion: SCHEMA_VERSION,
    permits,
    audit: (raw.audit ?? []) as AuditEvent[],
    pendingItems: (raw.pendingItems ?? []) as PendingItem[],
    outbox: (raw.outbox ?? []) as LocalOp[],
  }
}

export const useOperationsStore = defineStore('operations', () => {
  const permits = ref<Permit[]>(structuredClone(seedPermits))
  const audit = ref<AuditEvent[]>(structuredClone(seedAudit))
  const pendingItems = ref<PendingItem[]>([])
  const outbox = ref<LocalOp[]>([])
  const connection = ref<'在线' | '重连中'>('在线')
  const latestAlert = ref('18:00–20:00 LINE-A2 存在跨班组重叠作业')
  const loaded = ref(false)
  let seq = 0

  // ---------- 持久化与迁移 ----------
  function persist() {
    if (!import.meta.client) return
    const shape = {
      schemaVersion: SCHEMA_VERSION,
      permits: permits.value,
      audit: audit.value,
      pendingItems: pendingItems.value,
      outbox: outbox.value,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shape))
  }

  function restore() {
    if (!import.meta.client || loaded.value) return
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      try {
        const data = migrate(JSON.parse(raw))
        permits.value = data.permits
        audit.value = data.audit
        pendingItems.value = data.pendingItems
        outbox.value = data.outbox
        seq = outbox.value.reduce((max, op) => Math.max(max, op.seq), 0)
        if (data.schemaVersion < SCHEMA_VERSION) persist()
      } catch {
        // 本地数据损坏时回退到种子数据，避免打不开
      }
    }
    loaded.value = true
  }

  // ---------- 留痕 ----------
  function addAudit(actor: string, action: string, target: string, detail: string) {
    audit.value.unshift({ id: uid('AE'), time: nowTime(), actor, action, target, detail })
    persist()
  }

  // ---------- 待处理项 ----------
  function addPending(kind: PendingItem['kind'], title: string, detail: string, permitId?: string, permitIds?: string[]) {
    pendingItems.value.unshift({
      id: uid('PI'), kind, title, detail, permitId, permitIds,
      createdAt: nowTime(), resolved: false,
    })
    persist()
  }

  function resolvePending(id: string) {
    const item = pendingItems.value.find((i) => i.id === id)
    if (!item || item.resolved) return
    item.resolved = true
    item.resolution = '负责人已协调确认'
    const ids = item.permitIds ?? (item.permitId ? [item.permitId] : [])
    for (const pid of ids) {
      const permit = permits.value.find((p) => p.id === pid)
      if (permit?.reviewRequired) {
        permit.reviewRequired = false
        permit.reviewReason = undefined
      }
    }
    addAudit('值班负责人', '协调完成', ids.join('、') || '跨班组边界', item.title)
    persist()
  }

  // ---------- 离线 outbox：断网暂存，恢复后按序合并 ----------
  function queueOp(kind: OpKind, permitId: string, payload: Record<string, any>) {
    const permit = permits.value.find((p) => p.id === permitId)
    if (!permit) return
    const op: LocalOp = {
      id: uid('OP'),
      seq: ++seq,
      kind,
      permitId,
      payload,
      baseRevision: permit.revision,
      createdAt: nowTime(),
      status: '待上传',
    }
    outbox.value.push(op)
    addAudit('当前用户', '本机暂存', `${permitId} / OP-${op.seq}`, `${kind} 操作已暂存（基于 r${permit.revision}），待断网恢复后按序上传`)
  }

  /** 恢复连接后按序号合并本机步骤与推进意图；版本过期的操作驳回，不得覆盖新状态 */
  function flushOutbox() {
    if (connection.value !== '在线') return
    const pending = outbox.value.filter((o) => o.status === '待上传').sort((a, b) => a.seq - b.seq)
    for (const op of pending) {
      const res = mutate(op.kind, op.permitId, op.payload, op.baseRevision)
      op.status = res.ok ? '已应用' : '已驳回'
      if (!res.ok) op.rejectReason = res.reason
      addAudit('系统', res.ok ? '补传成功' : '补传驳回', `${op.permitId} / OP-${op.seq}`, res.ok ? '已按顺序合并入新状态' : (res.reason ?? '版本过期'))
    }
    persist()
  }

  // ---------- 变更管线：所有许可变更都走这里（版本校验 → 落子 → 重算） ----------
  function applyOp(kind: OpKind, permitId: string, payload: Record<string, any>) {
    const permit = permits.value.find((p) => p.id === permitId)
    if (!permit) return
    if (kind === 'step') {
      const step = permit.steps.find((s) => s.id === payload.stepId)
      if (step) {
        step.done = !!payload.done
        if (step.stale && payload.done) {
          step.stale = false
          step.staleReason = undefined
        }
        step.doneAt = payload.done ? nowTime() : undefined
      }
    } else if (kind === 'advance') {
      const flow: Record<string, Permit['status']> = {
        待复核: '待执行', 待执行: '执行中', 执行中: '待结束', 待结束: '待关闭', 待关闭: '已完成',
      }
      const next = flow[permit.status]
      if (next) {
        permit.status = next
        permit.reviewRequired = false
        permit.reviewReason = undefined
      }
    } else if (kind === 'isolation') {
      const point = permit.isolationPoints.find((p) => p.id === payload.pointId)
      if (point) point.state = payload.state as PointState
    }
  }

  /**
   * 重算链路：重算班组占用与共享母线冲突，
   * 受影响许可立即退回复核，依赖旧边界的完成结果作废，
   * 全程留痕并生成待处理项。
   */
  function recalculate(triggerPermitId: string) {
    const groups = recomputeConflicts(permits.value)
    for (const group of groups) {
      const ids = group.permits.map((p) => p.id)
      if (!ids.includes(triggerPermitId)) continue
      const reason = group.reasons.join('；')
      let groupChanged = false
      for (const permit of group.permits) {
        const isTrigger = permit.id === triggerPermitId
        // 受影响许可立即退回复核（触发者本人标记待推进确认，其余退回待复核）
        if (!permit.reviewRequired) {
          permit.reviewRequired = true
          permit.reviewReason = reason
          if (!isTrigger && permit.status !== '待复核' && permit.status !== '已完成') {
            permit.status = '待复核'
          }
          addAudit('系统', '退回复核', permit.id, `${reason}；${isTrigger ? '本许可' : '相关许可'}状态退回待复核`)
          groupChanged = true
        } else {
          permit.reviewReason = reason
        }
        // 依赖旧边界的完成结果作废：仅非触发方的边界验证步骤
        if (isTrigger) continue
        for (const step of permit.steps) {
          if (!step.done || !isBoundaryStep(step) || step.stale) continue
          step.done = false
          step.stale = true
          step.staleReason = '共享边界相关许可发生变化，原边界验证结果作废，需在新边界下重新确认'
          addAudit('系统', '完成结果作废', `${permit.id} / ${step.id}`, step.staleReason)
          addPending('作废结果', `${permit.id} 步骤结果作废`, `${step.text}：${step.staleReason}`, permit.id, ids)
          groupChanged = true
        }
      }
      if (groupChanged) addPending('冲突', '共享母线边界冲突', `${ids.join('、')}：${reason}`, ids[0], ids)
    }
  }

  function mutate(kind: OpKind, permitId: string, payload: Record<string, any>, baseRevision: number): { ok: boolean; reason?: string } {
    const permit = permits.value.find((p) => p.id === permitId)
    if (!permit) return { ok: false, reason: '许可不存在' }
    if (permit.revision !== baseRevision) {
      const reason = `版本过期：操作基于 r${baseRevision}，当前为 r${permit.revision}，未覆盖新状态`
      addPending('版本过期', `${permitId} 操作被驳回`, reason, permitId, [permitId])
      addAudit('系统', '驳回过期操作', permitId, reason)
      return { ok: false, reason }
    }
    applyOp(kind, permitId, payload)
    permit.revision += 1
    recalculate(permitId)
    persist()
    return { ok: true }
  }

  // ---------- 对外操作入口：在线直接走管线，断网进 outbox ----------
  function toggleStep(permitId: string, stepId: string) {
    const permit = permits.value.find((p) => p.id === permitId)
    const step = permit?.steps.find((s) => s.id === stepId)
    if (!permit || !step) return
    const nextDone = !step.done
    if (connection.value === '重连中') return queueOp('step', permitId, { stepId, done: nextDone })
    mutate('step', permitId, { stepId, done: nextDone }, permit.revision)
  }

  function advancePermit(permitId: string) {
    const permit = permits.value.find((p) => p.id === permitId)
    if (!permit) return
    if (permit.status === '待复核' && permit.reviewRequired && !confirm('该许可存在待复核冲突，确认由值班负责人承担审批责任？')) return
    if (connection.value === '重连中') return queueOp('advance', permitId, {})
    mutate('advance', permitId, {}, permit.revision)
  }

  function changePointState(permitId: string, pointId: string, state: PointState) {
    const permit = permits.value.find((p) => p.id === permitId)
    if (!permit) return
    if (connection.value === '重连中') return queueOp('isolation', permitId, { pointId, state })
    mutate('isolation', permitId, { pointId, state }, permit.revision)
  }

  function addPermit(permit: Permit) {
    permits.value.unshift(permit)
    addAudit('当前用户', '新建许可', permit.id, permit.title)
    recalculate(permit.id)
    persist()
  }

  function acceptAlert() {
    latestAlert.value = ''
    addAudit('值班负责人', '确认冲突', '跨班组重叠', '同意调整 LINE-A2 作业时间，不允许同时开工')
  }

  // ---------- 连接状态 ----------
  function markOffline() {
    connection.value = '重连中'
    addAudit('系统', '连接中断', '实时通道', '本机步骤与推进意图开始暂存')
  }
  function markOnline() {
    connection.value = '在线'
    addAudit('系统', '连接恢复', '实时通道', '开始按序合并本机暂存操作')
    flushOutbox()
  }
  function toggleConnection() {
    if (connection.value === '在线') markOffline()
    else markOnline()
  }

  restore()
  return {
    permits, audit, pendingItems, outbox, connection, latestAlert, loaded,
    toggleStep, advancePermit, changePointState, addPermit, acceptAlert,
    resolvePending, flushOutbox, toggleConnection, restore,
  }
})
