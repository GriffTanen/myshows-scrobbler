<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import StatusDot, { type DotState } from './ui/StatusDot.vue'
import { fetchMyShowsAuthStatus } from '../../api'

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
      <details class="MyShowsAuthPanel__instructions" :open="connected !== true">
        <summary>{{ t('myshowsAuth.instructionsTitle') }}</summary>
        <ol>
          <li>{{ t('myshowsAuth.instructions.step1') }}</li>
          <li>{{ t('myshowsAuth.instructions.step2') }}</li>
          <li>{{ t('myshowsAuth.instructions.step3') }}</li>
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

  &__note {
    margin: 0;
    padding: 0 16px 12px;
    font-size: 11px;
    color: var(--v2-text-dim);
  }
}
</style>
