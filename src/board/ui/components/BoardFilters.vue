<script setup lang="ts">
// Filters of the board: assignee, label and text, passed to the core as they are (GET /api/board); Clear drops all three.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { hasFilters } from '../query.ts';
import type { BoardFilters } from '../query.ts';
import { TEXT } from '../text.ts';
import BoardIcon from './BoardIcon.vue';

const props = defineProps<{ filters: BoardFilters; assignees: string[]; labels: string[] }>();
const emit = defineEmits<{ change: [filters: BoardFilters] }>();

// Typing settles before the board is asked again.
const TYPING_MS = 250;
const text = ref(props.filters.text);
let typing: ReturnType<typeof setTimeout> | undefined;

// The address (back, forward, Clear) changes the text from outside.
watch(
  () => props.filters.text,
  (t) => {
    text.value = t;
  },
);

// Options always include the chosen value (a link may name someone with no active task left).
const assigneeOptions = computed(() => withChosen(props.assignees, props.filters.assignee));
const labelOptions = computed(() => withChosen(props.labels, props.filters.label));

// The list with `chosen` added when it is missing.
function withChosen(list: string[], chosen: string | null): string[] {
  return chosen === null || list.includes(chosen) ? list : [chosen, ...list];
}

// A select's value: '' = no filter.
function picked(event: Event): string | null {
  const value = (event.target as HTMLSelectElement).value;
  return value === '' ? null : value;
}

// Typing: wait until it settles, then filter.
function onText(): void {
  if (typing) clearTimeout(typing);
  typing = setTimeout(() => emit('change', { ...props.filters, text: text.value }), TYPING_MS);
}

// Drop every filter at once.
function clearAll(): void {
  if (typing) clearTimeout(typing);
  text.value = '';
  emit('change', { assignee: null, label: null, text: '' });
}

onBeforeUnmount(() => {
  if (typing) clearTimeout(typing);
});
</script>

<template>
  <div class="filters" role="search" :aria-label="TEXT.filtersLabel">
    <label class="ctl" :class="{ on: filters.assignee !== null }">
      <span class="k">{{ TEXT.assignee }}</span>
      <select name="assignee" autocomplete="off" :value="filters.assignee ?? ''" @change="emit('change', { ...filters, assignee: picked($event) })">
        <option value="">{{ TEXT.everyone }}</option>
        <option v-for="a in assigneeOptions" :key="a" :value="a">{{ a }}</option>
      </select>
      <BoardIcon name="chevron" class="chev" />
    </label>
    <label class="ctl" :class="{ on: filters.label !== null }">
      <span class="k">{{ TEXT.label }}</span>
      <select name="label" autocomplete="off" :value="filters.label ?? ''" @change="emit('change', { ...filters, label: picked($event) })">
        <option value="">{{ TEXT.anyLabel }}</option>
        <option v-for="l in labelOptions" :key="l" :value="l">{{ l }}</option>
      </select>
      <BoardIcon name="chevron" class="chev" />
    </label>
    <label class="ctl search" :class="{ on: filters.text.trim() !== '' }">
      <BoardIcon name="search" />
      <input v-model="text" type="search" name="text" :placeholder="TEXT.searchPlaceholder" :aria-label="TEXT.searchLabel" autocomplete="off" spellcheck="false" @input="onText" />
    </label>
    <button v-if="hasFilters(filters)" class="clear" type="button" @click="clearAll">{{ TEXT.clear }}</button>
  </div>
</template>
