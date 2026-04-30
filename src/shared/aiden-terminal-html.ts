// Custom srcdoc HTML for the IBM 3178 monitor — turns the player's
// approach into a navigable terminal-style portfolio interface
// instead of an embedded Google homepage.
//
// Self-contained: inline CSS + vanilla JS, no fetches, no external
// modules. Designed at ~1240×860 CSS px (the IBM 3178 display
// mesh's bbox at the standard density), with a font/padding that
// renders cleanly through the CRT scanline + vignette overlay.
//
// Content sourced from the personal-site timeline data —
// `~/Stuff/aidens-website/src/content/timeline-data.ts`.

export const AIDEN_TERMINAL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AIDEN ZEGIL // BUILDER</title>
<style>
  :root {
    --bg: #000;
    --fg: #5fff7f;       /* phosphor green */
    --fg-dim: #2f8a45;
    --accent: #fbbf24;   /* amber highlight */
    --accent-dim: #b88412;
    --link: #5fd1ff;
    --link-hover: #b9ecff;
  }
  html, body {
    margin: 0; padding: 0; height: 100%;
    background: var(--bg);
    color: var(--fg);
    font-family: 'IBM Plex Mono', 'JetBrains Mono', 'Courier New', ui-monospace, monospace;
    font-size: 13px;
    line-height: 1.36;
  }
  body {
    /* Heavy outer padding so the terminal interface lives entirely
     * inside the visible CRT face — the iframe is sized to the
     * display mesh's local bbox which extends past the screen into
     * the bezel curve, and CSS3D can't bend the iframe to follow
     * that curve. Padding keeps content in the centred safe zone;
     * the bezel-area perimeter renders as black background. */
    padding: 110px 160px;
    box-sizing: border-box;
    display: flex; flex-direction: column;
  }
  /* ── Header (ASCII box) ───────────────────────────────── */
  pre.header {
    margin: 0 0 4px 0;
    color: var(--accent);
    font-size: 11px;
    line-height: 1.05;
    white-space: pre;
    text-shadow: 0 0 6px rgba(251, 191, 36, 0.35);
  }
  .sub {
    color: var(--fg-dim);
    font-size: 11px;
    letter-spacing: 0.06em;
    margin-bottom: 10px;
  }
  /* ── Nav ──────────────────────────────────────────────── */
  nav {
    display: flex; flex-wrap: wrap; gap: 4px 16px;
    margin-bottom: 10px;
    padding-bottom: 8px;
    border-bottom: 1px dashed var(--fg-dim);
    font-size: 12px;
  }
  nav button {
    background: none;
    border: none;
    color: var(--fg);
    font: inherit;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 2px;
  }
  nav button:hover { color: var(--accent); }
  nav button.active {
    color: var(--accent);
    background: rgba(251, 191, 36, 0.08);
    text-shadow: 0 0 8px rgba(251, 191, 36, 0.45);
  }
  nav button .key { color: var(--fg-dim); }
  nav button.active .key { color: var(--accent-dim); }
  /* ── Main scroll area ─────────────────────────────────── */
  main {
    flex: 1 1 0;
    min-height: 0;
    overflow-y: auto;
    padding-right: 8px;
    /* short sections center themselves vertically so the about
       one-liner doesn't leave a giant empty black void below it */
    display: flex; flex-direction: column;
  }
  main::-webkit-scrollbar { width: 8px; }
  main::-webkit-scrollbar-track { background: transparent; }
  main::-webkit-scrollbar-thumb { background: var(--fg-dim); border-radius: 4px; }
  section { display: none; }
  section.active { display: flex; flex-direction: column; flex: 1; }
  section.center { justify-content: center; align-items: center; text-align: center; }
  section.center > * { max-width: 92%; }
  pre.ascii {
    margin: 0 0 18px 0;
    color: var(--fg-dim);
    font-size: 12px;
    line-height: 1.05;
    white-space: pre;
    text-align: left;
  }
  .tagline {
    color: var(--accent);
    font-size: 22px;
    letter-spacing: 0.05em;
    margin: 8px 0 6px 0;
    text-shadow: 0 0 12px rgba(251, 191, 36, 0.45);
  }
  .tagline-sub {
    color: var(--fg);
    font-size: 14px;
    margin-bottom: 18px;
  }
  h2 {
    color: var(--accent);
    font-size: 13px;
    margin: 0 0 8px 0;
    letter-spacing: 0.1em;
  }
  h2::before { content: '== '; color: var(--fg-dim); }
  h2::after  { content: ' =='; color: var(--fg-dim); }
  p { margin: 0 0 8px 0; }
  ul { list-style: none; padding: 0; margin: 0 0 8px 0; }
  li { margin-bottom: 8px; padding-left: 14px; position: relative; }
  li::before {
    content: '>'; position: absolute; left: 0;
    color: var(--fg-dim);
  }
  li.feat::before { content: '*'; color: var(--accent); }
  .label {
    color: var(--accent);
    font-weight: 600;
    letter-spacing: 0.04em;
  }
  .meta {
    color: var(--fg-dim);
    font-size: 11px;
    margin-top: 2px;
  }
  .stack {
    color: var(--fg-dim);
    font-size: 11px;
    font-style: italic;
    margin-top: 3px;
  }
  a {
    color: var(--link);
    text-decoration: none;
    border-bottom: 1px dotted var(--link);
  }
  a:hover { color: var(--link-hover); border-color: var(--link-hover); }
  /* Two-column grid for projects + milestones */
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px 24px;
  }
  .grid li { margin-bottom: 8px; }
  .timeline {
    font-size: 14px;
  }
  .timeline li { padding-left: 110px; min-height: 1.2em; margin-bottom: 6px; }
  .timeline li::before { content: ''; }
  .timeline .when {
    position: absolute; left: 0; top: 0; width: 100px;
    color: var(--fg-dim);
  }
  /* ── Footer ───────────────────────────────────────────── */
  footer {
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px dashed var(--fg-dim);
    color: var(--fg-dim);
    font-size: 11px;
    display: flex; justify-content: space-between; align-items: center;
  }
  .blink { animation: blink 1s steps(2) infinite; color: var(--fg); }
  @keyframes blink { 50% { opacity: 0; } }
  .hint { letter-spacing: 0.06em; }
