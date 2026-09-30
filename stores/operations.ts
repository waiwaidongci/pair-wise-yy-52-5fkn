import { defineStore } from 'pinia'
import type {
  AuditEvent, FollowUp, Permit, QueuedOp, RemoteChange, RemoteIntent,
} from '~/types'
import { auditEvents as seedAudit, permits as seedPermits, seedAlert } from '~/utils/mock'
import { boundarySignature, nowLabel, recompute, STATUS_FLOW } from '~/utils/recompute'
import { coordinationSignature, replayOutbox, staleFollowUp } from '~/utils/sync'
import { loadLocalState, saveLocalState } from '~/utils/migration'

interface ChainInput { permits: Permit[]; followUps: FollowUp[] }
type Mutator = (input: ChainInput) => ChainInput & { audit: Omit<AuditEvent, 'id' | 'time'>[] }

export const useOperationsStore = defineStore('operations', () => {
  const permits = ref<Permit[]>([])
  const audit = ref<AuditEvent[]>([])
  const followUps = ref<FollowUp[]>([])
  const outbox = ref<QueuedOp[]>([])
  const remoteChanges = ref<RemoteChange[]>([])
  const remoteIntents = ref<RemoteIntent[]>([])
  const remoteBase = ref<Permit[] | null>(null)
  const connection = ref<'在线' | '重连中'>('在线')
  const latestAlert = ref(seedAlert)
  const loaded = ref(false)

  const pendingRetry = computed(() => outbox.value.length)

  // ---------------------------------------------------------------- 持久化
  function persist() {
    saveLocalState({
      version: 2,
      permits: permits.value,
      audit: audit.value,
      followUps: followUps.value,
      outbox: outbox.value,
      remoteChanges: remoteChanges.value,
      remoteBase: remoteBase.value,
      remoteState: null,
      latestAlert: latestAlert.value,
      remoteIntents: remoteIntents.value,
    })
  }

  function addAudit(actor: string, action: string, target: string, detail: string) {
    audit.value.unshift({ id: `AE-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, time: nowLabel(), actor, action, target, detail })
  }

  /**
   * 唯一重算链路入口：
   * 本机步骤/状态/隔离点变更与对端合入都先落数据，再以全量许可重算冲突、
   * 退回复核、作废旧边界结果、生成待处理项，并逐事件留痕。
   */
  function runChain(mutator: Mutator) {
    const mutated = mutator({
      permits: structuredClone(permits.value),
      followUps: structuredClone(followUps.value),
    })
    const result = recompute(mutated.permits, mutated.followUps)

    permits.value = result.permits
    followUps.value = mutated.followUps
    for (const event of mutated.audit) addAudit(event.actor, event.action, event.target, event.detail)
    for (const effect of result.effects) {
      addAudit('系统', '退回复核', effect.permitId, effect.reason)
      latestAlert.value = `${effect.permitId} 已被重算退回「待复核」：${effect.reason}`
    }
    for (const item of result.invalidatedSteps) {
      addAudit('系统', '结果作废', `${item.permitId} / ${item.stepId}`, item.reason)
    }
    for (const change of result.followUpChanges) {
      if (change.action === 'upsert') {
        addAudit('系统', change.followUp.status === '待处理' ? '待协调项重开' : '待处理项', change.followUp.title, change.followUp.detail)
      }
    }
    persist()
  }

  // ---------------------------------------------------------------- 装载 / 升级
  function restore() {
    if (!import.meta.client || loaded.value) return
    const state = loadLocalState({ permits: seedPermits, audit: seedAudit, latestAlert: seedAlert })
    permits.value = state.permits!
    audit.value = state.audit!
    followUps.value = state.followUps ?? []
    outbox.value = state.outbox ?? []
    remoteChanges.value = state.remoteChanges ?? []
    remoteIntents.value = state.remoteIntents ?? []
    remoteBase.value = state.remoteBase ?? null
    latestAlert.value = state.latestAlert ?? seedAlert

    // 升级或冷启动：静默结算一次当前冲突/作废状态，不产生级联事件；
    // 但未决硬冲突沉淀出的协调项需要进入状态（种子数据本身不带待处理项）
    const silentFollow = structuredClone(followUps.value)
    const silent = recompute(permits.value, silentFollow, { silent: true })
    permits.value = silent.permits
    followUps.value = silentFollow
    const seedConflicts = silentFollow.filter((item) => item.kind === '冲突协调' && item.status === '待处理').length
    if (seedConflicts) {
      addAudit('系统', '重算结算', '共享隔离边界', `装载时重算发现 ${seedConflicts} 项未协调的跨班组共享边界冲突，已生成待处理项`)
    }
    if (state.migrated) {
      addAudit('系统', '数据升级', '本地许可数据', '检测到旧版本地许可数据，已自动补齐隔离资源/冲突/作废字段并完成重算，原数据保留为 .bak')
    }
    if (remoteBase.value) connection.value = '重连中'
    loaded.value = true
    persist()
  }

  // ---------------------------------------------------------------- 业务动作
  function queueOffline(op: Omit<QueuedOp, 'id' | 'createdAt'>) {
    outbox.value.push({ ...op, id: `Q-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, createdAt: new Date().toISOString() })
  }

  function advancePermit(id: string) {
    const permit = permits.value.find((item) => item.id === id)
    if (!permit) return
    if (permit.reviewRequired) {
      latestAlert.value = `${id} 存在未协调冲突或已作废的旧边界结果，不能推进，请先由值班负责人复核协调`
      return
    }
    const from = permit.status
    const baseRevision = permit.revision
    const mutate: Mutator = ({ permits: list, followUps }) => {
      const target = list.find((item) => item.id === id)!
      const index = STATUS_FLOW.indexOf(target.status)
      if (index < 0 || index >= STATUS_FLOW.length - 1) return { permits: list, followUps, audit: [] }
      target.status = STATUS_FLOW[index + 1]!
      target.revision += 1
      return {
        permits: list, followUps,
        audit: [{ actor: '当前用户', action: '流程推进', target: id, detail: `状态由“${from}”变更为“${target.status}”（r${baseRevision} → r${target.revision}）` }],
      }
    }
    if (connection.value === '重连中') {
      queueOffline({ type: 'advance', permitId: id, baseRevision, label: `${id} ${from} 推进`, payload: {} })
      runChain((input) => {
        const r = mutate(input)
        addAudit('本机', '离线暂存', id, `断线期间推进意图已入队（基于 r${baseRevision}），重连后按版本合并`)
        return r
      })
      return
    }
    runChain(mutate)
  }

  function toggleStep(permitId: string, stepId: string) {
    const permit = permits.value.find((item) => item.id === permitId)
    const step = permit?.steps.find((item) => item.id === stepId)
    if (!permit || !step) return
    const done = !step.done
    const baseRevision = permit.revision

    const mutate: Mutator = ({ permits: list, followUps }) => {
      const target = list.find((item) => item.id === permitId)!
      const targetStep = target.steps.find((item) => item.id === stepId)!
      targetStep.done = done
      if (done && targetStep.dependsOnBoundary) {
        targetStep.boundaryAtCompletion = boundarySignature(target)
        targetStep.completedAt = nowLabel()
        targetStep.invalidated = false
        delete targetStep.invalidateReason
      } else if (!done) {
        delete targetStep.boundaryAtCompletion
        delete targetStep.completedAt
        targetStep.invalidated = false
        delete targetStep.invalidateReason
      }
      target.revision += 1
      return {
        permits: list, followUps,
        audit: [{
          actor: '当前用户', action: done ? '完成步骤' : '撤销步骤', target: `${permitId} / ${stepId}`,
          detail: done && targetStep.dependsOnBoundary
            ? `${targetStep.text}（按当前隔离边界确认，边界变更后该结果自动作废）`
            : targetStep.text,
        }],
      }
    }

    if (connection.value === '重连中') {
      queueOffline({ type: 'toggle-step', permitId, baseRevision, label: `${stepId} ${done ? '完成' : '撤销'}`, payload: { stepId, done, at: nowLabel() } })
      runChain((input) => {
        const r = mutate(input)
        addAudit('本机', '离线暂存', `${permitId} / ${stepId}`, `步骤确认已入本机队列（基于 r${baseRevision}）`)
        return r
      })
      return
    }
    runChain(mutate)
  }

  /** 隔离点三态切换：隔离边界一变，所有占用该资源的许可立即进入同一条重算链路 */
  function setPointState(permitId: string, pointId: string, state: Permit['isolationPoints'][number]['state']) {
    const permit = permits.value.find((item) => item.id === permitId)
    const point = permit?.isolationPoints.find((item) => item.id === pointId)
    if (!permit || !point) return
    const baseRevision = permit.revision
    const mutate: Mutator = ({ permits: list, followUps }) => {
      const target = list.find((item) => item.id === permitId)!
      const targetPoint = target.isolationPoints.find((item) => item.id === pointId)!
      targetPoint.state = state
      target.revision += 1
      return {
        permits: list, followUps,
        audit: [{ actor: '当前用户', action: '隔离点操作', target: `${permitId} / ${pointId}`, detail: `${targetPoint.label}（${targetPoint.resource}）状态变更为“${state}”，触发占用重算` }],
      }
    }
    if (connection.value === '重连中') {
      queueOffline({ type: 'set-point', permitId, baseRevision, label: `${point.label} → ${state}`, payload: { pointId, state } })
      runChain((input) => {
        const r = mutate(input)
        addAudit('本机', '离线暂存', `${permitId} / ${pointId}`, `隔离点操作已入本机队列（基于 r${baseRevision}）`)
        return r
      })
      return
    }
    runChain(mutate)
  }

  function cyclePoint(permitId: string, pointId: string) {
    const point = permits.value.find((item) => item.id === permitId)?.isolationPoints.find((item) => item.id === pointId)
    if (!point) return
    const next = point.state === '待操作' ? '已隔离' : point.state === '已隔离' ? '已恢复' : '待操作'
    setPointState(permitId, pointId, next)
  }

  function addPermit(permit: Permit) {
    runChain(({ permits: list, followUps }) => {
      if (list.some((item) => item.id === permit.id)) return { permits: list, followUps, audit: [] }
      return {
        permits: [structuredClone(permit), ...list], followUps,
        audit: [{ actor: '当前用户', action: '新建许可', target: permit.id, detail: permit.title }],
      }
    })
  }

  /** 值班负责人对某一共用资源冲突给出协调放行（记录边界快照，边界再变则失效） */
  function coordinate(followUpId: string, resolution: string) {
    const followUp = followUps.value.find((item) => item.id === followUpId)
    if (!followUp || followUp.status !== '待处理') return
    const { title, resource } = followUp
    runChain(({ permits: list, followUps: nextFollowUps }) => {
      const record = nextFollowUps.find((item) => item.id === followUpId)!
      record.status = '已协调'
      record.resolvedAt = nowLabel()
      record.resolution = resolution
      record.resourceSet = [...new Set(list.filter((p) => record.permitIds.includes(p.id)).flatMap((p) => p.isolationPoints.map((point) => point.resource)))]
      record.signature = coordinationSignature(list, record.permitIds, resource!)
      return {
        permits: list, followUps: nextFollowUps,
        audit: [{ actor: '值班负责人', action: '冲突协调', target: title, detail: `${resolution}；锁定 ${resource} 边界快照，边界再变本决策自动失效` }],
      }
    })
  }

  function resolveFollowUp(id: string, resolution: string) {
    const followUp = followUps.value.find((item) => item.id === id)
    if (!followUp || followUp.status === '已关闭') return
    followUp.status = '已关闭'
    followUp.resolvedAt = nowLabel()
    followUp.resolution = resolution
    addAudit('值班负责人', '关闭待处理项', followUp.title, resolution)
    persist()
  }

  function acceptAlert() {
    const pending = followUps.value.find((item) => item.status === '待处理' && item.kind === '冲突协调')
    if (pending) {
      coordinate(pending.id, '同意按先后顺序作业，共用母线隔离边界由值班负责人统一发布，不允许同时开工')
    } else {
      latestAlert.value = ''
    }
  }

  // ---------------------------------------------------------------- 断线 / 重连
  function markOffline() {
    if (connection.value === '重连中') return
    connection.value = '重连中'
    remoteBase.value = structuredClone(permits.value)
    remoteIntents.value = []
    addAudit('系统', '连接中断', '实时通道', '进入离线模式：本机步骤与推进意图暂存本地，重连后按顺序合并')
    persist()
  }

  /** 离线期间登记一条「对端班组推进意图」，重连时作为服务器新状态到达 */
  function simulateRemoteIntent() {
    if (connection.value !== '重连中') return
    const scenarios: Array<() => RemoteIntent | null> = [
      () => {
        const target = permits.value.find((p) => p.id === 'WP-260929-018')
        const point = target?.isolationPoints.find((p) => p.id === 'IP-304')
        if (!target || !point || point.state !== '已恢复') return null
        return { id: `RI-${Date.now().toString(36)}`, permitId: target.id, kind: 'point-state', pointId: point.id, state: '已隔离', actor: '线路一班 / 孙禾', description: '对端已把 BUS-A 母线侧隔离刀闸 IP-304 操作至「已隔离」', at: new Date().toISOString() }
      },
      () => {
        const target = permits.value.find((p) => p.id === 'WP-260930-004')
        const point = target?.isolationPoints.find((p) => p.id === 'IP-501')
        if (!target || !point || point.state !== '待操作') return null
        return { id: `RI-${Date.now().toString(36)}`, kind: 'point-state', pointId: point.id, state: '已隔离', actor: '电气一班 / 孙禾', description: '对端已断开 BOX-12 高压负荷开关 IP-501 并锁定', at: new Date().toISOString() }
      },
    ]
    const used = new Set(remoteIntents.value.map((item) => `${item.permitId}:${item.kind}:${item.pointId ?? ''}`))
    for (const build of scenarios) {
      const intent = build()
      if (!intent) continue
      const key = `${intent.permitId}:${intent.kind}:${intent.pointId ?? ''}`
      if (used.has(key)) continue
      remoteIntents.value.push(intent)
      addAudit('对端', '推进意图到达（缓存）', intent.permitId ?? '许可', `${intent.description}，将在重连合并时生效`)
      persist()
      return intent
    }
    latestAlert.value = '预置的对端变更场景均已登记，重连即可查看合并结果'
    return null
  }

  function applyIntent(state: Permit[], intent: RemoteIntent): Permit[] {
    const next = state.map((permit) => structuredClone(permit))
    const permit = next.find((item) => item.id === intent.permitId)
    if (!permit) return state
    const fromRevision = permit.revision
    if (intent.kind === 'point-state') {
      const point = permit.isolationPoints.find((item) => item.id === intent.pointId)
      if (!point) return state
      point.state = intent.state!
    } else if (intent.kind === 'toggle-step') {
      const step = permit.steps.find((item) => item.id === intent.stepId)
      if (!step) return state
      step.done = Boolean(intent.done)
    } else if (intent.kind === 'advance') {
      const index = STATUS_FLOW.indexOf(permit.status)
      if (index < 0 || index >= STATUS_FLOW.length - 1) return state
      permit.status = STATUS_FLOW[index + 1]!
    }
    permit.revision += 1
    remoteChanges.value.push({
      id: `RC-${intent.id}`, permitId: intent.permitId!, actor: intent.actor,
      description: intent.description, at: nowLabel(), fromRevision, toRevision: permit.revision,
    })
    return next
  }

  /** 重连：对端变更先到 → 本机 outbox 按顺序合并 → 过期版本不覆盖 → 统一重算 */
  function reconnect() {
    if (connection.value !== '重连中') { connection.value = '在线'; return }

    // 1) 以断线时快照为基线，先应用对端在断网期间的推进
    let server = structuredClone(remoteBase.value ?? permits.value)
    for (const intent of [...remoteIntents.value].sort((a, b) => a.at.localeCompare(b.at))) {
      server = applyIntent(server, intent)
    }

    // 2) 本机步骤与推进意图按时间顺序合并，版本过期的操作不覆盖新状态
    const outcome = replayOutbox(server, remoteBase.value, outbox.value)
    for (const { op } of outcome.applied) {
      addAudit('本机', '离线操作合并', op.permitId, `${op.label} 已按顺序合并（基于 r${op.baseRevision}）`)
    }

    // 3) 过期操作转「待负责人协调」，绝不静默丢弃
    for (const { op, reason } of outcome.rejected) {
      followUps.value = staleFollowUp(op, reason, followUps.value, nowLabel)
      addAudit('系统', '版本过期拦截', op.permitId, `${op.label} 被拒绝覆盖：${reason}`)
      latestAlert.value = `${op.permitId} 的离线操作因版本过期未覆盖新状态，已生成待处理项`
    }

    // 4) 合入结果统一过重算链路
    const clonedFollow = structuredClone(followUps.value)
    const result = recompute(outcome.state, clonedFollow)
    permits.value = result.permits
    followUps.value = clonedFollow
    for (const effect of result.effects) {
      addAudit('系统', '退回复核', effect.permitId, `重连合并后重算：${effect.reason}`)
      latestAlert.value = `${effect.permitId} 重连后被退回「待复核」：${effect.reason}`
    }
    for (const item of result.invalidatedSteps) addAudit('系统', '结果作废', `${item.permitId} / ${item.stepId}`, item.reason)
    for (const change of result.followUpChanges) {
      if (change.action === 'upsert') addAudit('系统', '待处理项', change.followUp.title, '重连合并后冲突仍然存在')
    }

    const mergedCount = outcome.applied.length
    const rejectedCount = outcome.rejected.length
    addAudit('系统', '重连完成', '实时通道', `按顺序合并 ${mergedCount} 项本机操作、${remoteIntents.value.length} 项对端推进；${rejectedCount} 项版本过期已转待处理`)
    connection.value = '在线'
    outbox.value = []
    remoteIntents.value = []
    remoteBase.value = null
    persist()
  }

  function markOnline() { reconnect() }
  function retryPending() { reconnect() }

  restore()
  return {
    permits, audit, followUps, outbox, remoteChanges, remoteIntents, connection, latestAlert, pendingRetry,
    restore, advancePermit, toggleStep, setPointState, cyclePoint, addPermit, coordinate, resolveFollowUp,
    acceptAlert, markOffline, markOnline, reconnect, simulateRemoteIntent, retryPending,
  }
})
