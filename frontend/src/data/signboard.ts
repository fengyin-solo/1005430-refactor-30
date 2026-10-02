import type { EntryRow } from './types'

/**
 * 警示标识领域规则（纯函数，不读写 localStorage）。
 *
 * 这套规则是警示标识所有写入口唯一的判定实现：「确认设置」「提交更换」
 * 「登记撤除」三个入口共用同一份检查，不允许各养一套、日久结论分岔。
 */

export const SIGNBOARD_KEY = 'signboard'
export const REPORT_KEY = 'report'
export const SIGN_ENTITY = '警示标识'

/** 标识编号字段：全模块只认这一处定义，多处取数都从同一个字段读。 */
export const SIGN_CODE_FIELD = '标识编号'
const HAZARD_FIELD = '所属隐患点'
const CATEGORY_FIELD = '标识类别'
const LOCATION_FIELD = '设置位置'
const OWNER_FIELD = '责任人'

/** 状态按顺序逐段向前推：倒序、跨段都不允许。 */
export const SIGN_STATUSES = ['待设置', '已设置', '待更换', '已撤除'] as const

/** 标识类别的有效取值（安全标志四类，GB 2894）；为空同样按无效值处理。 */
export const SIGN_CATEGORIES = ['禁止标志', '警告标志', '指令标志', '提示标志'] as const

/**
 * 判定问题优先级：同一条数据同时命中多个问题时，只落优先级最高的一条，
 * 保证无论从哪个入口进来，冲突时结论都唯一、不允许两样。
 */
export const SIGN_ISSUE_PRIORITY = [
  'SIGN_CODE_DUPLICATED',
  'SIGN_CATEGORY_INVALID',
  'SIGN_LOCATION_MISSING',
  'SIGN_OWNER_MISSING',
] as const

export type SignIssueCode = (typeof SIGN_ISSUE_PRIORITY)[number]

export type SignInspection = { ok: true } | { ok: false; code: SignIssueCode; message: string }

export type SignTransition = { ok: true } | { ok: false; message: string }

function isBlank(value: unknown): boolean {
  return String(value ?? '').trim() === ''
}

/** 标识编号唯一取数入口：任何查重、交接、台账落记都用它归一化后的值。 */
export function readSignCode(row: Pick<EntryRow, string>): string {
  return String(row[SIGN_CODE_FIELD] ?? '').trim()
}

/**
 * 警示标识登记判定（确认设置 / 登记撤除共用的同一份实现）。
 *
 * @param row   待判定的标识记录
 * @param peers 同模块其它记录，用于查重（不含 row 自身时也兼容）
 */
export function inspectSignEntry(
  row: Pick<EntryRow, string>,
  peers: Array<Pick<EntryRow, string>>,
): SignInspection {
  const code = readSignCode(row)
  const selfId = row.id

  // ① 标识编号有没有重：与其它记录（排除自身）编号相同即重号。
  if (code !== '') {
    const duplicated = peers.some((peer) => {
      if (peer.id === selfId) {
        return false
      }
      return readSignCode(peer) === code
    })
    if (duplicated) {
      return {
        ok: false,
        code: 'SIGN_CODE_DUPLICATED',
        message: `标识编号 ${code} 已存在，标识编号不允许重复`,
      }
    }
  }

  // ② 标识类别填得对不对：为空时按无效值处理，取值不在有效类别内同样退回重填。
  const category = String(row[CATEGORY_FIELD] ?? '').trim()
  if (isBlank(category) || !(SIGN_CATEGORIES as readonly string[]).includes(category)) {
    return {
      ok: false,
      code: 'SIGN_CATEGORY_INVALID',
      message: `标识类别「${category}」不是有效值（不允许为空），请退回重填`,
    }
  }

  // ③ 设置位置是否齐全。
  if (isBlank(row[LOCATION_FIELD])) {
    return {
      ok: false,
      code: 'SIGN_LOCATION_MISSING',
      message: '设置位置未填写齐全，请补齐后再办理',
    }
  }

  // ④ 责任人是否齐全。
  if (isBlank(row[OWNER_FIELD])) {
    return {
      ok: false,
      code: 'SIGN_OWNER_MISSING',
      message: '责任人未填写齐全，请补齐后再办理',
    }
  }

  return { ok: true }
}

