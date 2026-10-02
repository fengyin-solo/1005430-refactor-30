import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { resetRows, saveRows, listRows } from '@/data/local-store'
import { runAction, handoverSign, listEntries } from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import {
  buildHandoverLedgerEntry,
  checkSignForward,
  findHandoverEntry,
  HANDOVER_SOURCE,
  inspectSignEntry,
  readSignCode,
  SIGN_CATEGORIES,
  SIGN_CODE_FIELD,
} from '@/data/signboard'

function makeSign(overrides: Partial<EntryRow> = {}): EntryRow {
  return {
    id: 0,
    status: '待设置',
    pending: true,
    abnormal: false,
    标识编号: 'SIGN-T-0000',
    所属隐患点: 'H-01',
    标识类别: '警告标志',
    设置位置: '坡脚路口',
    设置日期: '2026-09-10',
    责任人: '张三',
    更换日期: '',
    标识状态: '',
    ...overrides,
  }
}

function seedSigns(rows: EntryRow[]): void {
  saveRows('signboard', rows)
}

beforeEach(() => {
  resetRows('signboard')
  resetRows('report')
})

describe('inspectSignEntry 唯一判定（设置/撤除共用）', () => {
  it('字段齐全、类别合法、编号不重时通过', () => {
    const row = makeSign()
    const result = inspectSignEntry(row, [])
    assert.equal(result.ok, true)
  })

  it('标识编号与其它记录重复时判重号', () => {
    const row = makeSign({ id: 1, 标识编号: 'SIGN-X-1' })
    const peers = [makeSign({ id: 2, 标识编号: 'SIGN-X-1' })]
    const result = inspectSignEntry(row, peers)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'SIGN_CODE_DUPLICATED')
  })

  it('查重排除自身（同 id 不算重号）', () => {
    const row = makeSign({ id: 7, 标识编号: 'SIGN-X-7' })
    const result = inspectSignEntry(row, [row])
    assert.equal(result.ok, true)
  })

  it('标识类别为空串/纯空白时按无效值处理，退回重填', () => {
    for (const category of ['', '   ', undefined]) {
      const result = inspectSignEntry(makeSign({ 标识类别: category as string }), [])
      assert.equal(result.ok, false)
      if (result.ok) return
      assert.equal(result.code, 'SIGN_CATEGORY_INVALID')
      assert.match(result.message, /退回重填/)
    }
  })

  it('标识类别不在有效类别集合内时同样无效', () => {
    assert.ok(!(SIGN_CATEGORIES as readonly string[]).includes('警示标识样例1'))
    const result = inspectSignEntry(makeSign({ 标识类别: '警示标识样例1' }), [])
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.code, 'SIGN_CATEGORY_INVALID')
  })

  it('设置位置、责任人缺失分别报对应问题', () => {
    const noLocation = inspectSignEntry(makeSign({ 设置位置: '  ' }), [])
    assert.equal(noLocation.ok, false)
    if (!noLocation.ok) assert.equal(noLocation.code, 'SIGN_LOCATION_MISSING')

    const noOwner = inspectSignEntry(makeSign({ 责任人: '' }), [])
    assert.equal(noOwner.ok, false)
    if (!noOwner.ok) assert.equal(noOwner.code, 'SIGN_OWNER_MISSING')
  })

  it('冲突时按优先级只落一条：重号 > 类别无效 > 位置缺失 > 责任人缺失', () => {
    const peers = [makeSign({ id: 2, 标识编号: 'DUP-1' })]
    const worst = inspectSignEntry(
      makeSign({ id: 1, 标识编号: 'DUP-1', 标识类别: '', 设置位置: '', 责任人: '' }),
      peers,
    )
    if (worst.ok) throw new Error('应当不通过')
    assert.equal(worst.code, 'SIGN_CODE_DUPLICATED')

    const second = inspectSignEntry(
      makeSign({ id: 3, 标识编号: 'UNIQ-3', 标识类别: '', 设置位置: '', 责任人: '' }),
      peers,
    )
    if (second.ok) throw new Error('应当不通过')
    assert.equal(second.code, 'SIGN_CATEGORY_INVALID')

    const third = inspectSignEntry(
      makeSign({ id: 4, 标识类别: '提示标志', 设置位置: '', 责任人: '' }),
      peers,
    )
    if (third.ok) throw new Error('应当不通过')
    assert.equal(third.code, 'SIGN_LOCATION_MISSING')
  })

  it('两个入口共用同一份实现：等价数据无论办理哪个动作结论一致', () => {
    // 待设置上办「确认设置」与待更换上办「登记撤除」，命中的是同一个 inspectSignEntry。
    const defects = [
      { 标识类别: '' },
      { 设置位置: '' },
      { 责任人: '' },
    ] as const
    for (const defect of defects) {
      seedSigns([
        makeSign({ id: 1, status: '待设置', 标识编号: 'SIGN-E-1', ...defect }),
        makeSign({ id: 2, status: '待更换', 标识编号: 'SIGN-E-2', ...defect }),
      ])
      const setting = runAction('signboard', 1, '确认设置')
      const removal = runAction('signboard', 2, '登记撤除')
      assert.equal(setting.ok, false)
      assert.equal(removal.ok, false)
      assert.equal(setting.message, removal.message)
    }
  })

  it('判定不改动记录本身（不碰老数据）', () => {
    const row = makeSign({ 标识类别: '' })
    const snapshot = JSON.stringify(row)
    inspectSignEntry(row, [])
    assert.equal(JSON.stringify(row), snapshot)
  })
})

