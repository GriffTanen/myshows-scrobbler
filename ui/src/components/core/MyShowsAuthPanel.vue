<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import StatusDot, { type DotState } from './ui/StatusDot.vue'
import { fetchMyShowsAuthStatus, fetchMyShowsConfirmations } from '../../api'
import type { MyShowsConfirmation } from '../../types'

const props = defineProps<{
  liveConfirmations: MyShowsConfirmation[]
}>()

const { t, locale } = useI18n()

const connected = ref<boolean | null>(null)
const checking = ref(false)
/** Loaded once via REST on mount; new entries then arrive via the liveConfirmations prop
 *  (WS broadcast) and are merged in — same "REST at mount + WS for new" split the events
 *  panel's logs use, since confirmations aren't replayed over the socket on connect. */
const history = ref<MyShowsConfirmation[]>([])

const dotState = computed<DotState>(() => {
  if (checking.value) {
    return 'checking'
  }
  if (connected.value === true) {
    return 'ok'
  }
  if (connected.value === false) {
    return 'disabled'
  }
  return 'unknown'
})

const confirmations = computed<MyShowsConfirmation[]>(() => {
  const seen = new Set<string>()
  const merged: MyShowsConfirmation[] = []
  for (const entry of [...props.liveConfirmations, ...history.value]) {
    const key = `${entry.timestamp}:${entry.title}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    merged.push(entry)
  }
  return merged.slice(0, 20)
})

function formatTime(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString(locale.value)
  } catch {
    return timestamp
  }
}

async function refresh(): Promise<void> {
  checking.value = true
  try {
    const [statusRes, confirmationsRes] = await Promise.all([
      fetchMyShowsAuthStatus(),
      fetchMyShowsConfirmations(),
    ])
    connected.value = statusRes.connected
    history.value = confirmationsRes.confirmations
  } catch {
    connected.value = null
  } finally {
    checking.value = false
  }
}

onMounted(refresh)
</script>

<template>
  <section class="MyShowsAuthPanel">
    <header class="MyShowsAuthPanel__header">
      <h2>{{ t('myshowsAuth.title') }}</h2>
      <p class="MyShowsAuthPanel__subtitle">{{ t('myshowsAuth.subtitle') }}</p>
    </header>

    <div class="MyShowsAuthPanel__status">
      <StatusDot :state="dotState" pulse />
      <span>{{
        connected ? t('myshowsAuth.status.connected') : t('myshowsAuth.status.disconnected')
      }}</span>
      <button type="button" :disabled="checking" @click="refresh">
        {{ checking ? '…' : '↻' }}
      </button>
    </div>

    <ol class="MyShowsAuthPanel__steps">
      <li>{{ t('myshowsAuth.instructions.step1') }}</li>
      <li>{{ t('myshowsAuth.instructions.step2') }}</li>
      <li>{{ t('myshowsAuth.instructions.step3') }}</li>
    </ol>

    <div v-if="connected" class="MyShowsAuthPanel__history">
      <h3>{{ t('myshowsAuth.history.title') }}</h3>
      <p v-if="confirmations.length === 0" class="MyShowsAuthPanel__historyEmpty">
        {{ t('myshowsAuth.history.empty') }}
      </p>
      <ul v-else class="MyShowsAuthPanel__historyList">
        <li
          v-for="entry in confirmations"
          :key="`${entry.timestamp}:${entry.title}`"
          class="MyShowsAuthPanel__historyRow"
          :class="`MyShowsAuthPanel__historyRow--${entry.status}`"
        >
          <span class="MyShowsAuthPanel__historyTime">{{ formatTime(entry.timestamp) }}</span>
          <span class="MyShowsAuthPanel__historyTitle">{{ entry.title }}</span>
          <span class="MyShowsAuthPanel__historyStatus">
            {{
              entry.status === 'confirmed'
                ? t('myshowsAuth.history.confirmed')
                : t('myshowsAuth.history.failed')
            }}
          </span>
        </li>
      </ul>
    </div>

    <p class="MyShowsAuthPanel__note">{{ t('myshowsAuth.note') }}</p>
  </section>
</template>

<style scoped>
.MyShowsAuthPanel {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.MyShowsAuthPanel__subtitle {
  opacity: 0.75;
  font-size: 0.9em;
}

.MyShowsAuthPanel__status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.MyShowsAuthPanel__steps {
  margin: 0;
  padding-left: 1.25rem;
}

.MyShowsAuthPanel__history h3 {
  font-size: 0.95em;
  margin: 0 0 0.4rem;
}

.MyShowsAuthPanel__historyEmpty {
  font-size: 0.85em;
  opacity: 0.65;
  margin: 0;
}

.MyShowsAuthPanel__historyList {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 12rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.MyShowsAuthPanel__historyRow {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  font-size: 0.85em;
  padding: 0.2rem 0;
}

.MyShowsAuthPanel__historyTime {
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.MyShowsAuthPanel__historyTitle {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.MyShowsAuthPanel__historyStatus {
  flex-shrink: 0;
  font-weight: 600;
}

.MyShowsAuthPanel__historyRow--confirmed .MyShowsAuthPanel__historyStatus {
  color: #16a34a;
}

.MyShowsAuthPanel__historyRow--failed .MyShowsAuthPanel__historyStatus {
  color: #dc2626;
}

.MyShowsAuthPanel__note {
  font-size: 0.85em;
  opacity: 0.65;
}
</style>
