import type { EntryRow } from './types'

/**
 * 警示标识领域规则：唯一一份判定实现。
 *
 * 「确认设置」与「登记撤除」两个入口共用本文件的判定，不允许各养一套，
 * 同一条记录从两个入口进来，结论必须一致。
 */

export const SIGNBOARD_KEY = 'signboard'
export const REPORT_KEY = 'report'

const SIGN_CODE_FIELD = '标识编号'
const CATEGORY_FIELD = '标识类别'
const LOCATION_FIELD = '设置位置'
const OWNER_FIELD = '责任人'
const HAZARD_FIELD = '所属隐患点'

/** 标识类别名录：空值或不在名录内一律按无效值处理，入口退回重填。 */
export const SIGN_CATEGORIES = ['警告标志', '禁令标志', '指示标志', '警示宣传牌'] as const

/** 状态只能沿此顺序一段一段往前推，倒序、跳段都不允许。 */
export const SIGN_STATUSES = ['待设置', '已设置', '待更换', '已撤除'] as const

/** 交接动作：确认设置与登记撤除，结果要落到险情上报台账。 */
export const SIGN_HANDOVER_ACTIONS = ['确认设置', '登记撤除'] as const

/** 台账（险情上报）上交接待核项的标记字段。 */
export const PENDING_CHECK_FIELD = '待核'
export const HANDOVER_ACTION_FIELD = '交接动作'

// 判定项优先级：同一条记录同时踩中多条时，只取最靠前的一条，避免结论分岔。
const ISSUE_PRIORITY = [
  'duplicate-code',
  'invalid-category',
  'missing-location',
  'missing-owner',
] as const

export type SignIssue = (typeof ISSUE_PRIORITY)[number]

export type SignCheckResult = { ok: true } | { ok: false; issue: SignIssue; message: string }

/**
 * 标识编号的唯一取数口径：查重、挂险情上报台账、页面多处取数都走这里，
 * 保证同一条标识编号在任何地方都是同一份值。
 */
export function signCode(row: Partial<EntryRow>): string {
  return String(row[SIGN_CODE_FIELD] ?? '').trim()
}

function fieldText(row: EntryRow, field: string): string {
  return String(row[field] ?? '').trim()
}

/** 标识类别是否有效：去空白后必须落在名录内，空值即无效。 */
export function isValidSignCategory(value: string): boolean {
  const text = value.trim()
  return text !== '' && (SIGN_CATEGORIES as readonly string[]).includes(text)
}

/** 编号查重：经同一口径规整后与其他记录（排除自身）一致即重号。 */
export function findDuplicateCode(row: EntryRow, peers: EntryRow[]): EntryRow | undefined {
  const code = signCode(row)
  if (code === '') {
    return undefined
  }
  return peers.find((peer) => Number(peer.id) !== Number(row.id) && signCode(peer) === code)
}

function buildIssueMessage(issue: SignIssue, row: EntryRow): string {
  switch (issue) {
    case 'duplicate-code':
      return `标识编号「${signCode(row)}」与已有记录重复，请核对后退回重填`
    case 'invalid-category': {
      const category = fieldText(row, CATEGORY_FIELD)
      return category === ''
        ? '标识类别为空，按无效值处理，请退回重填'
        : `标识类别「${category}」不在标识类别名录内，按无效值处理，请退回重填`
    }
    case 'missing-location':
      return '设置位置未填写齐全，请补齐后退回重填'
    case 'missing-owner':
      return '责任人未填写齐全，请补齐后退回重填'
  }
}

/**
 * 警示标识登记项统一判定（设置与撤除共用的唯一入口）：
 * 1. 标识编号有没有重；2. 标识类别填得对不对（空值按无效值）；
 * 3. 设置位置与责任人是否齐全。
 * 多条同时不满足时，按 {@link ISSUE_PRIORITY} 只给出优先级最高的一条。
 */
export function checkSignEntry(row: EntryRow, peers: EntryRow[]): SignCheckResult {
  const issues: SignIssue[] = []
  if (findDuplicateCode(row, peers)) {
    issues.push('duplicate-code')
  }
  if (!isValidSignCategory(fieldText(row, CATEGORY_FIELD))) {
    issues.push('invalid-category')
  }
  if (fieldText(row, LOCATION_FIELD) === '') {
    issues.push('missing-location')
  }
  if (fieldText(row, OWNER_FIELD) === '') {
    issues.push('missing-owner')
  }
  if (issues.length === 0) {
    return { ok: true }
  }
  const issue = ISSUE_PRIORITY.find((candidate) => issues.includes(candidate)) as SignIssue
  return { ok: false, issue, message: buildIssueMessage(issue, row) }
}

/** 当前状态允许推进到的下一状态；末态或不在流转链上时返回 undefined。 */
export function nextSignStatus(status: string): string | undefined {
  const index = (SIGN_STATUSES as readonly string[]).indexOf(status)
  if (index < 0 || index >= SIGN_STATUSES.length - 1) {
    return undefined
  }
  return SIGN_STATUSES[index + 1]
}

/** 只允许逐段向前推进；倒序、跳段、原地不动一律挡下。 */
export function canAdvanceSignStatus(current: string, target: string): boolean {
  return nextSignStatus(current) === target
}

/** 同一标识编号在险情上报台账上是否已有交接挂账（走两次交接只挂一条）。 */
export function hasHandoverLedger(reportRows: EntryRow[], code: string): boolean {
  if (code === '') {
    return false
  }
  return reportRows.some(
    (row) => signCode(row) === code && row[HANDOVER_ACTION_FIELD] !== undefined,
  )
}

type LedgerEntryInput = {
  id: number
  sign: EntryRow
  action: string
  from: string
  to: string
  today: string
}

/**
 * 交接结果落到险情上报台账：添记一条「待核」项。
 * 标识编号沿用 {@link signCode} 同一份取数口径，便于台账与标识记录对上号。
 */
export function buildHandoverLedgerEntry({
  id,
  sign,
  action,
  from,
  to,
  today,
}: LedgerEntryInput): EntryRow {
  const code = signCode(sign)
  return {
    id,
    status: '待上报',
    pending: true,
    abnormal: false,
    上报编号: `SGRE-${String(id).padStart(4, '0')}`,
    所属隐患点: fieldText(sign, HAZARD_FIELD),
    险情类别: '警示标识交接',
    发现时间: today,
    上报层级: '待核',
    处置意见: `标识编号 ${code} 办理「${action}」，状态由「${from}」推进至「${to}」，请核验`,
    反馈时间: '',
    上报状态: '待核',
    [SIGN_CODE_FIELD]: code,
    [HANDOVER_ACTION_FIELD]: action,
    [PENDING_CHECK_FIELD]: true,
  }
}
