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

.MyShowsAuthPanel__note {
  font-size: 0.85em;
  opacity: 0.65;
}
</style>
