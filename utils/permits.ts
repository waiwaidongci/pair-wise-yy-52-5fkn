import type { IsolationPoint, Permit, PermitStep } from '~/types'

/** 本地数据结构版本；旧版本数据恢复时据此迁移 */
export const SCHEMA_VERSION = 2

/** 母线设备命名：馈线经母线并网，共享同一母线段即构成边界共用 */
const BUS_DEVICES = new Set(['BUS-A', 'BUS-B'])
/** 馈线设备命名前缀（风机 / 箱变 / 集电线路），默认挂在 A 段母线上 */
const FEEDER_PREFIX = /^(WTG|BOX|LINE)-/

export function isBusDevice(device: string): boolean {
  return BUS_DEVICES.has(device)
}

/**
 * 解析 'MM-DD HH:mm — DD HH:mm' 形式的检修时间窗。
 * 结束侧可省略日期（当日）或只给日（跨日），跨日自动 +1 天。
 */
export function parseWindow(raw: string): { start: number; end: number } | null {
  const m = raw.match(
    /(\d{2})-(\d{2})\s+(\d{2}):(\d{2})\s*[—–-]\s*(?:(?:(\d{2})-(\d{2})|(\d{2}))\s+)?(\d{2}):(\d{2})/,
  )
  if (!m) return null
  const [, sm, sd, sh, smin, em, ed, eday, eh, emin] = m
  const start = Date.UTC(2026, Number(sm) - 1, Number(sd), Number(sh), Number(smin))
  // 结束侧：em-ed 为完整月-日；eday 为仅日；都没有则沿用开始月-日
  const endMonth = em ?? sm
  const endDay = ed ?? eday ?? sd
  let end = Date.UTC(2026, Number(endMonth) - 1, Number(endDay), Number(eh), Number(emin))
  if (end <= start) end += 24 * 60 * 60 * 1000
  return { start, end }
}

export function windowsOverlap(a: string, b: string): boolean {
  const wa = parseWindow(a)
  const wb = parseWindow(b)
  if (!wa || !wb) return false
  return wa.start < wb.end && wb.start < wa.end
}

/** 母线段：许可隔离点直接挂在母线设备上则以该段为准，否则馈线默认 A 段 */
function busbarSection(permit: Permit): string | null {
  for (const p of permit.isolationPoints) {
    if (isBusDevice(p.device)) return p.device
  }
  if (FEEDER_PREFIX.test(permit.device)) return 'BUS-A'
  return null
}

/** 两台许可是否共享同一隔离边界（同一隔离点设备或同一母线段） */
export function sharesBoundary(a: Permit, b: Permit): boolean {
  if (a.id === b.id) return false
  const devA = new Set(a.isolationPoints.map((p) => p.device))
  for (const p of b.isolationPoints) {
    if (devA.has(p.device)) return true
  }
  const sa = busbarSection(a)
  const sb = busbarSection(b)
  return !!sa && sa === sb
}

/**
 * 边界验证步骤：完成结果用于确认隔离边界安全（验电、接地、边界确认、
 * 停电范围核对、五防校验）。边界一旦变化，这些验证结果即失效；
 * 而断开开关、机械锁定等物理隔离动作本身不依赖旧边界，不在此列。
 */
const BOUNDARY_STEP_RE = /验电|接地|隔离边界|停电范围|五防/

export function isBoundaryStep(step: PermitStep): boolean {
  return BOUNDARY_STEP_RE.test(step.text)
}

export interface ConflictGroup {
  permits: Permit[]
  reasons: string[]
}

/**
 * 重算链路：基于当前全部许可的步骤 / 状态 / 隔离点，
 * 找出共享母线边界且时间窗重叠的班组占用组合。
 * 任何许可变化后都应重跑本函数，冲突判断不缓存、不写死。
 */
export function recomputeConflicts(permits: Permit[]): ConflictGroup[] {
  const groups: ConflictGroup[] = []
  const seen = new Set<string>()
  for (let i = 0; i < permits.length; i++) {
    for (let j = i + 1; j < permits.length; j++) {
      const a = permits[i]!
      const b = permits[j]!
      if (!sharesBoundary(a, b)) continue
      if (!windowsOverlap(a.window, b.window)) continue
      const key = [a.id, b.id].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)
      groups.push({
        permits: [a, b],
        reasons: [`${a.crew}（${a.id}）与 ${b.crew}（${b.id}）共用母线隔离边界，且时间窗重叠`],
      })
    }
  }
  return groups
}

/** 隔离点状态的中文展示（供留痕使用） */
export function pointStateLabel(state: IsolationPoint['state']): string {
  return state
}
