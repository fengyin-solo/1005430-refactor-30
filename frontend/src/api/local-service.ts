import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  buildHandoverLedgerEntry,
  checkSignForward,
  findHandoverEntry,
  inspectSignEntry,
  nextLedgerId,
  readSignCode,
  REPORT_KEY,
  SIGN_ENTITY,
  SIGNBOARD_KEY,
} from '@/data/signboard'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  // 警示标识：先按状态机闸住倒序/跨段，再走唯一的登记判定。
  // 两个入口（确认设置、登记撤除）以及提交更换共用同一份 inspectSignEntry，
  // 同一条数据无论从哪个入口办理，结论都一致。
  if (key === SIGNBOARD_KEY) {
    const transition = checkSignForward(current, target)
    if (!transition.ok) {
      return { ok: false, message: transition.message }
    }
    const inspection = inspectSignEntry(rows[index], rows)
    if (!inspection.ok) {
      return { ok: false, message: inspection.message }
    }
  }

  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

/**
 * 警示标识交接：交接结果落到险情上报台账，添记一条「待核项」。
 * 标识编号全程取自 readSignCode 这一处；同一条编号走两次交接只挂一条（幂等）。
 */
export function handoverSign(id: number): ActionResult {
  const rows = listRows(SIGNBOARD_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${SIGN_ENTITY}` }
  }
  const signRow = rows[index]
  const signCode = readSignCode(signRow)
  if (signCode === '') {
    return { ok: false, message: '该警示标识缺少标识编号，无法办理交接' }
  }

  const ledger = listRows(REPORT_KEY)
  const existing = findHandoverEntry(ledger, signCode)
  if (existing) {
    // 同一标识编号第二次交接：台账不重复挂账，直接回原结论。
    return {
      ok: true,
      message: `标识编号 ${signCode} 已在险情上报台账挂过交接待核项（${String(existing['上报编号'])}），不再重复登记`,
    }
  }

  const entry = buildHandoverLedgerEntry({
    id: nextLedgerId(ledger),
    signCode,
    hazard: String(signRow['所属隐患点'] ?? ''),
    date: todayText(),
  })
  saveRows(REPORT_KEY, [...ledger, entry])
  return {
    ok: true,
    message: `标识编号 ${signCode} 交接完成，险情上报台账已添记待核项（${String(entry['上报编号'])}）`,
  }
}

function todayText(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
