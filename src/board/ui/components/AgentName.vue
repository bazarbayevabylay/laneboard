<script setup lang="ts">
// An agent or person: monogram in the name's stable tone, the name (cut with an ellipsis) and its session part kept whole.
import { computed } from 'vue';
import { avatarInitial, avatarTone, splitActor } from '../format.ts';
import { TEXT } from '../text.ts';

const props = withDefaults(defineProps<{ name: string | null; large?: boolean }>(), { large: false });

const parts = computed(() => (props.name === null ? null : splitActor(props.name)));
</script>

<template>
  <span class="who-name" :title="name ?? undefined">
    <span v-if="name === null" class="av none" :class="{ lg: large }" aria-hidden="true"></span>
    <span v-else class="av" :class="[avatarTone(name), { lg: large }]" aria-hidden="true">{{ avatarInitial(name) }}</span>
    <span class="nm">{{ name === null ? TEXT.unassigned : parts?.base }}</span>
    <span v-if="parts?.session" class="ses mono" translate="no">{{ parts.session }}</span>
  </span>
</template>