</style>
</head>
<body>
<pre class="header">╔══════════════════════════════════════════════════════════════════╗
║   AIDEN  ZEGIL  //  BUILDER                                      ║
║   FOUNDING  ENGINEER  @  DISTILL  ·  NYC  ·  EST.  2022          ║
╚══════════════════════════════════════════════════════════════════╝</pre>
<div class="sub">SYSTEM  READY.  SELECT  A  CHANNEL  OR  TYPE  1-6.</div>

<nav id="nav">
  <button data-key="1" class="active">[<span class="key">1</span>]&nbsp;ABOUT</button>
  <button data-key="2">[<span class="key">2</span>]&nbsp;WORK</button>
  <button data-key="3">[<span class="key">3</span>]&nbsp;PROJECTS</button>
  <button data-key="4">[<span class="key">4</span>]&nbsp;WRITING</button>
  <button data-key="5">[<span class="key">5</span>]&nbsp;CONTACT</button>
</nav>

<main>
  <section data-key="1" class="active center">
    <pre class="ascii">       __
   ,-./  \\.-,           ___
  (  ___    )__.________(___)
   \\\`-.\\__//\\        / / ___\\
       \\__/  \\__,___,_/ / /\\__/
                |_____| /
                |_____|/
</pre>
    <div class="tagline">I'M GOOD AT WHAT I DO.</div>
    <div class="tagline-sub">what else do you need to know?</div>
    <div class="meta">[2] WORK · [3] PROJECTS · [5] CONTACT</div>
  </section>

  <section data-key="2">
    <h2>WORK</h2>
    <ul>
      <li class="feat"><span class="label">DISTILL</span> · Founding Engineer · 2024-06 → present
        <div class="meta">4th member, 2nd technical hire. Building the core product from zero — Chrome MV3 extension, Next.js 15 web app, 50+ Hatchet workflows, Elasticsearch, Rust graph service, AI extraction pipelines. 560+ commits across dispatch campaigns, entity resolution, CSV import, trait columns.</div>
        <div class="stack">stack &gt; ts · next 15 · react 19 · chrome mv3 · postgres · prisma · elasticsearch · hatchet · rust · llm · aws</div>
      </li>
      <li><span class="label">FREELANCE</span> · Contract SE · 2024-02 → 2024-06
        <div class="meta">Solo contractor between Tenet and Distill. Multiple parallel clients across Node/Next.js and Svelte stacks.</div>
      </li>
      <li><span class="label">TENET</span> · Software Engineer II · 2023-12 → 2024-02
        <div class="meta">Climate fintech (EV financing). Owned Fifth Third ACH integration end-to-end (cut ACH fees by thousands/mo), the Treehouse charger partnership, and a Plaid rewrite supporting micro-deposit verification. Audited and rewrote loan add-ons under DDD principles.</div>
      </li>
      <li><span class="label">TENET</span> · Software Engineer I · 2023-01 → 2023-12
        <div class="meta">Built ~70% of the front-end for the direct-loan flow — the primary revenue driver. Contentful partner templates for Getaround, DIMO, and others. PII + AWS-hosted infra.</div>
      </li>
      <li><span class="label">TENET</span> · Contract SE · 2022-11 → 2023-01
        <div class="meta">Contract-to-hire. Converted to full-time within two months.</div>
      </li>
      <li><span class="label">ROSE TECHNOLOGY</span> · SE Intern · 2022-09 → 2022-10
        <div class="meta">First professional role. Quant trading firm — built React-based internal tools for the trading desk seven months after writing my first line of code.</div>
      </li>
    </ul>
  </section>

  <section data-key="3">
    <h2>PROJECTS</h2>
    <ul>
      <li class="feat"><span class="label">DISTILL PLATFORM</span> — AI research platform · 2024 → present
        <div class="meta">Browser extension + web app + data pipelines. Full-stack platform built from zero.</div>
      </li>
      <li class="feat"><span class="label">PREDICTIVE MARKET BOT FACTORY</span> — Multi-region trading infra · 2026 → present
        <div class="meta">Stochastic hill-climbing variant search over 300+ GB of backtest data. Paper bots in NYC for data recording, live bots in Amsterdam for low-latency execution. Time + curve arbitrage, hedge positioning, mint-and-merge.</div>
      </li>
      <li class="feat"><span class="label">PLANE GAME</span> — 3D infinite flyer · <a href="https://github.com/aidenzegil/plane-game" target="_blank" rel="noopener">github</a>
        <div class="meta">Three.js biplane through procedurally generated chunks — multi-layered trees, windowed buildings, interactive blimps. Kinematic flight physics, particle explosions, shadow mapping.</div>
      </li>
      <li><span class="label">TRADING BOT</span> — MCP backtesting server · 2025
        <div class="meta">TypeScript MCP server + Python vectorbt engine. Lets Claude/ChatGPT run strategies against Alpaca data. Sharpe, drawdown, win rate, Calmar. Strategy validator parses arbitrary Python.</div>
      </li>
      <li><span class="label">AUTO DUBBER</span> — End-to-end AI dubbing pipeline · 2025
        <div class="meta">8-stage pipeline: WhisperX diarization → translation → ElevenLabs per-character TTS → Pydub mixing → FFmpeg remux. Handles timing sync across variable-length dubbed segments.</div>
      </li>
      <li><span class="label">PERSONAL ASSISTANT</span> — Phone-callable voice agent · 2025
        <div class="meta">Twilio media streams → Whisper → GPT-4 intent parsing → action dispatch across Slack, Google Calendar, Linear, iMessage, desktop automation.</div>
      </li>
      <li><span class="label">AI AGENT BOILERPLATE</span> — NestJS + AWS CDK · <a href="https://github.com/aidenzegil/ai-agent-boilerplate" target="_blank" rel="noopener">github</a>
        <div class="meta">Production-grade hackathon scaffold. Lambda + API Gateway, RDS Postgres with VPC, Prisma migrations, Fernet encryption, Plaid integration.</div>
      </li>
      <li><span class="label">COACHING SCHEDULER</span> — Full-stack in 24h · 2024
        <div class="meta">NestJS + Prisma + Postgres + Next.js + React Query. 3NF schema, Dockerized, custom error hierarchy, role-based views.</div>
      </li>
      <li><span class="label">TWEET GENERATOR (×3)</span> — OpenAI thread generator · 2022
        <div class="meta">FastAPI backend + two frontends (vanilla JS, then Vue rewrite). Recursive thread expansion via GPT.</div>
      </li>
      <li><span class="label">TWITTER MAP</span> — Orbital tweet visualizer · 2022
        <div class="meta">FastAPI Twitter wrapper + React frontend with Orbiter/Orbitee components. Tweets orbit their parent in a radial spatial layout.</div>
      </li>
      <li><span class="label">DARE GENERATOR</span> — Real-time party app · <a href="https://github.com/aidenzegil/Dare_Generator" target="_blank" rel="noopener">github</a>
        <div class="meta">React + Firebase Realtime Database. Live data sync via onValue listeners — built in the first month of learning to code.</div>
      </li>
      <li><span class="label">[REDACTED]</span> · 2024-08 · experiments
        <div class="meta">name withheld.</div>
      </li>
      <li><span class="label">[REDACTED]</span> · 2024-02 · infra · experiments
        <div class="meta">name withheld.</div>
      </li>
      <li><span class="label">[REDACTED]</span> · 2023-12 · experiments
        <div class="meta">name withheld.</div>
      </li>
      <li><span class="label">[REDACTED]</span> · 2022-09 · frontend
        <div class="meta">name withheld.</div>
      </li>
      <li><span class="label">[REDACTED]</span> · 2022-09 · experiments
        <div class="meta">name withheld.</div>
      </li>
      <li><span class="label">[REDACTED]</span> · 2022-08 · frontend
        <div class="meta">name withheld.</div>
      </li>
      <li><span class="label">[REDACTED]</span> · 2022-08 · frontend
        <div class="meta">name withheld.</div>
      </li>
      <li><span class="label">[REDACTED]</span> · 2022-07 · experiments
        <div class="meta">name withheld.</div>
      </li>
      <li><span class="label">[REDACTED]</span> · 2022-06 · frontend
        <div class="meta">name withheld.</div>
      </li>
      <li><span class="label">[REDACTED]</span> · 2022-06 · experiments
        <div class="meta">name withheld.</div>
      </li>
      <li><span class="label">[REDACTED]</span> · 2022-06 · experiments
        <div class="meta">name withheld.</div>
      </li>
      <li><span class="label">[REDACTED]</span> · 2022-05 · frontend
        <div class="meta">name withheld.</div>
      </li>
      <li><span class="label">[REDACTED]</span> · 2022-05 · frontend
        <div class="meta">name withheld.</div>
      </li>
      <li><span class="label">[REDACTED]</span> · 2022-05 · games
        <div class="meta">name withheld.</div>
      </li>
      <li><span class="label">[REDACTED]</span> · 2022-04 · games
        <div class="meta">name withheld.</div>
      </li>
      <li><span class="label">[REDACTED]</span> · 2022-03 · games
        <div class="meta">name withheld.</div>
      </li>
    </ul>
  </section>

  <section data-key="4">
    <h2>WRITING</h2>
    <ul>
      <li class="feat"><span class="label">"Burn the Boats"</span> — Breaking into Tech as a 19-Year-Old Dropout · Apr 2024
        <div class="meta">From Starbucks barista to software engineer in under a year. Quit electrical engineering, moved to NYC, took an admin job to survive, relentlessly chased engineering — internship, contract, full-time, all before 21.</div>
        <a href="https://aidenzegil.substack.com/p/breaking-into-tech-as-a-19-year-old" target="_blank" rel="noopener">read on substack →</a>
      </li>
      <li><span class="label">"The Good Enough React Provider"</span> — Apr 2024
        <div class="meta">A five-file architecture for React Context — split types, network calls, state, state-modifying functions, and the provider itself. Hides setters from consumers, exposes only an immutable view via Omit-typed exports.</div>
        <a href="https://aidenzegil.substack.com/p/the-good-enough-react-provider" target="_blank" rel="noopener">read on substack →</a>
      </li>
    </ul>
  </section>

  <section data-key="5">
    <h2>CONTACT</h2>
    <ul>
      <li><span class="label">GITHUB</span> &nbsp;<a href="https://github.com/aidenzegil" target="_blank" rel="noopener">github.com/aidenzegil</a></li>
      <li><span class="label">LINKEDIN</span> <a href="https://www.linkedin.com/in/aiden-zegil-0906a4235/" target="_blank" rel="noopener">linkedin.com/in/aiden-zegil-0906a4235</a></li>
      <li><span class="label">SUBSTACK</span> <a href="https://aidenzegil.substack.com" target="_blank" rel="noopener">aidenzegil.substack.com</a></li>
      <li><span class="label">EMAIL</span> &nbsp;<a href="mailto:aidenzegil@gmail.com">aidenzegil@gmail.com</a></li>
    </ul>
    <p class="stack">// the dog brought you here. esc to walk away.</p>
  </section>
</main>

<footer>
  <span><span class="blink">&gt;</span>&nbsp;<span id="prompt">_</span></span>
  <span class="hint">[1-5] CHANNEL · [ESC] DISCONNECT</span>
</footer>

<script>
  const buttons = document.querySelectorAll('nav button');
  const sections = document.querySelectorAll('section[data-key]');
  const prompt = document.getElementById('prompt');
  function show(key) {
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.key === key));
    sections.forEach((s) => s.classList.toggle('active', s.dataset.key === key));
    if (prompt) prompt.textContent = (buttons[(+key) - 1]?.textContent || '').replace(/\\[\\d\\]\\s*/, '');
    const main = document.querySelector('main');
    if (main) main.scrollTop = 0;
  }
  buttons.forEach((b) => b.addEventListener('click', () => show(b.dataset.key)));
  document.addEventListener('keydown', (e) => {
    // Re-emit ESC to the parent so the homepage's monitor-focus
    // exit handler fires regardless of which window the iframe has
    // keyboard focus in. Without this, the iframe absorbs ESC and
    // the player gets stuck on the screen.
    if (e.key === 'Escape' && window.parent && window.parent !== window) {
      try {
        window.parent.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      } catch (_) { /* cross-origin parent — ignored, fine */ }
      return;
    }
    if (e.key >= '1' && e.key <= '5') show(e.key);
  });
  // Re-route wheel events to the <main> scroll area so the player
  // can scroll long sections (PROJECTS) without first having to
  // click somewhere — by default scroll lands on whatever element
  // happens to be under the cursor, which inside the iframe is the
  // body, not the scrollable main.
  const main = document.querySelector('main');
  document.addEventListener('wheel', (e) => {
    if (!main) return;
    main.scrollTop += e.deltaY;
    e.preventDefault();
  }, { passive: false });
</script>
</body>
</html>`;
