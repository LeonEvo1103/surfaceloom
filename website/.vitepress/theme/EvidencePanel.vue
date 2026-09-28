<script setup lang="ts">
import { computed, ref } from 'vue';
import { showcase } from './showcase';

const selected = ref(0);
const active = computed(() => showcase[selected.value]);
</script>

<template>
  <section class="evidence-panel" aria-label="Illustrative reference-agent outcomes">
    <div class="evidence-topline">
      <span><span class="evidence-mark" aria-hidden="true">▦</span> CASE EXPLORER</span>
      <span class="illustration-label">Illustrative view</span>
    </div>
    <div class="case-selector" role="group" aria-label="Choose an example outcome">
      <button v-for="(item, index) in showcase" :key="item.id" type="button"
        :aria-pressed="selected === index" aria-controls="case-evidence"
        @click="selected = index">
        <span>{{ item.id }}</span> {{ item.label }}
      </button>
    </div>
    <div id="case-evidence" class="case-evidence" aria-live="polite" aria-atomic="true">
      <div class="case-heading">
        <span class="panel-kicker">REFERENCE AGENT / {{ active.id }}</span>
        <h2>{{ active.title }}</h2>
      </div>
      <dl class="evidence-chain">
        <div class="evidence-step">
          <dt><span class="step-glyph" aria-hidden="true">◇</span> Approval decision</dt>
          <dd>{{ active.decision }}</dd>
        </div>
        <div class="evidence-step">
          <dt><span class="step-glyph" aria-hidden="true">↳</span> Tool starts</dt>
          <dd class="evidence-count">{{ active.starts === '?' ? 'Unknown' : active.starts }}</dd>
        </div>
        <div class="evidence-step">
          <dt><span class="step-glyph" aria-hidden="true">↳</span> Verified local effects</dt>
          <dd class="evidence-count">{{ active.effects === '?' ? 'Unknown' : active.effects }}</dd>
        </div>
      </dl>
      <div class="evidence-verdict" :class="{ 'is-failed': active.status === 'Failed' }">
        <span><span aria-hidden="true">{{ active.status === 'Passed' ? '✓' : '×' }}</span> {{ active.status }}</span>
        <span>{{ active.complete ? 'Complete ledger' : 'Incomplete ledger' }}</span>
      </div>
      <p class="evidence-note">{{ active.note }}</p>
    </div>
    <div class="evidence-bottomline"><span>REAL BROWSER FIXTURE</span><span>JSON · HTML · EVIDENCE</span></div>
  </section>
</template>
