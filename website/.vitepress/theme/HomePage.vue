<script setup lang="ts">
import { withBase } from 'vitepress';
import EvidencePanel from './EvidencePanel.vue';
import { showcase } from './showcase';

const questions = [
  { number: '01', title: 'Did “deny” really mean no?',
    text: 'Compare the approval decision with the tool ledger and an independent resource probe.',
    link: '/tutorials/approval-testing.html', action: 'Test approval flows' },
  { number: '02', title: 'Did the same thing happen twice?',
    text: 'Check business effects across call IDs. Catch duplicate execution and incomplete observations.',
    link: '/tutorials/tool-side-effects.html', action: 'Test tool side effects' },
  { number: '03', title: 'Can you trust the final result?',
    text: 'Keep unknown execution, missing evidence, and unconfirmed cleanup visible in the report.',
    link: '/guide/capabilities.html', action: 'Understand the boundaries' },
];
</script>

<template>
  <main class="loom-landing">
    <section class="loom-hero loom-wrap" aria-labelledby="hero-title">
      <div class="hero-copy">
        <p class="loom-eyebrow"><span class="loom-dot" aria-hidden="true"></span> OPEN-SOURCE / AI AGENT TESTING</p>
        <h1 id="hero-title">Test what your<br>agent <em>actually did.</em></h1>
        <p class="hero-description">Approval decisions. Tool calls. Real side effects.<br class="desktop-break">
          Bring them together in one repeatable test, with evidence you can inspect.</p>
        <div class="hero-actions">
          <a class="loom-button primary" :href="withBase('/guide/quick-start.html')">Run the example <span aria-hidden="true">↗</span></a>
          <a class="loom-button secondary" href="https://github.com/LeonEvo1103/surfaceloom">View on GitHub <span aria-hidden="true">↗</span></a>
        </div>
        <p class="hero-footnote">Real Chrome / Chromium. No model API key.</p>
      </div>
      <div class="hero-evidence"><EvidencePanel /></div>
    </section>

    <div class="loom-context loom-wrap">
      <span class="context-label">THE WORKFLOW</span>
      <span>Approval</span><span class="context-arrow" aria-hidden="true">→</span>
      <span>Execution</span><span class="context-arrow" aria-hidden="true">→</span>
      <span>Effect</span><span class="context-arrow" aria-hidden="true">→</span>
      <span class="context-last">Evidence</span>
      <a :href="withBase('/guide/reference.html')">Explore the framework <span aria-hidden="true">↗</span></a>
    </div>

    <section class="loom-questions loom-wrap" aria-labelledby="questions-title">
      <div class="section-heading">
        <p class="loom-eyebrow">01 / ASK BETTER QUESTIONS</p>
        <h2 id="questions-title">A plausible answer<br>is only the beginning.</h2>
      </div>
      <div class="question-grid">
        <a v-for="question in questions" :key="question.number" class="question-link" :href="withBase(question.link)">
          <span class="question-number">{{ question.number }} <span aria-hidden="true">↗</span></span>
          <h3>{{ question.title }}</h3>
          <p>{{ question.text }}</p>
          <span class="question-action">{{ question.action }} <span aria-hidden="true">→</span></span>
        </a>
      </div>
    </section>

    <section class="loom-results" aria-labelledby="results-title">
      <div class="loom-wrap results-grid">
        <div class="results-intro">
          <p class="loom-eyebrow">02 / THE REFERENCE FIXTURE</p>
          <h2 id="results-title">Good tests<br>catch bad behavior.</h2>
          <p>Four Cases. One deterministic agent. A real, owned browser for each run.</p>
          <div class="result-tally"><span><b>2</b> passed</span><span><b>2</b> failed</span></div>
          <p class="results-note">The two failures are intentional fixture faults. They stay red in the report. Expected showcase exit: <code>1</code>.</p>
          <a class="loom-text-link" :href="withBase('/guide/quick-start.html')">Run it. Inspect the evidence. <span aria-hidden="true">↗</span></a>
        </div>
        <ol class="outcome-list" aria-label="Expected showcase results">
          <li v-for="item in showcase" :key="item.id">
            <span class="outcome-index" aria-hidden="true">{{ item.id }}</span>
            <div><h3>{{ item.name }}</h3><p>{{ item.detail }}</p></div>
            <span class="outcome-status" :class="item.status.toLowerCase()"><span aria-hidden="true">{{ item.status === 'Passed' ? '✓' : '×' }}</span> {{ item.status }}</span>
          </li>
        </ol>
      </div>
    </section>

    <section class="loom-foundation loom-wrap" aria-label="Platform support and limitations">
      <div class="foundation-copy"><slot /></div>
      <dl class="platform-list">
        <div><dt>Browser <span>Playwright</span></dt><dd>Live approval fixture</dd></div>
        <div><dt>Windows <span>UI Automation</span></dt><dd>Separate C# / UIA fixture</dd></div>
        <div><dt>macOS <span>Accessibility</span></dt><dd>Contract-tested</dd></div>
      </dl>
      <p class="scope-note"><span class="scope-label">EXPERIMENTAL</span> No stable API guarantee. Packages are not published to npm.
        No target-product validation is claimed. The TypeScript-to-native live path is not yet proven.</p>
    </section>

    <section class="loom-start loom-wrap" aria-labelledby="start-title">
      <div><p class="loom-eyebrow">START SMALL. VERIFY SOMETHING REAL.</p>
        <h2 id="start-title">Your first test starts here.</h2>
        <p>Clone the source, run the fixture, and open the report.</p>
      </div>
      <a class="loom-button primary" :href="withBase('/guide/quick-start.html')">Open the quick start <span aria-hidden="true">↗</span></a>
    </section>
  </main>
</template>