describe('checkSignForward 状态逐段向前，倒序挡下', () => {
  it('只允许向相邻后一状态推进', () => {
    assert.equal(checkSignForward('待设置', '已设置').ok, true)
    assert.equal(checkSignForward('已设置', '待更换').ok, true)
    assert.equal(checkSignForward('待更换', '已撤除').ok, true)
  })

  it('倒序改动一律挡下', () => {
    assert.equal(checkSignForward('已设置', '待设置').ok, false)
    assert.equal(checkSignForward('待更换', '已设置').ok, false)
    assert.equal(checkSignForward('已撤除', '待更换').ok, false)
    assert.equal(checkSignForward('已撤除', '待设置').ok, false)
  })

  it('跨段跳转一律挡下', () => {
    assert.equal(checkSignForward('待设置', '待更换').ok, false)
    assert.equal(checkSignForward('待设置', '已撤除').ok, false)
    assert.equal(checkSignForward('已设置', '已撤除').ok, false)
  })

  it('停在原态重复办理挡下', () => {
    assert.equal(checkSignForward('已设置', '已设置').ok, false)
  })
})

describe('runAction 警示标识状态流转端到端', () => {
  it('合法数据走完 待设置→已设置→待更换→已撤除', () => {
    seedSigns([makeSign({ id: 1 })])
    assert.equal(runAction('signboard', 1, '确认设置').ok, true)
    assert.equal(listRows('signboard')[0].status, '已设置')
    assert.equal(runAction('signboard', 1, '提交更换').ok, true)
    assert.equal(listRows('signboard')[0].status, '待更换')
    assert.equal(runAction('signboard', 1, '登记撤除').ok, true)
    assert.equal(listRows('signboard')[0].status, '已撤除')
  })

  it('判定不过不允许推进，且状态保持不变', () => {
    seedSigns([makeSign({ id: 1, 标识类别: '' })])
    const result = runAction('signboard', 1, '确认设置')
    assert.equal(result.ok, false)
    assert.equal(listRows('signboard')[0].status, '待设置')
  })

  it('倒序操作经服务层被挡下', () => {
    seedSigns([makeSign({ id: 1, status: '已撤除', pending: false })])
    const result = runAction('signboard', 1, '确认设置')
    assert.equal(result.ok, false)
    assert.match(result.message, /倒序/)
    assert.equal(listRows('signboard')[0].status, '已撤除')
  })

  it('跨段操作经服务层被挡下', () => {
    seedSigns([makeSign({ id: 1, status: '待设置' })])
    const result = runAction('signboard', 1, '提交更换')
    assert.equal(result.ok, false)
    assert.match(result.message, /逐段/)
  })

  it('重号数据两端都办不动', () => {
    seedSigns([
      makeSign({ id: 1, status: '待设置', 标识编号: 'SIGN-D-1' }),
      makeSign({ id: 2, status: '待更换', 标识编号: 'SIGN-D-1' }),
    ])
    assert.equal(runAction('signboard', 1, '确认设置').ok, false)
    assert.equal(runAction('signboard', 2, '登记撤除').ok, false)
  })

  it('其它模块仍走通用流转，不受领域闸影响', () => {
    resetRows('hazard')
    const result = runAction('hazard', 1, '提交核查')
    assert.equal(result.ok, true)
    assert.equal(listRows('hazard')[0].status, '建档中')
  })
})

