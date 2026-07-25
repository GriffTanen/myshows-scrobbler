<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { MyShowsConfirmation } from '../../types'

const props = defineProps<{
  item: MyShowsConfirmation
}>()

const { t } = useI18n()

const time = computed(() => {
  const d = new Date(props.item.timestamp)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
})

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}
</script>

<template>
  <div class="EventRow" :class="item.status === 'confirmed' ? 'EventRow--ok' : 'EventRow--err'">
    <div class="EventRow__main">
      <span class="EventRow__time">{{ time }}</span>
      <span
        class="EventRow__type"
        :class="item.status === 'confirmed' ? 'EventRow__type--ok' : 'EventRow__type--err'"
      >
        MS
      </span>
      <span class="EventRow__title">{{ item.title }}</span>
      <span class="MyShowsConfirmationRow__status">
        {{
          item.status === 'confirmed' ? t('events.myshows.confirmed') : t('events.myshows.failed')
        }}
      </span>
    </div>
  </div>
</template>

<style lang="scss">
.MyShowsConfirmationRow__status {
  font-size: 11px;
  font-weight: 600;
  color: var(--v2-text-muted);
  white-space: nowrap;
}

.EventRow--ok .MyShowsConfirmationRow__status {
  color: var(--v2-success);
}
.EventRow--err .MyShowsConfirmationRow__status {
  color: var(--v2-error);
}
</style>
