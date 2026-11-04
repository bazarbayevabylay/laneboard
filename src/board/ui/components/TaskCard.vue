<script setup lang="ts">
// One task card of a column: id, title, labels, who holds it and for how long it has been in its status. A link, so it opens
// with the keyboard and in a new tab; a plain click opens the side panel instead.
import { ageText } from '../format.ts';
import { TEXT } from '../text.ts';
import type { ViewCard } from '../types.ts';
import AgentName from './AgentName.vue';

defineProps<{ card: ViewCard; now: Date; href: string; selected: boolean }>();
const emit = defineEmits<{ open: [id: string] }>();

// A plain click opens the panel in place; a modified click (new tab, new window) keeps the browser's own behaviour.
function onClick(event: MouseEvent, id: string): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  emit('open', id);
}
</script>

<template>
  <a class="card" :class="{ 'is-selected': selected }" :href="href" :aria-current="selected ? 'true' : undefined" :data-task="card.id" @click="onClick($event, card.id)">
    <!-- S5w2: the attention flag row (handed in, stale) goes above the id row. -->
    <span class="c-top">
      <span class="mono" translate="no">{{ card.id }}</span>
    </span>
    <span class="c-title">{{ card.title }}</span>
    <span v-if="card.labels.length" class="chips">
      <span v-for="label in card.labels" :key="label" class="chip">{{ label }}</span>
    </span>
    <!-- S5w2: the last comment line goes here, under the labels. -->
    <span class="who">
      <AgentName :name="card.assignee" />
      <span class="age num" :title="TEXT.inStatusFor(ageText(card.status_since, now))">{{ ageText(card.status_since, now) }}</span>
    </span>
  </a>
</template>
