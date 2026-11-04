<script setup lang="ts">
// Side panel of one task (GET /api/tasks/:id): fields, parent and subtasks, the result (finish's comments), description,
// attachments (raster images previewed, every file downloadable), history. Every text from the store is shown as text (never
// rendered as HTML or Markdown). Reloads on every store change; Esc closes it.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { apiGet, boardToken, errorText } from '../api.ts';
import { dateTimeText, eventLine, eventTimeText, fieldText, isResult, sizeText } from '../format.ts';
import { attachmentHref, taskQuery } from '../query.ts';
import { TEXT } from '../text.ts';
import { inlineImageType } from '../../server/attachment-types.ts';
import type { TaskDetail } from '../types.ts';
import AgentName from './AgentName.vue';
import BoardIcon from './BoardIcon.vue';

const props = defineProps<{ id: string; board: string | null; refreshTick: number; now: Date; hrefFor: (id: string) => string }>();
const emit = defineEmits<{ close: []; open: [id: string] }>();

const task = ref<TaskDetail | null>(null);
const loadError = ref<string | null>(null);
const copyNote = ref<string | null>(null);
const panel = ref<HTMLElement | null>(null);
let request = 0;
// History lines, worked out once per load; `result` marks finish's comments (data.result).
const history = computed(() => (task.value?.events ?? []).map((e) => ({ ...e, line: eventLine(e.type, e.data), result: isResult(e.type, e.data) })));
// The Result block: finish's comments (hand-in and acceptance), oldest first.
const results = computed(() => history.value.filter((e) => e.result));
// Attachments with their file address and whether they show as a preview (raster images only, the server's own list).
const files = computed(() =>
  (task.value?.attachments ?? []).map((a) => ({ ...a, href: attachmentHref(props.id, a.name, props.board, boardToken()), preview: inlineImageType(a.name) !== null })),
);
// Images whose preview failed to load (shown as a plain file row with the reason).
const brokenPreviews = ref(new Set<string>());
let copyTimer: ReturnType<typeof setTimeout> | undefined;