describe('交接：同一标识编号走两次只挂一条待核项', () => {
  it('交接在险情上报台账添记待核项，标识编号保持同一份', () => {
    seedSigns([makeSign({ id: 1, 标识编号: '  SIGN-H-1  ' })])
    const result = handoverSign(1)
    assert.equal(result.ok, true)

    const ledger = listRows('report')
    const entry = findHandoverEntry(ledger, 'SIGN-H-1')
    assert.ok(entry, '台账应能按标识编号找到交接项')
    if (!entry) return
    assert.equal(entry.status, '待上报')
    assert.equal(entry.pending, true)
    assert.equal(String(entry[SIGN_CODE_FIELD]), 'SIGN-H-1')
    assert.match(String(entry['险情类别']), /待核/)
    assert.match(String(entry['处置意见']), /待核/)
    assert.equal(entry['交接来源'], HANDOVER_SOURCE)
    // 标识编号在台账与标识两侧取数一致（同一归一化来源）。
    const signCode = readSignCode(listRows('signboard')[0])
    assert.equal(String(entry[SIGN_CODE_FIELD]), signCode)
  })

  it('同一编号第二次交接幂等：不重复挂账，返回同一条', () => {
    seedSigns([makeSign({ id: 1, 标识编号: 'SIGN-H-2' })])
    const before = listRows('report').length
    const first = handoverSign(1)
    const afterFirst = listRows('report').length
    const second = handoverSign(1)
    const afterSecond = listRows('report').length

    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(afterFirst, before + 1)
    assert.equal(afterSecond, afterFirst, '第二次交接不得再添台账记录')
  })

  it('不同标识编号各自挂一条', () => {
    seedSigns([
      makeSign({ id: 1, 标识编号: 'SIGN-H-3' }),
      makeSign({ id: 2, 标识编号: 'SIGN-H-4' }),
    ])
    handoverSign(1)
    handoverSign(2)
    assert.ok(findHandoverEntry(listRows('report'), 'SIGN-H-3'))
    assert.ok(findHandoverEntry(listRows('report'), 'SIGN-H-4'))
  })

  it('编号为空的标识不允许交接', () => {
    seedSigns([makeSign({ id: 1, 标识编号: '   ' })])
    const result = handoverSign(1)
    assert.equal(result.ok, false)
  })

  it('交接不改动标识自身的状态', () => {
    seedSigns([makeSign({ id: 1, status: '已设置', pending: true })])
    handoverSign(1)
    assert.equal(listRows('signboard')[0].status, '已设置')
  })

  it('待核项能在险情上报列表中被检索到', () => {
    seedSigns([makeSign({ id: 1, 标识编号: 'SIGN-H-5' })])
    handoverSign(1)
    const payload = listEntries('report', { 险情类别: '待核' })
    assert.ok(payload.items.some((row) => String(row[SIGN_CODE_FIELD]) === 'SIGN-H-5'))
  })

  it('待核项结构符合险情上报台账字段约定', () => {
    const entry = buildHandoverLedgerEntry({
      id: 99,
      signCode: ' SIGN-K-9 ',
      hazard: 'H-9',
      date: '2026-10-02',
    })
    assert.equal(entry.id, 99)
    assert.equal(entry['上报编号'], 'HO-SIGN-K-9')
    assert.equal(entry[SIGN_CODE_FIELD], 'SIGN-K-9')
    assert.equal(entry['发现时间'], '2026-10-02')
  })
})
