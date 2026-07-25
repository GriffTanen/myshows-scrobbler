<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import StatusDot, { type DotState } from './ui/StatusDot.vue'
import { fetchMyShowsAuthStatus, syncPreview, syncApply, type SyncPreview } from '../../api'
import type { SyncProgress } from '../../types'

const props = defineProps<{
  /** Live import progress from the WS bus (null when idle). */
  progress: SyncProgress | null
}>()

const { t } = useI18n()

type Phase = 'idle' | 'scanning' | 'preview' | 'importing' | 'done'
const phase = ref<Phase>('idle')
const connected = ref<boolean | null>(null)
const preview = ref<SyncPreview | null>(null)
const result = ref<{ added: number; skipped: number; failed: number } | null>(null)
const errorMsg = ref('')
const showUnmatched = ref(false)

const dotState = computed<DotState>(() =>
  connected.value === true ? 'ok' : connected.value === false ? 'disabled' : 'unknown',
)

// Reflect live scan/import progress from the WS bus into a percentage + counter.
const progressPct = computed<number>(() => {
  const p = props.progress
  if (!p || p.total === 0) {
    return 0
  }
  return Math.round((p.done / p.total) * 100)
})

async function refreshStatus(): Promise<void> {
  try {
    connected.value = (await fetchMyShowsAuthStatus()).connected
  } catch {
    connected.value = null
  }
}

async function runPreview(): Promise<void> {
  errorMsg.value = ''
  phase.value = 'scanning'
  try {
    const res = await syncPreview()
    if (res.status !== 'ok' || !res.preview) {
      errorMsg.value = res.reason ?? t('sync.error.generic')
      phase.value = 'idle'
      return
    }
    preview.value = res.preview
    phase.value = 'preview'
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
    phase.value = 'idle'
  }
}

async function runApply(): Promise<void> {
  errorMsg.value = ''
  phase.value = 'importing'
  try {
    const res = await syncApply()
    if (res.status !== 'ok' || !res.result) {
      errorMsg.value = res.reason ?? t('sync.error.generic')
      phase.value = 'preview'
      return
    }
    result.value = res.result
    phase.value = 'done'
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
    phase.value = 'preview'
  }
}

function reset(): void {
  phase.value = 'idle'
  preview.value = null
  result.value = null
  showUnmatched.value = false
}

// When a fresh scan starts the backend may still be streaming the previous run's progress;
// clear stale state as the user re-enters idle.
watch(phase, (p) => {
  if (p === 'idle') {
    errorMsg.value = ''
  }
})

onMounted(refreshStatus)
</script>

