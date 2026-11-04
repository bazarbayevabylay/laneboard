<script setup lang="ts">
// One task card of a column: the attention flag (waiting for acceptance, stale), id with the subtask marks, title, labels, the
// newest comment line, who holds it and for how long it has been in its status. Every mark comes from the core (ViewCard, ADR §28);
// the card only shows it. A link, so it opens with the keyboard and in a new tab; a plain click opens the side panel instead.
import { ageText, dateTimeText, WAITING_OWNER_LABEL } from '../format.ts';
import { TEXT } from '../text.ts';
import type { ViewCard } from '../types.ts';
import AgentName from './AgentName.vue';
import BoardIcon from './BoardIcon.vue';

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
  <a
    class="card"
    :class="{ 'is-selected': selected, 'is-handed': card.handed_in, 'is-stale': card.stale }"
    :href="href"
    :aria-current="selected ? 'true' : undefined"
    :data-task="card.id"
    @click="onClick($event, card.id)"
  >
    <span v-if="card.handed_in" class="flag is-handed" :title="TEXT.waitingForAcceptanceTitle" data-testid="flag-handed">
      <BoardIcon name="inbox" />
      <b>{{ TEXT.waitingForAcceptance }}</b>
    </span>
    <span v-else-if="card.stale" class="flag is-stale" :title="TEXT.staleTitle" data-testid="flag-stale">
      <BoardIcon name="clock" />
      <span><b>{{ TEXT.stale }}</b> {{ TEXT.staleFor(ageText(card.updated_at, now)) }}</span>
    </span>
    <span class="c-top">
      <span class="mono" translate="no">{{ card.id }}</span>
      <span v-if="card.parent" class="mark mono" translate="no" :title="TEXT.parentMarkTitle(card.parent)" data-testid="parent-mark">{{ TEXT.parentMark(card.parent) }}</span>
      <span v-if="card.children.total > 0" class="mark kids num" :title="TEXT.childrenMarkTitle(card.children.final, card.children.total)" data-testid="children-mark">
        <BoardIcon name="subtask" :size="14" />{{ TEXT.childrenMark(card.children.final, card.children.total) }}
      </span>
    </span>
    <span class="c-title">{{ card.title }}</span>
    <span v-if="card.labels.length" class="chips">
      <span v-for="label in card.labels" :key="label" class="chip" :class="{ 'is-owner': label === WAITING_OWNER_LABEL }" :title="label === WAITING_OWNER_LABEL ? TEXT.ownerLabelTitle : undefined">{{ label }}</span>
    </span>
    <span
      v-if="card.last_comment"
      class="c-last"
      :class="{ 'is-result': card.last_comment.result }"
      :title="TEXT.lastCommentTitle(card.last_comment.actor, dateTimeText(card.last_comment.at, now))"
      data-testid="last-comment"
    >
      <span v-if="card.last_comment.result" class="badge">{{ TEXT.result }}</span>
      <BoardIcon v-else name="comment" :size="14" />
      <span class="c-last-t">{{ card.last_comment.text }}</span>
    </span>
    <span class="who">
      <AgentName :name="card.assignee" />
      <span class="age num" :title="TEXT.inStatusFor(ageText(card.status_since, now))">{{ ageText(card.status_since, now) }}</span>
    </span>
  </a>
</template>
