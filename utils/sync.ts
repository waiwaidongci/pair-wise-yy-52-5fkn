import type { FollowUp, Permit, QueuedOp } from '../types'
import { boundarySignature, STATUS_FLOW } from './recompute'

/**
 * 断网恢复后的顺序合并：
 *  - 对端变更已经把服务器推进到新版本；
 *  - 本机 outbox 按时间顺序逐条重放，每条都以「操作发起时所依据的版本」做门槛：
 *      * 许可已被对端推进到更新版本 → 过期操作不得覆盖新状态，留下待处理项；
 *      * 版本一致 → 快进合并；
 *      * 对端改了别的隔离点/步骤 → 三路合并，本机步骤保留。
 */

export interface ReplayOutcome {
  state: Permit[]
  /** 实际应用的操作（其附带的步骤完成需在重算时按新边界校验） */
  applied: { op: QueuedOp }[]
  /** 版本过期、被拒绝覆盖的操作，转待处理项 */
  rejected: { op: QueuedOp; reason: string; remote: Permit }[]
}

function applyMutation(state: Permit[], op: QueuedOp): Permit[] {
  const next = state.map((permit) => structuredClone(permit))
  const permit = next.find((item) => item.id === op.permitId)
  if (!permit) return state
  const payload = op.payload as Record<string, unknown>

  if (op.type === 'advance') {
    const index = STATUS_FLOW.indexOf(permit.status)
    if (index < 0 || index >= STATUS_FLOW.length - 1) return state
    permit.status = STATUS_FLOW[index + 1]!
  } else if (op.type === 'toggle-step') {
    const step = permit.steps.find((item) => item.id === payload.stepId)
    if (!step) return state
    step.done = Boolean(payload.done)
    if (step.done && step.dependsOnBoundary) {
      step.boundaryAtCompletion = boundarySignature(permit)
      step.completedAt = payload.at as string
      step.invalidated = false
    } else if (!step.done) {
      delete step.boundaryAtCompletion
      delete step.completedAt
      step.invalidated = false
    }
  } else if (op.type === 'set-point') {
    const point = permit.isolationPoints.find((item) => item.id === payload.pointId)
    if (!point) return state
    point.state = payload.state as Permit['isolationPoints'][number]['state']
  } else if (op.type === 'add-permit') {
    if (state.some((item) => item.id === op.permitId)) return state
    next.unshift(payload.permit as Permit)
  }
  permit.revision += 1
  return next
}

/**
 * 对比断线基线与对端推进后的服务器状态，得出每个许可被对端改动的字段集合：
 * status / step:<id> / point:<id>。本机操作只在对端触碰同一字段时才算过期。
 */
export function remoteFieldChanges(snapshot: Permit[], server: Permit[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const remote of server) {
    const base = snapshot.find((item) => item.id === remote.id)
    if (!base || remote.revision <= base.revision) continue
    const fields = new Set<string>()
    if (remote.status !== base.status) fields.add('status')
    for (const point of remote.isolationPoints) {
      const before = base.isolationPoints.find((item) => item.id === point.id)
      if (before && before.state !== point.state) fields.add(`point:${point.id}`)
    }
    for (const step of remote.steps) {
      const before = base.steps.find((item) => item.id === step.id)
      if (before && before.done !== step.done) fields.add(`step:${step.id}`)
    }
    if (fields.size) map.set(remote.id, fields)
  }
  return map
}

export function replayOutbox(initial: Permit[], snapshot: Permit[] | null, outbox: QueuedOp[]): ReplayOutcome {
  let state = initial.map((permit) => structuredClone(permit))
  const applied: ReplayOutcome['applied'] = []
  const rejected: ReplayOutcome['rejected'] = []
  const remoteChanges = remoteFieldChanges(snapshot ?? [], state)

  const opField = (op: QueuedOp): string => {
    const payload = op.payload as Record<string, unknown>
    if (op.type === 'advance') return 'status'
    if (op.type === 'toggle-step') return `step:${payload.stepId}`
    if (op.type === 'set-point') return `point:${payload.pointId}`
    return ''
  }

  for (const op of [...outbox].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const remote = state.find((item) => item.id === op.permitId)
    if (op.type === 'add-permit') {
      state = applyMutation(state, op)
      applied.push({ op })
      continue
    }
    const base = snapshot?.find((item) => item.id === op.permitId)
    // 版本门槛：对端已越过本机基线且改动了同一字段 → 过期操作不得覆盖新状态
    if (base && remote && remote.revision > op.baseRevision && remoteChanges.get(remote.id)?.has(opField(op))) {
      rejected.push({
        op,
        reason: `该操作基于 r${op.baseRevision}，对端已把许可推进到 r${remote.revision} 并改动了同一字段（当前状态：${remote.status}），旧版本操作未覆盖新状态`,
        remote,
      })
      continue
    }
    // 推进意图本身有业务前提：冲突/作废未清前不允许借重连推进
    if (op.type === 'advance' && remote?.reviewRequired) {
      rejected.push({ op, reason: '许可已被重算退回「待复核」，断线期间的推进意图作废，需负责人重新确认', remote })
      continue
    }
    state = applyMutation(state, op)
    applied.push({ op })
  }

  return { state, applied, rejected }
}

/** 协调决策签名：资源相关各许可在该资源上的实时占用快照 */
export function coordinationSignature(permits: Permit[], permitIds: string[], resource: string): string {
  return permitIds
    .slice()
    .sort()
    .map((id) => {
      const permit = permits.find((item) => item.id === id)
      const sig = permit ? permit.isolationPoints
        .filter((point) => point.resource === resource && point.state !== '已恢复')
        .map((point) => `${point.id}:${point.state}`)
        .sort()
        .join('|') : ''
      return `${id}:${sig}`
    })
    .join('//')
}

export function staleFollowUp(op: QueuedOp, reason: string, followUps: FollowUp[], clock: () => string): FollowUp[] {
  const next = followUps.map((item) => ({ ...item }))
  next.push({
    id: `FU-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind: '版本过期',
    status: '待处理',
    title: `版本过期操作待确认：${op.label}`,
    detail: reason,
    permitIds: [op.permitId],
    owner: '值班负责人',
    createdAt: clock(),
  })
  return next
}