<template>
  <section class="Panel SyncPanel">
    <header class="Panel__header">
      <h3 class="Panel__title">{{ t('sync.title') }}</h3>
      <div class="SyncPanel__status">
        <StatusDot :state="dotState" pulse />
        <span>{{ connected ? t('sync.connected') : t('sync.disconnected') }}</span>
      </div>
    </header>

    <div class="Panel__body">
      <!-- Idle / disconnected -->
      <template v-if="phase === 'idle'">
        <p class="SyncPanel__desc">{{ t('sync.desc') }}</p>
        <button
          type="button"
          class="SyncPanel__btn SyncPanel__btn--primary"
          :disabled="connected !== true"
          @click="runPreview"
        >
          {{ t('sync.cta.preview') }}
        </button>
        <p v-if="errorMsg" class="SyncPanel__error">{{ errorMsg }}</p>
        <p v-if="connected !== true" class="SyncPanel__hint SyncPanel__hint--warn">
          {{ t('sync.needSession') }}
        </p>
        <p v-else class="SyncPanel__hint">{{ t('sync.previewNote') }}</p>
      </template>

      <!-- Scanning -->
      <template v-else-if="phase === 'scanning'">
        <p class="SyncPanel__desc">{{ t('sync.scanning') }}</p>
        <div class="SyncPanel__progress">
          <div class="SyncPanel__progressLine">
            <span class="SyncPanel__spin" />
            <span>{{ t('sync.scanningLine') }}</span>
            <span v-if="progress" class="SyncPanel__meta"
              >{{ progress.done }} / {{ progress.total }}</span
            >
          </div>
          <div class="SyncPanel__bar">
            <div class="SyncPanel__barFill" :style="{ width: progressPct + '%' }" />
          </div>
        </div>
      </template>

      <!-- Preview -->
      <template v-else-if="phase === 'preview' && preview">
        <div class="SyncPanel__found">
          <div class="SyncPanel__foundLabel">{{ t('sync.found') }}</div>
          <div class="SyncPanel__foundCounts">
            <span
              ><b>{{ preview.foundMovies }}</b> {{ t('sync.movies') }}</span
            >
            <span
              ><b>{{ preview.foundEpisodes }}</b> {{ t('sync.episodes') }}</span
            >
          </div>
        </div>

        <div class="SyncPanel__rows">
          <div class="SyncPanel__row SyncPanel__row--ok">
            <span class="SyncPanel__glyph">✔</span>
            <span class="SyncPanel__rowText">{{ t('sync.already') }}</span>
            <span class="SyncPanel__num">{{ preview.already }}</span>
          </div>
          <div class="SyncPanel__row SyncPanel__row--add">
            <span class="SyncPanel__glyph">＋</span>
            <span class="SyncPanel__rowText">{{ t('sync.toAdd') }}</span>
            <span class="SyncPanel__num">{{ preview.toAdd }}</span>
          </div>
          <div v-if="preview.unmatched > 0" class="SyncPanel__row SyncPanel__row--warn">
            <span class="SyncPanel__glyph">⚠</span>
            <span class="SyncPanel__rowText">{{ t('sync.unmatched') }}</span>
            <span class="SyncPanel__num">{{ preview.unmatched }}</span>
          </div>
        </div>

        <details
          v-if="preview.unmatchedList.length"
          class="SyncPanel__unmatched"
          :open="showUnmatched"
        >
          <summary @click.prevent="showUnmatched = !showUnmatched">
            {{ t('sync.showUnmatched', { n: preview.unmatched }) }}
          </summary>
          <ul>
            <li v-for="(u, i) in preview.unmatchedList" :key="i">
              <span>{{ u.label }}</span
              ><span>{{ u.reason }}</span>
            </li>
          </ul>
        </details>

        <div class="SyncPanel__btnRow">
          <button
            type="button"
            class="SyncPanel__btn SyncPanel__btn--primary"
            :disabled="preview.toAdd === 0"
            @click="runApply"
          >
            {{
              preview.toAdd > 0 ? t('sync.cta.import', { n: preview.toAdd }) : t('sync.cta.nothing')
            }}
          </button>
          <button type="button" class="SyncPanel__btn SyncPanel__btn--ghost" @click="reset">
            {{ t('sync.cta.cancel') }}
          </button>
        </div>
        <p v-if="errorMsg" class="SyncPanel__error">{{ errorMsg }}</p>
      </template>

      <!-- Importing -->
      <template v-else-if="phase === 'importing'">
        <p class="SyncPanel__desc">{{ t('sync.importing') }}</p>
        <div class="SyncPanel__progress">
          <div class="SyncPanel__progressLine">
            <span class="SyncPanel__spin" />
            <span>{{ t('sync.importingLine') }}</span>
            <span v-if="progress" class="SyncPanel__meta"
              >{{ progress.done }} / {{ progress.total }}</span
            >
          </div>
          <div class="SyncPanel__bar">
            <div
              class="SyncPanel__barFill SyncPanel__barFill--brand"
              :style="{ width: progressPct + '%' }"
            />
          </div>
        </div>
      </template>

      <!-- Done -->
      <template v-else-if="phase === 'done' && result">
        <div class="SyncPanel__done">
          <div class="SyncPanel__doneHead">
            <span class="SyncPanel__doneCheck">✓</span> {{ t('sync.doneTitle') }}
          </div>
          <div class="SyncPanel__doneStats">
            <span
              >{{ t('sync.stat.added') }} <b>{{ result.added }}</b></span
            >
            <span
              >{{ t('sync.stat.skipped') }} <b>{{ result.skipped }}</b></span
            >
            <span
              >{{ t('sync.stat.failed') }} <b>{{ result.failed }}</b></span
            >
          </div>
          <button type="button" class="SyncPanel__btn SyncPanel__btn--ghost" @click="reset">
            {{ t('sync.cta.again') }}
          </button>
        </div>
      </template>
    </div>
  </section>
</template>

