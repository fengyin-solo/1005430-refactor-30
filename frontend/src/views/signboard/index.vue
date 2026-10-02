<template>
  <section class="page" data-module="signboard">
    <header class="page-head">
      <div>
        <h2>警示标识管理</h2>
        <p class="page-desc">维护警示标识，围绕标识编号、所属隐患点、标识类别、设置位置做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记警示标识</button>
        <button class="btn" type="button" @click="exportRows">导出警示标识清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!actionsFor(row).length">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无警示标识数据，可先登记警示标识</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条警示标识记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { SIGN_STATUSES } from '@/data/signboard'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('signboard')
const columns = ["标识编号", "所属隐患点", "标识类别", "设置位置", "设置日期", "责任人", "更换日期", "标识状态"]
const actions = ["确认设置", "提交更换", "登记撤除"]
const statuses = ["待设置", "已设置", "待更换", "已撤除"]
const stats = [{"label": "待设置标识", "value": 0}, {"label": "待更换标识", "value": 0}, {"label": "已设置标识", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 状态一段一段往前推：页面只暴露当前状态的下一段动作，倒序动作不给出入口。
const actionByTarget = new Map(actions.map((action) => [meta.actionTargets[action], action]))
function actionsFor(row: EntryRow): string[] {
  const index = (SIGN_STATUSES as readonly string[]).indexOf(String(row.status))
  if (index < 0 || index >= SIGN_STATUSES.length - 1) {
    return []
  }
  const action = actionByTarget.get(SIGN_STATUSES[index + 1])
  return action ? [action] : []
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '警示标识登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '警示标识列表读取失败'
  }
}

onMounted(reload)
</script>
