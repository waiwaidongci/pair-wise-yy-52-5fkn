import assert from 'node:assert/strict'
import { recompute, boundarySignature, replayOutbox, coordinationSignature, staleFollowUp, migrateV1 } from '../node_modules/.cache/chain-bundle.mjs'

let pass = 0
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ✓ ${name}`) }

const permit = (over = {}) => ({
  id: 'P1', title: 't', device: 'D', crew: '甲班', owner: 'o', window: '09-30 08:00 — 12:00',
  status: '执行中', risk: '二级', revision: 1, reviewRequired: false, conflicts: [],
  isolationPoints: [{ id: 'I1', device: 'BUS-A', resource: 'BUS-A', label: '母线刀闸', type: '刀闸', state: '已隔离' }],
  steps: [], ...over,
})

console.log('1) 跨班组共享资源 + 窗口重叠 → 立即退回复核 + 待处理项')
{
  const a = permit()
  const b = permit({ id: 'P2', crew: '乙班', window: '09-30 10:00 — 14:00', isolationPoints: [{ id: 'I2', device: 'BUS-A', resource: 'BUS-A', label: '母线刀闸2', type: '刀闸', state: '待操作' }] })
  const followUps = []
  const r = recompute([a, b], followUps)
  const ra = r.permits.find(p => p.id === 'P1')
  const rb = r.permits.find(p => p.id === 'P2')
  ok('双方 status 均退回「待复核」', () => { assert.equal(ra.status, '待复核'); assert.equal(rb.status, '待复核') })
  ok('reviewRequired 且有 hard 冲突指向对方', () => { assert.equal(ra.reviewRequired, true); assert.equal(ra.conflicts[0].severity, 'hard'); assert.equal(ra.conflicts[0].otherPermitId, 'P2') })
  ok('生成 rollback 事件', () => { assert.equal(r.effects.length, 2); assert.ok(r.effects.every(e => e.toStatus === '待复核')) })
  ok('同一资源只生成一个待处理协调项', () => { assert.equal(followUps.length, 1); assert.equal(followUps[0].kind, '冲突协调'); assert.deepEqual(followUps[0].permitIds, ['P1', 'P2']) })
}

console.log('2) 窗口不重叠 → 不冲突、不退回')
{
  const a = permit({ window: '09-30 08:00 — 10:00' })
  const b = permit({ id: 'P2', crew: '乙班', window: '09-30 10:00 — 12:00', isolationPoints: [{ id: 'I2', device: 'BUS-A', resource: 'BUS-A', label: 'x', type: '刀闸', state: '待操作' }] })
  const r = recompute([a, b], [])
  ok('保持执行中且无冲突', () => { assert.equal(r.permits[0].status, '执行中'); assert.equal(r.permits[0].conflicts.length, 0); assert.equal(r.effects.length, 0) })
}

console.log('3) 同班组共享 → 软冲突不退回复核')
{
  const a = permit()
  const b = permit({ id: 'P2', crew: '甲班', window: '09-30 10:00 — 14:00', isolationPoints: [{ id: 'I2', device: 'BUS-A', resource: 'BUS-A', label: 'x', type: '刀闸', state: '待操作' }] })
  const r = recompute([a, b], [])
  ok('soft 冲突、状态不变', () => { assert.equal(r.permits[0].conflicts[0].severity, 'soft'); assert.equal(r.permits[0].status, '执行中'); assert.equal(r.effects.length, 0) })
}

console.log('4) 隔离边界一变，依赖旧边界的完成结果作废；已完成许可也退回')
{
  const a = permit({ status: '已完成', steps: [{ id: 'S1', text: '验电接地', done: true, owner: 'o', dependsOnBoundary: true, boundaryAtCompletion: 'I1@待操作' }] })
  const r = recompute([a], [])
  const step = r.permits[0].steps[0]
  ok('步骤标记 invalidated 且证据保留', () => { assert.equal(step.done, true); assert.equal(step.invalidated, true); assert.ok(step.invalidateReason) })
  ok('boundaryStale=true 且已完成许可退回「待复核」', () => { assert.equal(r.permits[0].boundaryStale, true); assert.equal(r.permits[0].status, '待复核') })
  ok('作废事件进入 invalidatedSteps', () => { assert.equal(r.invalidatedSteps[0].stepId, 'S1') })

  // 边界恢复到与完成时一致 → 作废清除
  const a2 = permit({ steps: [{ id: 'S1', text: 'x', done: true, owner: 'o', dependsOnBoundary: true, boundaryAtCompletion: boundarySignature(permit()) }] })
  const r2 = recompute([a2], [])
  ok('边界恢复一致后自动解除作废', () => { assert.ok(!r2.permits[0].steps[0].invalidated) })
}

console.log('5) 协调决策后放行；边界再变 → 决策失效、重新退回、协调项重开')
{
  const a = permit()
  const b = permit({ id: 'P2', crew: '乙班', window: '09-30 10:00 — 14:00', isolationPoints: [{ id: 'I2', device: 'BUS-A', resource: 'BUS-A', label: 'x', type: '刀闸', state: '待操作' }] })
  const fu = []
  recompute([structuredClone(a), structuredClone(b)], fu)
  assert.equal(fu.length, 1)
  fu[0].status = '已协调'
  fu[0].resolvedAt = '10:00'
  fu[0].resolution = '先后作业'
  fu[0].signature = coordinationSignature([a, b], ['P1', 'P2'], 'BUS-A')
  const r2 = recompute([structuredClone(a), structuredClone(b)], fu)
  ok('协调有效：不退回、不强制复核', () => { assert.equal(r2.permits[0].status, '执行中'); assert.equal(r2.permits[0].reviewRequired, false) })

  // 边界再变：P2 把点隔离
  const b2 = structuredClone(b); b2.isolationPoints[0].state = '已隔离'; b2.revision = 3
  const fuReopened = structuredClone(fu)
  const r3 = recompute([structuredClone(a), b2], fuReopened)
  ok('边界变化后决策失效并退回', () => { assert.equal(r3.permits[0].status, '待复核') })
  ok('原协调项重新打开为待处理', () => { assert.equal(fuReopened[0].status, '待处理'); assert.equal(fuReopened[0].signature, undefined) })
}

console.log('6) 断线重连：顺序合并本机步骤；版本过期的同字段操作不覆盖，转待处理')
{
  // 断线基线：P2 待操作 r1
  const base = [permit({ id: 'P2', crew: '乙班', window: '09-30 10:00 — 14:00', isolationPoints: [{ id: 'I2', device: 'BUS-A', resource: 'BOX-9', label: 'x', type: '刀闸', state: '待操作' }] })]
  // 对端把 I2 推到已隔离 r2（不同资源，避免冲突链干扰版本判断）
  const server = structuredClone(base); server[0].isolationPoints[0].state = '已隔离'; server[0].revision = 2
  const opStale = { id: 'Q1', type: 'set-point', permitId: 'P2', baseRevision: 1, label: '本机改 I2', createdAt: '2026-09-30T01:00:00Z', payload: { pointId: 'I2', state: '已恢复' } }
  const out = replayOutbox(server, base, [opStale])
  ok('同字段过期操作被拒绝、不覆盖对端新状态', () => { assert.equal(out.applied.length, 0); assert.equal(out.rejected.length, 1); assert.equal(out.state[0].isolationPoints[0].state, '已隔离') })
  const fu = staleFollowUp(opStale, out.rejected[0].reason, [], () => '10:00')
  ok('过期操作生成待处理项由负责人协调', () => { assert.equal(fu[0].kind, '版本过期'); assert.equal(fu[0].owner, '值班负责人'); assert.equal(fu[0].status, '待处理') })

  // 不同字段：对端改隔离点，本机完成一个不相关步骤 → 三路合并，版本门槛放行
  const server2 = structuredClone(base)
  server2[0].isolationPoints.push({ id: 'I9', device: 'X', resource: 'X', label: 'y', type: '开关', state: '已隔离' })
  server2[0].revision = 3
  server2[0].steps = [{ id: 'SX', text: '核对', done: false, owner: 'o' }]
  const opStep = { id: 'Q2', type: 'toggle-step', permitId: 'P2', baseRevision: 1, label: '完成 SX', createdAt: '2026-09-30T02:00:00Z', payload: { stepId: 'SX', done: true } }
  const out2 = replayOutbox(server2, base, [opStep])
  ok('对端改他字段时本机步骤三路合并成功', () => { assert.equal(out2.applied.length, 1); assert.equal(out2.state[0].steps[0].done, true) })

  // 顺序：同一许可两条本机操作，第二条不得被误判过期
  const base3 = [permit({ id: 'P3', crew: '丙班', isolationPoints: [{ id: 'IA', device: 'Z', resource: 'Z', label: 'a', type: '刀闸', state: '待操作' }] })]
  const opA = { id: 'QA', type: 'set-point', permitId: 'P3', baseRevision: 1, label: 'A', createdAt: '2026-09-30T03:00:00Z', payload: { pointId: 'IA', state: '已隔离' } }
  const opB = { id: 'QB', type: 'set-point', permitId: 'P3', baseRevision: 1, label: 'B', createdAt: '2026-09-30T04:00:00Z', payload: { pointId: 'IA', state: '已恢复' } }
  const out3 = replayOutbox(structuredClone(base3), base3, [opA, opB])
  ok('无对端变更时本机多条操作按顺序全部合入', () => { assert.equal(out3.applied.length, 2); assert.equal(out3.state[0].isolationPoints[0].state, '已恢复'); assert.equal(out3.state[0].revision, 3) })
}

console.log('7) 被重算退回「待复核」的许可，重连时其推进意图作废')
{
  const base = [permit({ id: 'P4', crew: '丁班', status: '待执行', reviewRequired: false, isolationPoints: [{ id: 'I4', device: 'W', resource: 'W', label: 'w', type: '刀闸', state: '待操作' }] })]
  // 重算后已退回（reviewRequired），模拟重连合并输入
  const server = structuredClone(base); server[0].status = '待复核'; server[0].reviewRequired = true
  const op = { id: 'Q4', type: 'advance', permitId: 'P4', baseRevision: 1, label: '推进', createdAt: 'x', payload: {} }
  const out = replayOutbox(server, base, [op])
  ok('推进意图被拒绝且不改变状态', () => { assert.equal(out.rejected.length, 1); assert.equal(out.state[0].status, '待复核') })
}

console.log('8) 旧 v1 本地许可数据升级后仍可打开')
{
  const v1 = JSON.stringify({
    permits: [{ id: 'OLD-1', title: '旧许可', device: 'BOX-12 · 温控器', crew: '电气一班', owner: '孙禾', window: '09-30 08:00 — 12:00', status: '待执行', risk: '二级', revision: 1, reviewRequired: false,
      isolationPoints: [{ id: 'IP-9', device: 'BOX-12', label: '高压负荷开关', type: '开关', state: '待操作' }],
      steps: [{ id: 'S9', text: '断开高压负荷开关并锁定', done: true, owner: '孙禾' }] }],
    audit: [],
  })
  const { data, migrated } = migrateV1(v1)
  ok('迁移成功并补齐资源/冲突/作废字段', () => {
    assert.equal(migrated, true)
    assert.equal(data.permits[0].isolationPoints[0].resource, 'BOX-12')
    assert.ok(Array.isArray(data.permits[0].conflicts))
    assert.equal(data.permits[0].steps[0].dependsOnBoundary, true)
  })
}

console.log(`\n全部 ${pass} 项断言通过`)