// Load the task; a late answer for another task, board or an older change is dropped.
async function load(): Promise<void> {
  const current = ++request;
  const { id, board } = props;
  // Another task: no stale content while it loads. The same task after a change: keep it on screen until the new one arrives.
  if (task.value?.id !== id) {
    task.value = null;
    brokenPreviews.value = new Set();
  }
  try {
    const data = await apiGet<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}${taskQuery(board)}`);
    if (current !== request) return;
    task.value = data;
    loadError.value = null;
  } catch (err) {
    if (current !== request) return;
    loadError.value = errorText(err);
  }
}

watch(() => [props.id, props.board, props.refreshTick], load, { immediate: true });
// A newly opened task takes the keyboard focus, so Tab continues inside the panel.
watch(
  () => props.id,
  () => nextTick(() => panel.value?.focus()),
  { immediate: true },
);

// Esc closes the panel from anywhere on the page.
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  if (copyTimer) clearTimeout(copyTimer);
});

// Copy the task id; the clipboard may be refused (insecure context, permissions): say so instead of pretending.
async function copyId(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.id);
    copyNote.value = TEXT.copied;
  } catch {
    copyNote.value = TEXT.copyFailed;
  }
  if (copyTimer) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => (copyNote.value = null), 1500);
}

// A preview image did not load (file gone, server stopped): say so instead of an empty frame.
function onPreviewError(name: string): void {
  brokenPreviews.value = new Set([...brokenPreviews.value, name]);
}

// A plain click on a parent or subtask link opens it in this panel; a modified click keeps the browser's own behaviour.
function onTaskLink(event: MouseEvent, id: string): void {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  emit('open', id);
}

// A link worth following: only http(s) URLs become links, everything else stays text.
function isWebLink(kind: string, ref: string): boolean {
  return kind === 'url' && /^https?:\/\//i.test(ref);
}
</script>

<template>
  <aside ref="panel" class="panel" :aria-label="TEXT.panelLabel" tabindex="-1" data-testid="task-panel">
    <div class="p-head">
      <span class="id mono" translate="no">{{ id }}</span>
      <button class="icbtn sm" type="button" :aria-label="TEXT.copyId" :title="TEXT.copyId" @click="copyId">
        <BoardIcon name="copy" :size="14" />
      </button>
      <span v-if="copyNote" class="copy-note" role="status">{{ copyNote }}</span>
      <span v-if="task" class="pill" translate="no">{{ task.status }}</span>
      <button class="icbtn x" type="button" :aria-label="TEXT.closePanel" :title="TEXT.closeHint" @click="emit('close')">
        <BoardIcon name="close" />
      </button>
    </div>
    <div class="p-body">
      <p v-if="loadError" class="state-msg is-error" role="alert">{{ TEXT.taskError }} {{ loadError }}</p>
      <p v-else-if="!task" class="state-msg" role="status">{{ TEXT.taskLoading }}</p>
      <template v-if="task">
        <h2 class="p-title">{{ task.title }}</h2>
        <dl class="fields">
          <dt>{{ TEXT.status }}</dt>
          <dd class="mono" translate="no">{{ task.status }}</dd>
          <dt>{{ TEXT.assignee }}</dt>
          <dd><AgentName :name="task.assignee" large /></dd>
          <dt>{{ TEXT.labels }}</dt>
          <dd>
            <span v-for="label in task.labels" :key="label" class="chip">{{ label }}</span>
            <span v-if="task.labels.length === 0" class="sub">{{ TEXT.none }}</span>
          </dd>
          <template v-if="task.parent_task || task.parent">
            <dt>{{ TEXT.parent }}</dt>
            <dd class="family" data-testid="parent">
              <a v-if="task.parent_task" class="task-link" :href="hrefFor(task.parent_task.id)" @click="onTaskLink($event, task.parent_task.id)">
                <span class="mono" translate="no">{{ task.parent_task.id }}</span>
                <span class="t">{{ task.parent_task.title }}</span>
                <span class="sub mono" translate="no">{{ task.parent_task.status }}</span>
              </a>
              <span v-else class="mono" translate="no">{{ task.parent }}</span>
            </dd>
          </template>
          <template v-if="task.children.length">
            <dt>{{ TEXT.subtasks }}</dt>
            <dd class="family" data-testid="children">
              <a v-for="child in task.children" :key="child.id" class="task-link" :href="hrefFor(child.id)" @click="onTaskLink($event, child.id)">
                <span class="mono" translate="no">{{ child.id }}</span>
                <span class="t">{{ child.title }}</span>
                <span class="sub mono" translate="no">{{ child.status }}</span>
                <span v-if="child.archived" class="sub">{{ TEXT.archivedMark }}</span>
              </a>
            </dd>
          </template>
          <template v-for="(value, key) in task.fields" :key="key">
            <dt class="mono">{{ key }}</dt>
            <dd>{{ fieldText(value) }}</dd>
          </template>
          <template v-if="task.links.length">
            <dt>{{ TEXT.links }}</dt>
            <dd class="links">
              <span v-for="link in task.links" :key="`${link.kind}=${link.ref}`" class="link-row">
                <BoardIcon :name="link.kind === 'commit' ? 'commit' : 'link'" :size="14" />
                <span class="sub">{{ link.kind }}</span>
                <a v-if="isWebLink(link.kind, link.ref)" class="ref" :href="link.ref" target="_blank" rel="noreferrer noopener">{{ link.ref }}</a>
                <span v-else class="ref mono" translate="no">{{ link.ref }}</span>
              </span>
            </dd>
          </template>
          <dt>{{ TEXT.created }}</dt>
          <dd>
            <span class="num">{{ dateTimeText(task.created_at, now) }}</span>
            <span class="sub">{{ TEXT.by }}</span>
            <span class="actor">{{ task.created_by }}</span>
          </dd>
          <dt>{{ TEXT.updated }}</dt>
          <dd>
            <span class="num">{{ dateTimeText(task.updated_at, now) }}</span>
            <span class="sub">{{ TEXT.rev(task.rev) }}</span>
          </dd>
          <template v-if="task.archived_at">
            <dt>{{ TEXT.archived }}</dt>
            <dd class="num">{{ dateTimeText(task.archived_at, now) }}</dd>
          </template>
        </dl>

        <template v-if="results.length">
          <h3>{{ TEXT.result }}</h3>
          <ol class="steps" data-testid="results">
            <li v-for="(event, i) in results" :key="i">
              <div class="step-h">
                <BoardIcon name="result" :size="14" />
                <span class="actor">{{ event.actor }}</span>
                <span class="tm num">{{ eventTimeText(event.at, now) }}</span>
              </div>
              <p class="step-b">{{ event.line.body }}</p>
            </li>
          </ol>
        </template>
        <h3>{{ TEXT.description }}</h3>
        <p v-if="task.description" class="prose">{{ task.description }}</p>
        <p v-else class="sub">{{ TEXT.noDescription }}</p>

        <template v-if="task.attachments.length">
          <h3>
            {{ TEXT.attachments }} <span class="n num">{{ task.attachments.length }}</span>
          </h3>
          <ul class="files">
            <li v-for="file in files" :key="file.name" class="file" :class="{ 'has-preview': file.preview && !brokenPreviews.has(file.name) }" :data-file="file.name">
              <a v-if="file.preview && !brokenPreviews.has(file.name)" class="thumb" :href="file.href" target="_blank" rel="noopener noreferrer" :aria-label="TEXT.openImage(file.name)">
                <img :src="file.href" :alt="TEXT.previewAlt(file.name)" loading="lazy" @error="onPreviewError(file.name)" />
              </a>
              <div class="frow">
                <BoardIcon name="file" />
                <span class="nm">{{ file.name }}</span>
                <span class="sz num">{{ sizeText(file.size) }}</span>
                <a class="icbtn dl" :href="file.href" download :aria-label="TEXT.download(file.name)" :title="TEXT.download(file.name)">
                  <BoardIcon name="download" />
                </a>
              </div>
              <p v-if="brokenPreviews.has(file.name)" class="inline-error" role="alert">{{ TEXT.previewFailed }}</p>
            </li>
          </ul>
        </template>

        <h3>
          {{ TEXT.history }} <span class="n num">{{ task.events.length }}</span>
        </h3>
        <p v-if="task.events_dropped" class="sub note">{{ TEXT.olderDropped(task.events_dropped) }}</p>
        <ol class="hist">
          <li v-for="(event, i) in history" :key="i">
            <span class="tm num">{{ eventTimeText(event.at, now) }}</span>
            <div class="ev">
              <div class="ev-h">
                <b>{{ event.line.title }}</b>
                <span v-if="event.result" class="badge" data-testid="result-badge">{{ TEXT.result }}</span>
                <span v-if="event.line.detail" class="sub" translate="no">{{ event.line.detail }}</span>
                <span class="sub">{{ TEXT.by }}</span>
                <span class="actor">{{ event.actor }}</span>
                <span v-if="event.actor_source === 'default'" class="sub">({{ TEXT.defaultName }})</span>
              </div>
              <p v-if="event.line.body !== null" class="q">{{ event.line.body }}</p>
            </div>
          </li>
        </ol>
      </template>
    </div>
  </aside>
</template>
