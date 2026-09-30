import type { FollowUp, Permit, PersistShape, QueuedOp, RemoteChange } from '../types'

/**
 * 本地数据升级。
 * v1：{ permits, audit }（无资源字段、无冲突/作废/待处理项结构）
 * v2：完整重算链路结构。
 * 旧数据读取后补齐新字段并整体过一遍重算，原 v1 键保留备份，保证升级失败也能回退打开。
 */

export const STORAGE_KEY = 'yy52-permit-ops-v2'
export const LEGACY_STORAGE_KEY = 'yy52-permit-ops-v1'

function inferResource(point: { device?: string; label?: string }): string {
  const text = `${point.device ?? ''} ${point.label ?? ''}`
  if (text.includes('母线')) return 'BUS-A'
  if (text.includes('LINE') || text.includes('线路')) return (point.device as string) || 'LINE-A2'
  return point.device || 'UNKNOWN'
}

export function migrateV1(raw: string): { data: Pick<PersistShape, 'permits' | 'audit'>; migrated: boolean } {
  const draft = JSON.parse(raw) as { permits?: Permit[]; audit?: PersistShape['audit'] }
  const permits = (draft.permits ?? []).map((permit) => ({
    ...permit,
    isolationPoints: (permit.isolationPoints ?? []).map((point) => ({
      ...point,
      resource: point.resource ?? inferResource(point),
    })),
    steps: (permit.steps ?? []).map((step) => ({
      ...step,
      dependsOnBoundary: step.dependsOnBoundary ?? (step.done === true && /锁定|验电|接地|隔离/.test(step.text)),
      boundaryAtCompletion: step.boundaryAtCompletion,
      invalidated: false,
    })),
    conflicts: permit.conflicts ?? [],
    boundaryStale: false,
    reviewRequired: Boolean(permit.reviewRequired),
  }))
  return { data: { permits, audit: draft.audit ?? [] }, migrated: true }
}

export interface LoadedState extends Partial<PersistShape> {
  version: 2
  migrated: boolean
}

export function emptyV2(permits: Permit[], audit: PersistShape['audit'], latestAlert = ''): PersistShape {
  return {
    version: 2,
    permits,
    audit,
    followUps: [],
    outbox: [],
    remoteChanges: [],
    remoteBase: null,
    remoteState: null,
    latestAlert,
  }
}

/**
 * 从 localStorage 读取并升级。
 * 损坏的数据不阻断启动，退回种子数据；旧键内容保留为 .bak。
 */
export function loadLocalState(seed: { permits: Permit[]; audit: PersistShape['audit']; latestAlert?: string }): LoadedState {
  if (!import.meta.client) return { migrated: false, ...emptyV2(structuredClone(seed.permits), structuredClone(seed.audit), seed.latestAlert) }

  let raw = localStorage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as PersistShape
      return {
        version: 2,
        migrated: false,
        permits: parsed.permits ?? structuredClone(seed.permits),
        audit: parsed.audit ?? structuredClone(seed.audit),
        followUps: parsed.followUps ?? [],
        outbox: parsed.outbox ?? [],
        remoteChanges: parsed.remoteChanges ?? [],
        remoteIntents: parsed.remoteIntents ?? [],
        remoteBase: parsed.remoteBase ?? null,
        remoteState: parsed.remoteState ?? null,
        latestAlert: parsed.latestAlert ?? seed.latestAlert ?? '',
      }
    } catch {
      // v2 损坏：落一个备份再尝试旧版
      localStorage.setItem(`${STORAGE_KEY}.corrupt-${Date.now()}`, raw)
    }
  }

  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY)
  if (legacy) {
    try {
      const { data } = migrateV1(legacy)
      localStorage.setItem(`${LEGACY_STORAGE_KEY}.bak`, legacy)
      return { migrated: true, ...emptyV2(data.permits, data.audit, seed.latestAlert) }
    } catch {
      localStorage.setItem(`${LEGACY_STORAGE_KEY}.corrupt-${Date.now()}`, legacy)
    }
  }

  return { migrated: false, ...emptyV2(structuredClone(seed.permits), structuredClone(seed.audit), seed.latestAlert) }
}

export function saveLocalState(state: PersistShape) {
  if (!import.meta.client) return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export type { FollowUp, QueuedOp, RemoteChange }
