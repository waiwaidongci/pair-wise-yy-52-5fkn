import type { ConflictInfo, FollowUp, Permit, PermitStatus } from '../types'

/**
 * 单一重算链路：许可、隔离点占用、班组占用统一重算。
 *
 * 任何一次本机变更或对端变更合入后，都以当前全部许可为输入整体重算，
 * 不保留任何“按旧边界预判”的缓存结果：
 *  1. 跨班组共用同一隔离资源、且作业窗口重叠  → 硬冲突，许可立即退回「待复核」；
 *  2. 同班组资源重叠 / 同班组窗口重叠          → 软冲突，仅提示；
 *  3. 完成于旧边界的步骤                      → 结果作废，已完成许可同样退回；
 *  4. 协调决策与当前边界签名不一致            → 决策失效，重新退回；
 *  5. 未决硬冲突自动生成「待负责人协调」项。
 */

export const STATUS_FLOW: PermitStatus[] = ['待复核', '待执行', '执行中', '待结束', '待关闭', '已完成']
const ACTIVE_STATUSES: PermitStatus[] = ['待复核', '待执行', '执行中', '待结束', '待关闭']

export function nowLabel(date = new Date()): string {
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

/** "09-29 18:00" → 该日期在当年内的分钟序数；"02:00" 形式配合 startMonth/startDay 继承日期 */
function momentValue(raw: string, inherit?: { month: number; day: number }): number | null {
  const full = /(\d{2})-(\d{2})[ T]+(\d{1,2}):(\d{2})/.exec(raw.trim())
  if (full) {
    const [, month, day, hour, minute] = full
    return Number(month) * 44640 + Number(day) * 1440 + Number(hour) * 60 + Number(minute)
  }
  const short = /(\d{1,2}):(\d{2})/.exec(raw.trim())
  if (short && inherit) {
    return inherit.month * 44640 + inherit.day * 1440 + Number(short[1]) * 60 + Number(short[2])
  }
  return null
}

/** 解析 "09-29 18:00 — 30 02:00" 或 "09-29 18:00 — 02:00" 形式的作业窗口 */
export function windowRange(window: string): { start: number; end: number } | null {
  const parts = window.split(/\s+—\s+/)
  const start = parts[0] ? momentValue(parts[0]) : null
  if (start == null) return null
  const startMatch = /(\d{2})-(\d{2})/.exec(parts[0] ?? '')
  const inherit = startMatch ? { month: Number(startMatch[1]), day: Number(startMatch[2]) } : undefined
  const endRaw = parts[1]?.trim()
  let end = endRaw ? momentValue(endRaw, inherit) : null
  // "— 30 02:00" 跨日简写
  if (end == null && endRaw) {
    const cross = /(\d{1,2})[ T]+(\d{1,2}):(\d{2})/.exec(endRaw)
    if (cross && inherit) end = inherit.month * 44640 + Number(cross[1]) * 1440 + Number(cross[2]) * 60 + Number(cross[3])
  }
  if (end == null) return null
  return { start, end: end <= start ? end + 1440 : end }
}

export function windowsOverlap(a: Permit, b: Permit): boolean {
  const ra = windowRange(a.window)
  const rb = windowRange(b.window)
  if (!ra || !rb) return false
  return ra.start < rb.end && rb.start < ra.end
}

/** 某许可在某个隔离资源上的实时占用签名：只统计真正落地的隔离操作 */
export function resourceSignature(permit: Permit, resource: string): string {
  return permit.isolationPoints
    .filter((point) => point.resource === resource && point.state !== '已恢复')
    .map((point) => `${point.id}:${point.state}`)
    .sort()
    .join('|')
}

/** 许可对其全部隔离边界的当前签名 */
export function boundarySignature(permit: Permit): string {
  return permit.isolationPoints
    .map((point) => `${point.id}@${point.state}`)
    .sort()
    .join('|')
}

export function isActive(permit: Permit): boolean {
  return ACTIVE_STATUSES.includes(permit.status)
}

interface ResourceOccupancy {
  permit: Permit
  resource: string
  isolated: boolean
}

export interface RecomputeEffect {
  type: 'rollback'
  permitId: string
  fromStatus: PermitStatus
  toStatus: PermitStatus
  reason: string
  resource?: string
  otherPermitId?: string
}

export interface FollowUpChange {
  action: 'upsert' | 'resolve'
  followUp: FollowUp
}

export interface RecomputeResult {
  permits: Permit[]
  effects: RecomputeEffect[]
  followUpChanges: FollowUpChange[]
  /** 本轮被作废的步骤（许可 → 步骤），供调用方留痕 */
  invalidatedSteps: { permitId: string; stepId: string; reason: string }[]
}

export interface RecomputeOptions {
  /** 系统首次装载/数据升级时使用：只结算一次当前状态，不生成级联事件 */
  silent?: boolean
  clock?: () => string
}

export function recompute(input: Permit[], followUps: FollowUp[], options: RecomputeOptions = {}): RecomputeResult {
  const clock = options.clock ?? nowLabel
  const permits = input.map((permit) => structuredClone(permit))
  const effects: RecomputeEffect[] = []
  const invalidatedSteps: { permitId: string; stepId: string; reason: string }[] = []

  // ---------- 1. 隔离资源占用图（已恢复点释放边界，不再占用该资源） ----------
  const resourceMap = new Map<string, ResourceOccupancy[]>()
  for (const permit of permits) {
    if (!isActive(permit)) continue
    for (const resource of new Set(
      permit.isolationPoints.filter((point) => point.state !== '已恢复').map((point) => point.resource),
    )) {
      const list = resourceMap.get(resource) ?? []
      list.push({ permit, resource, isolated: permit.isolationPoints.some((p) => p.resource === resource && p.state === '已隔离') })
      resourceMap.set(resource, list)
    }
  }

  // ---------- 2. 两两检查：跨班组共用资源硬冲突、同班组软冲突 ----------
  const hardByPermit = new Map<string, ConflictInfo[]>()
  const softByPermit = new Map<string, ConflictInfo[]>()
  for (const [resource, occupancies] of resourceMap) {
    for (let i = 0; i < occupancies.length; i += 1) {
      for (let j = i + 1; j < occupancies.length; j += 1) {
        const a = occupancies[i]!.permit
        const b = occupancies[j]!.permit
        if (!windowsOverlap(a, b)) continue
        const states = [
          a.isolationPoints.find((p) => p.resource === resource)!.state,
          b.isolationPoints.find((p) => p.resource === resource)!.state,
        ]
        const shared = a.crew === b.crew
        const reason = `${a.crew}${a.id} 与 ${b.crew}${b.id} 在 ${a.window.split(' — ')[0]} 起的窗口内共用 ${resource}（${states.join(' / ')}）`
        for (const [self, other] of [[a, b], [b, a]] as const) {
          const info: ConflictInfo = {
            kind: 'shared-resource',
            severity: shared ? 'soft' : 'hard',
            resource,
            otherPermitId: other.id,
            otherCrew: other.crew,
            reason,
          }
          const bucket = shared ? softByPermit : hardByPermit
          bucket.set(self.id, [...(bucket.get(self.id) ?? []), info])
        }
      }
    }
  }

  // ---------- 3. 班组占用：同一班组作业窗口重叠（非同一资源） ----------
  const active = permits.filter(isActive)
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i]!
      const b = active[j]!
      if (a.crew !== b.crew || !windowsOverlap(a, b)) continue
      const sharedResource = a.isolationPoints.some((pa) => b.isolationPoints.some((pb) => pb.resource === pa.resource))
      if (sharedResource) continue // 已作为资源冲突登记
      const reason = `${a.crew} 班组 ${a.id} 与 ${b.id} 作业窗口重叠，人力与交接需统一安排`
      const push = (self: Permit, other: Permit) => {
        const info: ConflictInfo = { kind: 'crew-overlap', severity: 'soft', otherPermitId: other.id, otherCrew: other.crew, reason }
        softByPermit.set(self.id, [...(softByPermit.get(self.id) ?? []), info])
      }
      push(a, b)
      push(b, a)
    }
  }

  // ---------- 4. 协调决策是否仍与当前边界一致 ----------
  function coordinationValid(permit: Permit, conflict: ConflictInfo): boolean {
    const decision = followUps.find(
      (item) => item.status === '已协调' && item.kind === '冲突协调' && item.resource === conflict.resource
        && item.permitIds.includes(permit.id) && item.permitIds.includes(conflict.otherPermitId),
    )
    if (!decision) return false
    if (!decision.signature) return false
    const current = decision.permitIds
      .map((id) => {
        const target = permits.find((p) => p.id === id)
        return target ? `${id}:${resourceSignature(target, conflict.resource!)}` : id
      })
      .join('//')
    return current === decision.signature
  }

  const followUpChanges: FollowUpChange[] = []
  const touchedResourceKeys = new Set<string>()

  for (const permit of permits) {
    const hard = hardByPermit.get(permit.id) ?? []
    const soft = softByPermit.get(permit.id) ?? []

    // ---------- 5. 完成结果是否基于旧边界 ----------
    const liveBoundary = boundarySignature(permit)
    let boundaryStale = false
    for (const step of permit.steps) {
      if (!step.dependsOnBoundary || !step.done) continue
      if (step.boundaryAtCompletion && step.boundaryAtCompletion === liveBoundary) {
        if (step.invalidated) {
          step.invalidated = false
          delete step.invalidateReason
        }
        continue
      }
      if (!options.silent && !step.invalidated) {
        invalidatedSteps.push({ permitId: permit.id, stepId: step.id, reason: '隔离边界在步骤完成后发生变化，旧边界下的确认结果作废，需重新验电/核位' })
      }
      step.invalidated = true
      step.invalidateReason = '隔离边界已变化，需按新边界重新确认'
      boundaryStale = true
    }

    const unresolved = hard.filter((conflict) => !coordinationValid(permit, conflict))
    permit.conflicts = [...hard, ...soft]
    permit.boundaryStale = boundaryStale

    const mustReview = unresolved.length > 0 || boundaryStale
    permit.reviewRequired = mustReview

    // ---------- 6. 受影响许可立即退回「待复核」；旧边界完成结果作废后已完成许可也退回 ----------
    if (mustReview && permit.status !== '待复核') {
      const leading = unresolved[0]
      const reason = boundaryStale && !unresolved.length
        ? '隔离边界变化，依赖旧边界的完成结果已作废，退回重新复核'
        : `与 ${leading ? `${leading.otherCrew}${leading.otherPermitId}` : '其他班组'} 在 ${leading?.resource ?? '共用边界'} 上存在未协调冲突，退回复核`
      if (!options.silent) {
        effects.push({ type: 'rollback', permitId: permit.id, fromStatus: permit.status, toStatus: '待复核', reason, resource: leading?.resource, otherPermitId: leading?.otherPermitId })
      }
      permit.status = '待复核'
    }

    // ---------- 7. 未决硬冲突沉淀为「待负责人协调」项（同一资源合并为一项） ----------
    for (const conflict of unresolved) {
      if (!conflict.resource || touchedResourceKeys.has(conflict.resource)) continue
      touchedResourceKeys.add(conflict.resource)

      // 收集该资源上当前全部未决成员与原因（跨所有许可视角，避免首个许可看不到旧协调项）
      const memberSet = new Set<string>()
      const reasons = new Set<string>()
      for (const holder of permits) {
        for (const hard of hardByPermit.get(holder.id) ?? []) {
          if (hard.resource !== conflict.resource) continue
          if (coordinationValid(holder, hard)) continue
          memberSet.add(holder.id)
          memberSet.add(hard.otherPermitId)
          reasons.add(hard.reason)
        }
      }
      const existing = followUps.find(
        (item) => item.kind === '冲突协调' && item.resource === conflict.resource
          && item.permitIds.some((id) => memberSet.has(id)),
      )
      const ids = [...memberSet].sort()
      if (existing) {
        // 新班组卷入同一资源冲突时，扩充协调项范围；已协调的决策随边界失效
        let expanded = false
        for (const id of ids) {
          if (!existing.permitIds.includes(id)) { existing.permitIds.push(id); expanded = true }
        }
        existing.permitIds.sort()
        existing.detail = [...reasons].join('；')
        if (existing.status === '已协调') {
          existing.status = '待处理'
          existing.resolvedAt = undefined
          existing.resolution = undefined
          existing.signature = undefined
          existing.owner = '值班负责人'
          followUpChanges.push({ action: 'upsert', followUp: existing })
        } else if (expanded && !options.silent) {
          followUpChanges.push({ action: 'upsert', followUp: existing })
        }
      } else {
        const followUp: FollowUp = {
          id: `FU-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          kind: '冲突协调',
          status: '待处理',
          title: `共用 ${conflict.resource} 跨班组冲突需协调`,
          detail: [...reasons].join('；'),
          permitIds: ids,
          resource: conflict.resource,
          owner: '值班负责人',
          createdAt: clock(),
        }
        followUps.push(followUp)
        followUpChanges.push({ action: 'upsert', followUp })
      }
    }
  }

  return { permits, effects, followUpChanges, invalidatedSteps }
}
