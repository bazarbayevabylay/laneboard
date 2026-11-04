<script setup lang="ts">
// The web board (read-only, ADR-0001 §31): tabs of the machine's boards, filters, status columns, the archive and a task panel.
// State lives in the address (?board=&task=&view=&assignee=&label=&text=&q=); live updates come from the server's event stream,
// with a 5 s poll when the stream fails, and the board is fetched again every 60 s so ages move on.
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { ApiError, apiGet, boardToken, errorText } from './api.ts';
import { boardQuery, eventsQuery, hasFilters, parseState, stateSearch } from './query.ts';
import type { BoardFilters as Filters, PageState } from './query.ts';
import { TEXT } from './text.ts';
import type { BoardData, BoardTab, LiveState } from './types.ts';
import ArchiveView from './components/ArchiveView.vue';
import BoardColumn from './components/BoardColumn.vue';
import BoardFilters from './components/BoardFilters.vue';
import BoardIcon from './components/BoardIcon.vue';
import BoardTopBar from './components/BoardTopBar.vue';
import TaskPanel from './components/TaskPanel.vue';

// Poll interval after the event stream failed, and the plain refresh interval (ages, other boards' counts).
const POLL_MS = 5000;
const REFRESH_MS = 60_000;

const page = reactive<PageState>(parseState(window.location.search));
const tabs = ref<BoardTab[]>([]);
// Why the other boards of the machine are not listed (a broken registry, a failed call); null = all listed.
const tabsProblem = ref<string | null>(null);
const board = ref<BoardData | null>(null);
const boardError = ref<string | null>(null);
const now = ref(new Date());
const updatedAt = ref<Date | null>(null);
const live = ref<LiveState>('connecting');
// Bumped on every store change: the open panel and the archive load again.
const refreshTick = ref(0);
const finalOpen = ref(false);

let boardRequest = 0;
let tabsRequest = 0;
let stream: EventSource | null = null;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

const filters = computed<Filters>(() => ({ assignee: page.assignee, label: page.label, text: page.text }));
const activeKey = computed(() => page.board ?? tabs.value[0]?.key ?? null);
const activeTab = computed(() => tabs.value.find((t) => t.key === activeKey.value) ?? null);
const title = computed(() => board.value?.name ?? activeTab.value?.name ?? board.value?.prefix ?? activeTab.value?.prefix ?? TEXT.brand);
const description = computed(() => board.value?.description ?? activeTab.value?.description ?? '');
const isEmpty = computed(() => board.value !== null && board.value.shown + board.value.final_shown === 0);

// Address of a page state (the current one with changes), for links that also work in a new tab.
function hrefWith(change: Partial<PageState>): string {
  return stateSearch({ ...page, ...change }) || window.location.pathname;
}
const taskHref = (id: string): string => hrefWith({ task: id });
const tabHref = (key: string): string => stateSearch({ board: key, task: null, view: 'board', assignee: null, label: null, text: '', q: '' }) || window.location.pathname;
const archiveHref = computed(() => hrefWith({ view: 'archive', task: null }));
const boardHref = computed(() => hrefWith({ view: 'board', task: null }));

// Write the page state into the address: push = a step back can undo it (board, task, view); replace = filters while typing.
function saveState(mode: 'push' | 'replace'): void {
  const url = stateSearch(page) || window.location.pathname;
  if (mode === 'push') window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
}

// Fetch the board with the current filters; only the newest request writes its answer.
async function loadBoard(): Promise<void> {
  const request = ++boardRequest;
  try {
    const data = await apiGet<BoardData>(`/api/board${boardQuery(page.board, filters.value)}`);
    if (request !== boardRequest) return;
    board.value = data;
    boardError.value = null;
    now.value = new Date();
    updatedAt.value = now.value;
    if (live.value === 'offline') live.value = stream ? 'live' : 'polling';
  } catch (err) {
    if (request !== boardRequest) return;
    boardError.value = errorText(err);
    if (err instanceof ApiError && err.kind === 'network') live.value = 'offline';
  }
}

// Fetch the tabs (the boards of this machine and their active counts).
async function loadTabs(): Promise<void> {
  const request = ++tabsRequest;
  try {
    const data = await apiGet<{ boards: BoardTab[]; registry_problem: string | null }>('/api/boards');
    if (request !== tabsRequest) return;
    tabs.value = data.boards;
    tabsProblem.value = data.registry_problem;
  } catch (err) {
    // The tabs keep their last state; the marker in the tab row says why they may be out of date.
    if (request === tabsRequest) tabsProblem.value = errorText(err);
  }
}

// Something changed in the store: the board, the tabs, the open panel and the archive load again.
function onStoreChange(): void {
  refreshTick.value++;
  void loadBoard();
  void loadTabs();
}

// Stop the event stream and the fallback poll.
function closeStream(): void {
  stream?.close();
  stream = null;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
}

// Listen to the current board's changes; when the stream fails, poll every 5 s instead.
function openStream(): void {
  closeStream();
  live.value = 'connecting';
  const es = new EventSource(`/api/events${eventsQuery(page.board, boardToken())}`);
  stream = es;
  es.addEventListener('open', () => {
    if (stream === es) live.value = 'live';
  });
  es.addEventListener('change', () => {
    if (stream === es) onStoreChange();
  });
  es.addEventListener('error', () => {
    if (stream !== es) return;
    es.close();
    stream = null;
    live.value = 'polling';
    pollTimer = setInterval(onStoreChange, POLL_MS);
  });
}