<style lang="scss">
.SyncPanel {
  &__status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--v2-text-muted);
    white-space: nowrap;
  }

  &__desc {
    margin: 0;
    color: var(--v2-text-soft);
    font-size: 13px;
    padding: 12px 16px 0;
  }

  &__btn {
    font: inherit;
    font-weight: 600;
    font-size: 13px;
    border-radius: 9px;
    padding: 10px 14px;
    cursor: pointer;
    border: 1px solid transparent;
    transition: filter 0.14s;
    margin: 12px 16px 0;
    width: calc(100% - 32px);

    &--primary {
      background: var(--v2-brand, #e11d48);
      color: #fff;
    }
    &--primary:hover:not(:disabled) {
      filter: brightness(1.07);
    }
    &--ghost {
      background: transparent;
      color: var(--v2-text-soft);
      border-color: var(--v2-border, #d4d8df);
    }
    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }

  &__btnRow {
    display: flex;
    gap: 10px;
    padding: 12px 16px 0;

    .SyncPanel__btn {
      margin: 0;
      width: auto;
      flex: 1;
    }
  }

  &__hint {
    margin: 0;
    padding: 10px 16px 14px;
    font-size: 11px;
    color: var(--v2-text-dim);

    &--warn {
      color: var(--v2-warning, #b45309);
    }
  }

  &__error {
    margin: 0;
    padding: 8px 16px 0;
    font-size: 12px;
    color: var(--v2-error, #dc2626);
  }

  &__found {
    margin: 12px 16px 0;
    background: var(--v2-bg-inset, rgba(0, 0, 0, 0.03));
    border: 1px solid var(--v2-border, #e2e5ea);
    border-radius: 10px;
    padding: 12px 14px;
  }
  &__foundLabel {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--v2-text-dim);
    margin-bottom: 6px;
  }
  &__foundCounts {
    display: flex;
    gap: 20px;
    font-size: 13px;
    color: var(--v2-text-soft);

    b {
      font-size: 18px;
      font-variant-numeric: tabular-nums;
      color: var(--v2-text);
    }
  }

  &__rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 12px 16px 0;
  }
  &__row {
    display: grid;
    grid-template-columns: 20px 1fr auto;
    align-items: center;
    gap: 10px;
    padding: 9px 10px;
    border-radius: 8px;

    &--ok {
      background: color-mix(in srgb, var(--v2-ok, #16a34a) 12%, transparent);
    }
    &--ok .SyncPanel__num,
    &--ok .SyncPanel__glyph {
      color: var(--v2-ok, #16a34a);
    }
    &--add {
      background: color-mix(in srgb, var(--v2-info, #2563eb) 12%, transparent);
    }
    &--add .SyncPanel__num,
    &--add .SyncPanel__glyph {
      color: var(--v2-info, #2563eb);
    }
    &--warn {
      background: color-mix(in srgb, var(--v2-warning, #b45309) 14%, transparent);
    }
    &--warn .SyncPanel__num,
    &--warn .SyncPanel__glyph {
      color: var(--v2-warning, #b45309);
    }
  }
  &__glyph {
    font-size: 14px;
    font-weight: 700;
    text-align: center;
  }
  &__rowText {
    font-size: 13px;
    color: var(--v2-text-soft);
  }
  &__num {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    font-size: 15px;
  }

  &__unmatched {
    padding: 10px 16px 0;
    font-size: 12px;

    summary {
      cursor: pointer;
      color: var(--v2-warning, #b45309);
      font-weight: 600;
      list-style: none;

      &::before {
        content: '▸ ';
      }
    }
    &[open] summary::before {
      content: '▾ ';
    }
    ul {
      margin: 8px 0 0;
      padding: 0;
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 180px;
      overflow-y: auto;
    }
    li {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      font-family: ui-monospace, monospace;
      color: var(--v2-text-muted);

      span:last-child {
        color: var(--v2-text-dim);
        white-space: nowrap;
      }
    }
  }

  &__progress {
    padding: 12px 16px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  &__progressLine {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: var(--v2-text-soft);
  }
  &__meta {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    color: var(--v2-text-muted);
  }
  &__spin {
    width: 15px;
    height: 15px;
    border: 2px solid var(--v2-border, #e6e9ee);
    border-top-color: var(--v2-brand, #e11d48);
    border-radius: 50%;
    animation: syncspin 0.7s linear infinite;
    flex: none;
  }
  &__bar {
    height: 8px;
    border-radius: 999px;
    background: var(--v2-border, #e6e9ee);
    overflow: hidden;
  }
  &__barFill {
    height: 100%;
    border-radius: 999px;
    background: var(--v2-info, #2563eb);
    transition: width 0.3s ease;

    &--brand {
      background: var(--v2-brand, #e11d48);
    }
  }

  &__done {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  &__doneHead {
    display: flex;
    align-items: center;
    gap: 9px;
    font-weight: 700;
    font-size: 15px;
    color: var(--v2-ok, #16a34a);
  }
  &__doneCheck {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--v2-ok, #16a34a);
    color: #fff;
    display: grid;
    place-items: center;
    font-size: 13px;
  }
  &__doneStats {
    display: flex;
    gap: 18px;
    font-size: 13px;
    color: var(--v2-text-soft);

    b {
      font-variant-numeric: tabular-nums;
    }
  }
}

@keyframes syncspin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .SyncPanel__spin {
    animation: none;
  }
  .SyncPanel__barFill {
    transition: none;
  }
}
</style>
