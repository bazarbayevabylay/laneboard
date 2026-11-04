<script setup lang="ts">
// One status column. The final column starts collapsed (title and count); open, it lists the newest tasks of the board view and
// loads the rest on demand from GET /api/tasks?status=<final> with the same filters.
import { computed, ref, watch } from 'vue';
import { apiGet, errorText } from '../api.ts';
import { ageText } from '../format.ts';
import { tasksQuery } from '../query.ts';
import type { BoardFilters } from '../query.ts';
import { TEXT } from '../text.ts';
import type { BoardColumnData, ListItem, ListResult } from '../types.ts';
import BoardIcon from './BoardIcon.vue';
import TaskCard from './TaskCard.vue';

const props = defineProps<{
  column: BoardColumnData;
  kind: 'first' | 'middle' | 'final' | 'unknown';
  // The final column's count: every task in the final status after the filters (the view lists the newest few).
  finalShown: number;
  open: boolean;
  now: Date;
  board: string | null;
  filters: BoardFilters;
  selected: string | null;
  hrefFor: (id: string) => string;
  archiveHref: string;
}>();
const emit = defineEmits<{ open: [id: string]; toggle: []; archive: [] }>();

// Page size of the rest of the final column, and the most rows a refresh fetches again (the default list_limit_max).
const PAGE = 50;
const MAX_ROWS = 200;

const count = computed(() => (props.kind === 'final' ? props.finalShown : props.column.cards.length));
const icon = computed(() => `status-${props.kind}` as const);
// Rows of the rest of the final column, loaded on demand; null = not loaded.
const rest = ref<ListItem[] | null>(null);
const restTotal = ref(0);
const isLoadingMore = ref(false);
const moreError = ref<string | null>(null);
let restRequest = 0;

// Another board or other filters: the loaded rows belong to another list, drop them (the button loads them again).
watch(
  () => [props.board, props.filters.assignee, props.filters.label, props.filters.text],
  () => {
    restRequest++;
    rest.value = null;
    restTotal.value = 0;
    moreError.value = null;
    isLoadingMore.value = false;
  },
);
// A write on the board (a new column state): rows already loaded are fetched again, as many as were shown.
watch(
  () => props.column,
  () => {
    if (rest.value !== null) void fetchRest(0, Math.min(MAX_ROWS, Math.max(PAGE, rest.value.length)), true);
  },
);

// Rows shown in the open final column: the view's newest cards, then the loaded rest (without repeats).
const rows = computed(() => {
  const first = props.column.cards.map((c) => ({ id: c.id, title: c.title, since: c.status_since }));
  const seen = new Set(first.map((r) => r.id));
  const more = (rest.value ?? []).filter((i) => !seen.has(i.id)).map((i) => ({ id: i.id, title: i.title, since: i.updated_at }));
  return [...first, ...more];
});
const remaining = computed(() => (rest.value === null ? props.column.more : Math.max(0, restTotal.value - rows.value.length)));

// Fetch rows of the final column (replace: a refresh from the top; else the next page); a late answer for an older state is dropped.
async function fetchRest(offset: number, limit: number, replace: boolean): Promise<void> {
  const request = ++restRequest;
  isLoadingMore.value = true;
  moreError.value = null;
  try {
    const page = await apiGet<ListResult>(
      `/api/tasks${tasksQuery(props.board, { status: props.column.status, assignee: props.filters.assignee, label: props.filters.label, text: props.filters.text, limit, offset })}`,
    );
    if (request !== restRequest) return;
    rest.value = replace ? page.items : [...(rest.value ?? []), ...page.items];
    restTotal.value = page.total;
  } catch (err) {
    if (request !== restRequest) return;
    moreError.value = errorText(err);
  } finally {
    if (request === restRequest) isLoadingMore.value = false;
  }
}

// The "N more" button: the next page; a second click while it loads does nothing.
function loadMore(): void {
  if (isLoadingMore.value) return;
  void fetchRest(rest.value?.length ?? 0, PAGE, false);
}
</script>

<template>
  <section class="lane" :class="{ 'is-collapsed': kind === 'final' && !open }" :aria-label="TEXT.laneLabel(column.status, count)" :data-status="column.status">
    <h2 class="lane-h">
      <BoardIcon :name="icon" class="st" />
      <span class="lane-name" translate="no">{{ column.status }}</span>
      <span class="n num">{{ count }}</span>
      <span v-if="kind === 'unknown'" class="note" :title="TEXT.unknownStatusTitle">{{ TEXT.unknownStatus }}</span>
      <button v-if="kind === 'final' && open && count > 0" class="lane-toggle" type="button" :aria-expanded="true" @click="emit('toggle')">{{ TEXT.hideFinal }}</button>
    </h2>
    <div class="lane-b">
      <template v-if="kind !== 'final'">
        <TaskCard v-for="card in column.cards" :key="card.id" :card="card" :now="now" :href="hrefFor(card.id)" :selected="selected === card.id" @open="emit('open', $event)" />
      </template>
      <p v-else-if="count === 0" class="lane-empty">{{ TEXT.emptyLane }}</p>
      <button v-else-if="!open" class="lane-open" type="button" :aria-expanded="false" :aria-label="TEXT.finalCollapsedLabel(column.status)" @click="emit('toggle')">
        {{ TEXT.showFinal(count) }}
      </button>
      <div v-else class="dlist">
        <a
          v-for="row in rows"
          :key="row.id"
          class="drow"
          :href="hrefFor(row.id)"
          :title="row.title"
          :aria-current="selected === row.id ? 'true' : undefined"
          :data-task="row.id"
          @click.exact.prevent="emit('open', row.id)"
        >
          <span class="id mono" translate="no">{{ row.id }}</span>
          <span class="t">{{ row.title }}</span>
          <span class="a num">{{ ageText(row.since, now) }}</span>
        </a>
        <button v-if="remaining > 0" class="more" type="button" :disabled="isLoadingMore" @click="loadMore">
          {{ isLoadingMore ? TEXT.loadingMore : TEXT.moreFinal(remaining) }}
        </button>
        <p v-if="moreError" class="inline-error" role="alert">{{ TEXT.moreError }} {{ moreError }}</p>
        <a class="more" :href="archiveHref" @click.exact.prevent="emit('archive')">
          <BoardIcon name="archive" />
          <span>{{ TEXT.searchArchive }}</span>
        </a>
      </div>
      <p v-if="kind !== 'final' && column.cards.length === 0" class="lane-empty">{{ TEXT.emptyLane }}</p>
    </div>
  </section>
</template>
