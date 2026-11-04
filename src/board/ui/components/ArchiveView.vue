<script setup lang="ts">
// Archive search (GET /api/tasks?scope=archive&text=): archived tasks newest first; a row opens the task panel.
import { onBeforeUnmount, ref, watch } from 'vue';
import { apiGet, errorText } from '../api.ts';
import { dateTimeText } from '../format.ts';
import { tasksQuery } from '../query.ts';
import { TEXT } from '../text.ts';
import type { ListResult } from '../types.ts';
import BoardIcon from './BoardIcon.vue';

const props = defineProps<{ board: string | null; q: string; refreshTick: number; now: Date; selected: string | null; hrefFor: (id: string) => string; boardHref: string }>();
const emit = defineEmits<{ 'update:q': [q: string]; open: [id: string]; back: [] }>();

// One page of results is enough to find a task by words; the total says when there are more.
const LIMIT = 50;
// Typing settles before a search goes out.
const TYPING_MS = 250;

const input = ref(props.q);
const result = ref<ListResult | null>(null);
const searched = ref('');
const loadError = ref<string | null>(null);
const isLoading = ref(false);
let request = 0;
let typing: ReturnType<typeof setTimeout> | undefined;

// Search the archive for `q`; only the newest search writes its answer.
async function search(q: string): Promise<void> {
  const current = ++request;
  const board = props.board;
  isLoading.value = true;
  try {
    const data = await apiGet<ListResult>(`/api/tasks${tasksQuery(board, { scope: 'archive', text: q, limit: LIMIT, offset: 0 })}`);
    if (current !== request) return;
    result.value = data;
    searched.value = q.trim();
    loadError.value = null;
  } catch (err) {
    if (current !== request) return;
    loadError.value = errorText(err);
  } finally {
    if (current === request) isLoading.value = false;
  }
}

// The address or another board changes the query from outside; a store change runs the same search again.
watch(() => [props.q, props.board, props.refreshTick], () => void search(props.q), { immediate: true });
// Back and forward in the browser put other words into the field (a store change does not touch what is being typed).
watch(
  () => props.q,
  (q) => {
    input.value = q;
  },
);

// Typing: wait until it settles, then put the words into the address (which runs the search).
function onInput(): void {
  if (typing) clearTimeout(typing);
  typing = setTimeout(() => emit('update:q', input.value), TYPING_MS);
}
onBeforeUnmount(() => {
  if (typing) clearTimeout(typing);
});
</script>

<template>
  <div class="archive" data-testid="archive">
    <div class="archive-head">
      <a class="btn" :href="boardHref" @click.exact.prevent="emit('back')">
        <BoardIcon name="back" />
        <span>{{ TEXT.backToBoard }}</span>
      </a>
      <label class="ctl search archive-search">
        <BoardIcon name="search" />
        <span class="vh">{{ TEXT.archiveSearchLabel }}</span>
        <input v-model="input" type="search" name="q" :placeholder="TEXT.archiveSearchPlaceholder" autocomplete="off" spellcheck="false" @input="onInput" />
      </label>
      <span v-if="result" class="sub num" role="status">{{ TEXT.archiveTotal(result.items.length, result.total) }}</span>
    </div>
    <p v-if="loadError" class="state-msg is-error" role="alert">{{ TEXT.archiveError }} {{ loadError }}</p>
    <p v-else-if="!result && isLoading" class="state-msg" role="status">{{ TEXT.archiveLoading }}</p>
    <p v-else-if="result && result.items.length === 0" class="state-msg">{{ searched ? TEXT.archiveNoMatch(searched) : TEXT.archiveEmpty }}</p>
    <div v-if="result && result.items.length" class="dlist archive-list">
      <a
        v-for="item in result.items"
        :key="item.id"
        class="drow arow"
        :href="hrefFor(item.id)"
        :title="item.title"
        :aria-current="selected === item.id ? 'true' : undefined"
        :data-task="item.id"
        @click.exact.prevent="emit('open', item.id)"
      >
        <span class="id mono" translate="no">{{ item.id }}</span>
        <span class="t">{{ item.title }}</span>
        <span class="chip" translate="no">{{ item.status }}</span>
        <span class="a num">{{ dateTimeText(item.updated_at, now) }}</span>
      </a>
    </div>
  </div>
</template>