/**
 * 状态流转闸：待设置 → 已设置 → 待更换 → 已撤除，只能逐段向前推。
 * 倒序改动、跨段跳转、停在原态重复办理，一律挡下。
 */
export function checkSignForward(currentStatus: string, targetStatus: string): SignTransition {
  const currentIndex = SIGN_STATUSES.indexOf(currentStatus as (typeof SIGN_STATUSES)[number])
  const targetIndex = SIGN_STATUSES.indexOf(targetStatus as (typeof SIGN_STATUSES)[number])

  if (currentIndex < 0) {
    return {
      ok: false,
      message: `${SIGN_ENTITY}当前状态「${currentStatus}」不在状态序列内，不能改到「${targetStatus}」`,
    }
  }
  if (targetIndex < 0) {
    return { ok: false, message: `「${targetStatus}」不是${SIGN_ENTITY}的合法状态` }
  }
  if (targetIndex === currentIndex) {
    return { ok: false, message: `${SIGN_ENTITY}已经是「${targetStatus}」，不用重复操作` }
  }
  if (targetIndex < currentIndex) {
    return {
      ok: false,
      message: `${SIGN_ENTITY}状态只能按「${SIGN_STATUSES.join('→')}」逐段向前推进，不能倒序从「${currentStatus}」改到「${targetStatus}」`,
    }
  }
  if (targetIndex > currentIndex + 1) {
    return {
      ok: false,
      message: `${SIGN_ENTITY}状态只能逐段推进，不能从「${currentStatus}」跨段改到「${targetStatus}」`,
    }
  }
  return { ok: true }
}

/** ===== 交接：结果落到险情上报台账，同一标识编号走两次只挂一条待核项。 ===== */

export const HANDOVER_SOURCE = '警示标识交接'
/** 台账待核项的上报编号以前缀 + 标识编号构成，标识编号保持同一份、不改写。 */
export const HANDOVER_LEDGER_PREFIX = 'HO-'
export const HANDOVER_PENDING_NOTE = '待核项：警示标识交接结果，等待核验'

/** 从台账记录反查它对应的标识编号（优先读专用字段，兼容按上报编号反推）。 */
export function handoverCodeOf(ledgerRow: Pick<EntryRow, string>): string {
  const direct = String(ledgerRow[SIGN_CODE_FIELD] ?? '').trim()
  if (direct !== '') {
    return direct
  }
  const reportNo = String(ledgerRow['上报编号'] ?? '').trim()
  return reportNo.startsWith(HANDOVER_LEDGER_PREFIX)
    ? reportNo.slice(HANDOVER_LEDGER_PREFIX.length)
    : ''
}

export function isHandoverEntry(ledgerRow: Pick<EntryRow, string>): boolean {
  return String(ledgerRow['交接来源'] ?? '') === HANDOVER_SOURCE
}

/** 在险情上报台账里按标识编号找已挂的交接待核项；找不到返回 undefined。 */
export function findHandoverEntry(
  ledgerRows: Array<Pick<EntryRow, string>>,
  signCode: string,
): EntryRow | undefined {
  const code = signCode.trim()
  return ledgerRows.find(
    (row) => isHandoverEntry(row) && handoverCodeOf(row) === code,
  ) as EntryRow | undefined
}

export function nextLedgerId(ledgerRows: Array<Pick<EntryRow, 'id'>>): number {
  return ledgerRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

/** 交接生成的台账待核项（纯构造，不落库）；标识编号原样写入，多处保持同一份。 */
export function buildHandoverLedgerEntry(input: {
  id: number
  signCode: string
  hazard: string
  date: string
}): EntryRow {
  const code = input.signCode.trim()
  return {
    id: input.id,
    status: '待上报',
    pending: true,
    abnormal: false,
    上报编号: `${HANDOVER_LEDGER_PREFIX}${code}`,
    [HAZARD_FIELD]: input.hazard,
    险情类别: '警示标识交接（待核）',
    发现时间: input.date,
    上报层级: '',
    处置意见: HANDOVER_PENDING_NOTE,
    反馈时间: '',
    // 以下两个为交接台账的辅助标记：标识编号原样落记，来源用于幂等识别。
    [SIGN_CODE_FIELD]: code,
    交接来源: HANDOVER_SOURCE,
  }
}
