export type PermitStatus = '待复核' | '待执行' | '执行中' | '待结束' | '待关闭' | '已完成'

export type IsolationState = '已隔离' | '待操作' | '已恢复'

export interface IsolationPoint {
  id: string
  device: string
  /** 标准化隔离边界资源（如 BUS-A、LINE-A2），用于跨班组占用与冲突判断 */
  resource: string
  label: string
  type: '开关' | '刀闸' | '阀门' | '接地'
  state: IsolationState
}

export interface PermitStep {
  id: string
  text: string
  done: boolean
  owner: string
  evidence?: string
  /** 是否依赖隔离边界（边界变化后旧完成结果作废） */
  dependsOnBoundary?: boolean
  /** 完成时的边界快照签名 */
  boundaryAtCompletion?: string
  completedAt?: string
  /** 当前完成结果所依据的边界已失效 */
  invalidated?: boolean
  invalidateReason?: string
}

export type ConflictSeverity = 'hard' | 'soft'

export interface ConflictInfo {
  kind: 'shared-resource' | 'crew-overlap'
  severity: ConflictSeverity
  resource?: string
  otherPermitId: string
  otherCrew: string
  reason: string
}

export type FollowUpKind = '冲突协调' | '版本过期' | '边界作废'
export type FollowUpStatus = '待处理' | '已协调' | '已关闭'

export interface FollowUp {
  id: string
  kind: FollowUpKind
  status: FollowUpStatus
  title: string
  detail: string
  permitIds: string[]
  resource?: string
  owner: string
  createdAt: string
  resolvedAt?: string
  resolution?: string
  /** 协调放行时锁定的资源集与边界签名，边界再变则决策失效 */
  resourceSet?: string[]
  signature?: string
}

export interface Permit {
  id: string
  title: string
  device: string
  crew: string
  owner: string
  window: string
  status: PermitStatus
  risk: '一级' | '二级' | '三级'
  isolationPoints: IsolationPoint[]
  steps: PermitStep[]
  revision: number
  reviewRequired: boolean
  /** 存在基于旧边界、已作废的步骤 */
  boundaryStale?: boolean
  /** 最近一次重算得到的冲突清单 */
  conflicts: ConflictInfo[]
}

export interface AuditEvent {
  id: string
  time: string
  actor: string
  action: string
  target: string
  detail: string
}

export type OutboxOpType = 'advance' | 'toggle-step' | 'set-point' | 'add-permit' | 'coordinate'

/** 断网期间本机产生、待重连后按顺序合并的操作 */
export interface QueuedOp {
  id: string
  type: OutboxOpType
  permitId: string
  /** 操作所依据的许可版本，重连时过期则不得覆盖新状态 */
  baseRevision: number
  label: string
  createdAt: string
  payload: Record<string, unknown>
}

/** 断网期间对端班组已经推进、重连时才到达的变更 */
export interface RemoteChange {
  id: string
  permitId: string
  actor: string
  description: string
  at: string
  fromRevision: number
  toRevision: number
}

/** 断网期间缓存的对端推进意图（模拟服务器推送），重连时先于本机队列生效 */
export interface RemoteIntent {
  id: string
  permitId?: string
  kind: 'advance' | 'toggle-step' | 'point-state'
  pointId?: string
  stepId?: string
  state?: IsolationState
  done?: boolean
  actor: string
  description: string
  at: string
}

export interface PersistShape {
  version: 2
  permits: Permit[]
  audit: AuditEvent[]
  followUps: FollowUp[]
  outbox: QueuedOp[]
  remoteChanges: RemoteChange[]
  remoteIntents?: RemoteIntent[]
  remoteBase: Permit[] | null
  remoteState: Permit[] | null
  latestAlert: string
}
