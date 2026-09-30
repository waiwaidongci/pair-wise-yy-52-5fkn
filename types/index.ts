export type PermitStatus = '待复核' | '待执行' | '执行中' | '待结束' | '待关闭' | '已完成'

export type RiskLevel = '一级' | '二级' | '三级'

export type PointState = '已隔离' | '待操作' | '已恢复'

export interface IsolationPoint {
  id: string
  device: string
  label: string
  type: '开关' | '刀闸' | '阀门' | '接地'
  state: PointState
}

export interface PermitStep {
  id: string
  text: string
  done: boolean
  owner: string
  evidence?: string
  doneAt?: string
  /** 依赖旧边界的完成结果已作废，需在新边界下重新确认 */
  stale?: boolean
  staleReason?: string
}

export interface Permit {
  id: string
  title: string
  device: string
  crew: string
  owner: string
  window: string
  status: PermitStatus
  risk: RiskLevel
  isolationPoints: IsolationPoint[]
  steps: PermitStep[]
  revision: number
  reviewRequired: boolean
  /** 触发退回复核的冲突原因，随重算链路刷新 */
  reviewReason?: string
}

export interface AuditEvent {
  id: string
  time: string
  actor: string
  action: string
  target: string
  detail: string
}

/** 待负责人协调处理的事项 */
export type PendingKind = '冲突' | '版本过期' | '作废结果' | '离线合并'

export interface PendingItem {
  id: string
  kind: PendingKind
  title: string
  detail: string
  permitId?: string
  /** 冲突涉及的全部许可，协调时一并解除复核标记 */
  permitIds?: string[]
  createdAt: string
  resolved: boolean
  resolution?: string
}

/** 断网期间暂存的本机操作（步骤 / 推进意图 / 隔离点变更） */
export type OpKind = 'step' | 'advance' | 'isolation'

export type OpStatus = '待上传' | '已应用' | '已驳回'

export interface LocalOp {
  id: string
  /** 本机顺序号，恢复后按该顺序合并 */
  seq: number
  kind: OpKind
  permitId: string
  payload: Record<string, any>
  /** 操作所基于的许可版本；过期则不得覆盖新状态 */
  baseRevision: number
  createdAt: string
  status: OpStatus
  rejectReason?: string
}

/** 本地持久化形状，带版本号用于升级迁移 */
export interface PersistShape {
  schemaVersion: number
  permits: Permit[]
  audit: AuditEvent[]
  pendingItems: PendingItem[]
  outbox: LocalOp[]
}
