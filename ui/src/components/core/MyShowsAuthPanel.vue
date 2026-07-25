<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import StatusDot, { type DotState } from './ui/StatusDot.vue'
import Toggle from './ui/Toggle.vue'
import { fetchMyShowsAuthStatus } from '../../api'

const props = defineProps<{
  /** Whether the auto-confirm feature is enabled in config. */
  autoConfirm: boolean
}>()

const emit = defineEmits<{
  'update:autoConfirm': [value: boolean]
}>()

const { t } = useI18n()

const connected = ref<boolean | null>(null)
const checking = ref(false)

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

/**
 * A one-line hint that reconciles the two independent states — the browser session
 * (connected) and the feature flag (autoConfirm) — into plain guidance, so a user isn't
 * left wondering why nothing gets confirmed. Empty when everything lines up.
 */
const hint = computed<string>(() => {
  if (props.autoConfirm && connected.value === false) {
    return t('myshowsAuth.hint.onNoSession')
  }
  if (!props.autoConfirm && connected.value === true) {
    return t('myshowsAuth.hint.offHasSession')
  }
  return ''
})

async function refresh(): Promise<void> {
  checking.value = true
  try {
    const res = await fetchMyShowsAuthStatus()
    connected.value = res.connected
  } catch {
    connected.value = null
  } finally {
    checking.value = false
  }
}

onMounted(refresh)
</script>

<template>
  <section class="Panel MyShowsAuthPanel">
    <header class="Panel__header">
      <h3 class="Panel__title">{{ t('myshowsAuth.title') }}</h3>
      <div class="MyShowsAuthPanel__status">
        <StatusDot :state="dotState" pulse />
        <span>{{
          connected ? t('myshowsAuth.status.connected') : t('myshowsAuth.status.disconnected')
        }}</span>
        <button
          type="button"
          class="MyShowsAuthPanel__refresh"
          :disabled="checking"
          :title="t('myshowsAuth.refreshTitle')"
          @click="refresh"
        >
          {{ checking ? '…' : '↻' }}
        </button>
      </div>
    </header>

    <div class="Panel__body">
      <div class="MyShowsAuthPanel__toggle">
        <Toggle
          :model-value="autoConfirm"
          tone="ok"
          :aria-label="t('myshowsAuth.toggle.label')"
          @update:model-value="emit('update:autoConfirm', $event)"
        />
        <div class="MyShowsAuthPanel__toggleText">
          <span class="MyShowsAuthPanel__toggleLabel">{{ t('myshowsAuth.toggle.label') }}</span>
          <span class="MyShowsAuthPanel__toggleHint">{{
            autoConfirm ? t('myshowsAuth.toggle.on') : t('myshowsAuth.toggle.off')
          }}</span>
        </div>
      </div>

      <p v-if="hint" class="MyShowsAuthPanel__reconcile">{{ hint }}</p>

      <details class="MyShowsAuthPanel__instructions" :open="connected !== true">
        <summary>{{ t('myshowsAuth.instructionsTitle') }}</summary>
        <ol>
          <li>
            {{ t('myshowsAuth.instructions.step1') }}
            <a class="MyShowsAuthPanel__download" href="/extension.zip" download>
              {{ t('myshowsAuth.download') }}
            </a>
          </li>
          <li>{{ t('myshowsAuth.instructions.step2') }}</li>
          <li>{{ t('myshowsAuth.instructions.step3') }}</li>
          <li>{{ t('myshowsAuth.instructions.step4') }}</li>
        </ol>
      </details>

      <p class="MyShowsAuthPanel__note">{{ t('myshowsAuth.note') }}</p>
    </div>
  </section>
</template>

<style lang="scss">
.MyShowsAuthPanel {
  &__status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--v2-text-muted);
    white-space: nowrap;
  }

  &__refresh {
    border: none;
    background: none;
    cursor: pointer;
    color: var(--v2-text-muted);
    font-size: 12px;
    padding: 2px 4px;
    line-height: 1;

    &:hover:not(:disabled) {
      color: var(--v2-text);
    }
    &:disabled {
      cursor: default;
      opacity: 0.6;
    }
  }

  &__toggle {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
  }

  &__toggleText {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  &__toggleLabel {
    font-size: 13px;
    font-weight: 600;
    color: var(--v2-text);
  }

  &__toggleHint {
    font-size: 11px;
    color: var(--v2-text-muted);
  }

  &__reconcile {
    margin: 0;
    padding: 0 16px 8px;
    font-size: 12px;
    color: var(--v2-warning, #b45309);
  }

  &__instructions {
    padding: 12px 16px;
    font-size: 13px;

    summary {
      cursor: pointer;
      font-weight: 600;
      color: var(--v2-text-soft);
      list-style: none;

      &::before {
        content: '▸ ';
        color: var(--v2-text-muted);
      }
    }

    &[open] summary::before {
      content: '▾ ';
    }

    ol {
      margin: 8px 0 0;
      padding-left: 20px;
      color: var(--v2-text-soft);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
  }

  &__download {
    color: var(--v2-brand, #e11d48);
    font-weight: 600;
    text-decoration: underline;
  }

  &__note {
    margin: 0;
    padding: 0 16px 12px;
    font-size: 11px;
    color: var(--v2-text-dim);
  }
}
</style>
