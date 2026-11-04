<script setup lang="ts">
// Top bar: the product mark, one tab per board of this machine (the started one first), the live state.
import { clockSecondsText } from '../format.ts';
import { TEXT } from '../text.ts';
import type { BoardTab, LiveState } from '../types.ts';
import BoardIcon from './BoardIcon.vue';

defineProps<{ tabs: BoardTab[]; tabsProblem: string | null; active: string | null; live: LiveState; updatedAt: Date | null; hrefFor: (key: string) => string }>();
const emit = defineEmits<{ select: [key: string] }>();
</script>

<template>
  <header class="top">
    <span class="brand">
      <BoardIcon name="brand" :size="20" />
      <span>{{ TEXT.brand }}</span>
    </span>
    <nav class="tabs" :aria-label="TEXT.boardsNav">
      <template v-for="tab in tabs" :key="tab.key + tab.path">
        <span v-if="tab.missing" class="tab is-missing" aria-disabled="true" :title="tab.problem ? TEXT.unreadableBoardTitle(tab.problem) : TEXT.missingBoardTitle(tab.path)">
          <span>{{ tab.name ?? tab.prefix }}</span>
          <span class="pfx mono" translate="no">{{ tab.prefix }}</span>
          <span class="miss"><BoardIcon name="warning" :size="14" />{{ TEXT.missingBoard }}</span>
        </span>
        <a
          v-else
          class="tab"
          :href="hrefFor(tab.key)"
          :aria-current="tab.key === active ? 'page' : undefined"
          :title="tab.description ?? undefined"
          :data-board="tab.key"
          @click.exact.prevent="emit('select', tab.key)"
        >
          <span>{{ tab.name ?? tab.prefix }}</span>
          <span class="pfx mono" translate="no">{{ tab.prefix }}</span>
          <span class="cnt num" :title="TEXT.activeTasks(tab.active)">{{ tab.active }}</span>
        </a>
      </template>
      <span v-if="tabsProblem" class="tab is-missing" :title="tabsProblem" data-testid="tabs-problem">
        <span class="miss"><BoardIcon name="warning" :size="14" />{{ TEXT.otherBoardsUnavailable }}</span>
      </span>
    </nav>
    <div class="live" :class="`is-${live}`" role="status" aria-live="polite" data-testid="live">
      <span class="dot" aria-hidden="true"></span>
      <b>{{ live === 'live' ? TEXT.live : live === 'polling' ? TEXT.polling : live === 'offline' ? TEXT.offline : TEXT.connecting }}</b>
      <span v-if="live === 'polling'">{{ TEXT.pollingNote }}</span>
      <span v-if="updatedAt" class="num">{{ TEXT.updatedAt(clockSecondsText(updatedAt)) }}</span>
    </div>
  </header>
</template>
