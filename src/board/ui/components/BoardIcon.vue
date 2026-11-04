<script setup lang="ts">
// Stroke icons of the board (16×16 grid, 1.5 stroke), decorative: the text next to them names the thing.
export type IconName =
  | 'brand'
  | 'status-first'
  | 'status-middle'
  | 'status-final'
  | 'status-unknown'
  | 'search'
  | 'chevron'
  | 'close'
  | 'copy'
  | 'archive'
  | 'filter'
  | 'file'
  | 'warning'
  | 'commit'
  | 'link'
  | 'back';

withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 16 });
</script>

<template>
  <svg v-if="name === 'brand'" class="ic" :width="size" :height="size" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <rect x="1.5" y="2" width="4.5" height="16" rx="1.5" />
    <rect x="7.75" y="2" width="4.5" height="11" rx="1.5" />
    <rect x="14" y="2" width="4.5" height="7" rx="1.5" />
  </svg>
  <svg v-else class="ic" :width="size" :height="size" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle v-if="name === 'status-first'" cx="8" cy="8" r="5.75" stroke-dasharray="2.2 1.8" />
    <template v-else-if="name === 'status-middle'">
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 4.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'status-final'">
      <circle cx="8" cy="8" r="6.5" fill="currentColor" stroke="none" />
      <path class="ic-cut" d="M5.25 8.25 7.1 10l3.65-4" />
    </template>
    <template v-else-if="name === 'status-unknown'">
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 5.25v3.25M8 10.75v.01" />
    </template>
    <template v-else-if="name === 'search'">
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.25 10.25 13.5 13.5" />
    </template>
    <path v-else-if="name === 'chevron'" d="M4.5 6.25 8 9.75l3.5-3.5" />
    <path v-else-if="name === 'close'" d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    <template v-else-if="name === 'copy'">
      <rect x="5.25" y="5.25" width="7.5" height="7.5" rx="1.5" />
      <path d="M10.75 5.25v-1A1.5 1.5 0 0 0 9.25 2.75h-5a1.5 1.5 0 0 0-1.5 1.5v5a1.5 1.5 0 0 0 1.5 1.5h1" />
    </template>
    <template v-else-if="name === 'archive'">
      <rect x="2.25" y="3" width="11.5" height="3" rx=".75" />
      <path d="M3.25 6v6.25h9.5V6M6.5 8.75h3" />
    </template>
    <path v-else-if="name === 'filter'" d="M2.75 4.25h10.5M4.75 8h6.5M6.75 11.75h2.5" />
    <template v-else-if="name === 'file'">
      <path d="M4 2.25h5l3 3v8.5H4z" />
      <path d="M9 2.25v3h3" />
    </template>
    <template v-else-if="name === 'warning'">
      <path d="M8 2.75 14 13H2z" />
      <path d="M8 6.5v3M8 11.25v.01" />
    </template>
    <template v-else-if="name === 'commit'">
      <circle cx="8" cy="8" r="2.5" />
      <path d="M1.75 8h3.75M10.5 8h3.75" />
    </template>
    <template v-else-if="name === 'link'">
      <path d="M6.75 9.25a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-.5.5" />
      <path d="M9.25 6.75a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l.5-.5" />
    </template>
    <path v-else-if="name === 'back'" d="M9.5 4 5.5 8l4 4" />
  </svg>
</template>
