import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  buildHandoverLedgerEntry,
  canAdvanceSignStatus,
  checkSignEntry,
  hasHandoverLedger,
  nextSignStatus,
  REPORT_KEY,
  SIGNBOARD_KEY,
  SIGN_HANDOVER_ACTIONS,
  signCode,
} from '@/data/signboard'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 交接台账只挂警示标识这一个模块的交接结果。
const HANDOVER_BY_MODULE: Record<
  string,
  { ledgerKey: string; actions: readonly string[] }
> = {
  [SIGNBOARD_KEY]: { ledgerKey: REPORT_KEY, actions: SIGN_HANDOVER_ACTIONS },
}

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

  // 警示标识状态只能逐段向前推进：倒序、跳段一律挡下。
  if (key === SIGNBOARD_KEY && !canAdvanceSignStatus(current, target)) {
    const allowed = nextSignStatus(current)
    return {
      ok: false,
      message: allowed
        ? `当前状态「${current}」只能先推进到「${allowed}」，不允许倒序或跳段`
        : `当前状态「${current}」为末态，不能再变更`,
    }
  }

  // 「确认设置」「登记撤除」两个入口共用同一份判定，结论不可能分岔。
  if (key === SIGNBOARD_KEY && (SIGN_HANDOVER_ACTIONS as readonly string[]).includes(action)) {
    const verdict = checkSignEntry(rows[index], rows)
    if (!verdict.ok) {
      return { ok: false, message: verdict.message }
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

  // 交接结果落到险情上报台账：同一标识编号走两次交接也只挂一条待核项。
  const handover = HANDOVER_BY_MODULE[key]
  if (handover && handover.actions.includes(action)) {
    appendHandoverLedger(handover.ledgerKey, updated, action, current, target)
  }

  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

function appendHandoverLedger(
  ledgerKey: string,
  sign: EntryRow,
  action: string,
  from: string,
  to: string,
): ActionResult {
  const ledger = listRows(ledgerKey)
  const code = signCode(sign)
  if (hasHandoverLedger(ledger, code)) {
    return { ok: true, message: `标识编号「${code}」已挂过交接台账，不再重复挂账` }
  }
  const nextId = ledger.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const entry = buildHandoverLedgerEntry({
    id: nextId,
    sign,
    action,
    from,
    to,
    today: new Date().toISOString().slice(0, 10),
  })
  saveRows(ledgerKey, [...ledger, entry])
  return { ok: true, message: '已添记待核项' }
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