// Open another board's tab: its own filters start empty, the panel closes.
function selectBoard(key: string): void {
  Object.assign(page, { board: key, task: null, view: 'board', assignee: null, label: null, text: '', q: '' });
  saveState('push');
  board.value = null;
  finalOpen.value = false;
  void loadBoard();
  openStream();
}

// New filters: into the address (replace, so typing does not fill the history) and to the server.
function setFilters(f: Filters): void {
  Object.assign(page, f);
  saveState('replace');
  void loadBoard();
}

// Open or close the task panel.
function openTask(id: string): void {
  page.task = id;
  saveState('push');
}
function closeTask(): void {
  const id = page.task;
  page.task = null;
  saveState('push');
  // Back to where the keyboard was: the card of that task, when it is on screen.
  if (id) document.querySelector<HTMLElement>(`[data-task="${CSS.escape(id)}"]`)?.focus();
}

// Switch between the board and the archive search.
function showArchive(): void {
  Object.assign(page, { view: 'archive', task: null });
  saveState('push');
}
function showBoard(): void {
  Object.assign(page, { view: 'board', task: null, q: '' });
  saveState('push');
  void loadBoard();
}
function setArchiveQuery(q: string): void {
  page.q = q;
  saveState('replace');
}

// Back and forward: take the state from the address again.
function onPopState(): void {
  const before = page.board;
  Object.assign(page, parseState(window.location.search));
  void loadBoard();
  if (page.board !== before) openStream();
}

// Clear every filter (the empty-result banner).
function clearFilters(): void {
  setFilters({ assignee: null, label: null, text: '' });
}

onMounted(() => {
  window.addEventListener('popstate', onPopState);
  void loadTabs();
  void loadBoard();
  openStream();
  refreshTimer = setInterval(() => {
    void loadBoard();
    void loadTabs();
  }, REFRESH_MS);
});
onBeforeUnmount(() => {
  window.removeEventListener('popstate', onPopState);
  closeStream();
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<template>
  <a class="skip" href="#board">{{ TEXT.skipToBoard }}</a>
  <BoardTopBar :tabs="tabs" :tabs-problem="tabsProblem" :active="activeKey" :live="live" :updated-at="updatedAt" :href-for="tabHref" @select="selectBoard" />
  <div class="work" :class="{ closed: !page.task }">
    <main id="board" class="board" tabindex="-1">
      <div class="head">
        <div class="titles">
          <h1>{{ title }}</h1>
          <p v-if="description" class="desc" :title="description">{{ description }}</p>
        </div>
        <div v-if="page.view === 'board'" class="head-tools">
          <BoardFilters :filters="filters" :assignees="board?.assignees ?? []" :labels="board?.labels ?? []" @change="setFilters" />
          <a class="clear archive-link" :href="archiveHref" data-testid="open-archive" @click.exact.prevent="showArchive">
            <BoardIcon name="archive" />
            <span>{{ TEXT.archive }}</span>
          </a>
        </div>
      </div>
      <p v-if="boardError && board && page.view === 'board'" class="banner is-error" role="alert">
        {{ TEXT.refreshError }} {{ boardError }}
        <button class="btn" type="button" @click="loadBoard">{{ TEXT.retry }}</button>
      </p>
      <ArchiveView
        v-if="page.view === 'archive'"
        :board="page.board"
        :q="page.q"
        :refresh-tick="refreshTick"
        :now="now"
        :selected="page.task"
        :href-for="taskHref"
        :board-href="boardHref"
        @update:q="setArchiveQuery"
        @open="openTask"
        @back="showBoard"
      />
      <template v-else>
        <div v-if="!board && boardError" class="state-msg is-error" role="alert">
          {{ TEXT.boardError }} {{ boardError }}
          <button class="btn" type="button" @click="loadBoard">{{ TEXT.retry }}</button>
        </div>
        <p v-else-if="!board" class="state-msg" role="status">{{ TEXT.loadingBoard }}</p>
        <div v-else class="lanes" :class="{ empty: isEmpty }" data-testid="lanes">
          <BoardColumn
            v-for="(column, i) in board.columns"
            :key="column.status"
            :column="column"
            :kind="!column.known ? 'unknown' : column.status === board.final_status ? 'final' : i === 0 ? 'first' : 'middle'"
            :final-shown="board.final_shown"
            :open="finalOpen"
            :now="now"
            :board="page.board"
            :filters="filters"
            :selected="page.task"
            :href-for="taskHref"
            :archive-href="archiveHref"
            @open="openTask"
            @toggle="finalOpen = !finalOpen"
            @archive="showArchive"
          />
          <div v-if="isEmpty" class="nores" role="status">
            <template v-if="hasFilters(filters)">
              <span><b>{{ TEXT.noMatch }}</b> {{ TEXT.filterSummary(page.assignee, page.label, page.text.trim() || null) }}</span>
              <button class="btn" type="button" @click="clearFilters">{{ TEXT.clearFilters }}</button>
            </template>
            <span v-else><b>{{ TEXT.noTasks }}</b> {{ TEXT.noTasksHint }}</span>
          </div>
        </div>
      </template>
    </main>
    <TaskPanel v-if="page.task" :id="page.task" :board="page.board" :refresh-tick="refreshTick" :now="now" @close="closeTask" />
  </div>
</template>
