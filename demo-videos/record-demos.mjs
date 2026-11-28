import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL = 'http://127.0.0.1:8771/';
const PORT = 9341;
const OUT_ROOT = path.resolve('demo-videos');
const FRAMES_ROOT = path.join(OUT_ROOT, 'frames');
const VIDEO_ROOT = path.join(OUT_ROOT, 'videos');
const USER_DATA_DIR = path.join(os.tmpdir(), 'xvoz-demo-edge-record');

const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
const only = onlyArg ? onlyArg.split('=')[1] : null;

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const CASTLE_FEN = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';

const SCENARIOS = [
  {
    id: '01-cavalo-g1-f3',
    title: 'Cavalo g1 → f3',
    headline: 'Cavalo',
    move: 'g1 → f3',
    piece: 'wN',
    fen: START_FEN,
    from: 'g1',
    to: 'f3',
    intro: 'Desobstrução automática do caminho',
    subline: 'Desobstrução automática · g2 → g3 · g1 → f3 · g3 → g2',
    chips: ['A* com desobstrução', 'ímã ON/OFF', 'retorno a 0,0'],
    slow: 1,
  },
  {
    id: '02-roque',
    title: 'Roque pequeno O-O',
    headline: 'Roque',
    move: 'O-O',
    piece: 'wK',
    fen: CASTLE_FEN,
    from: 'e1',
    to: 'g1',
    intro: 'Rei e torre em um único plano',
    subline: 'Rei e1 → g1 · Torre h1 → f1 · mesa em 0,0',
    chips: ['rei + torre', 'rota automática', 'retorno a 0,0'],
    slow: 1,
  },
  {
    id: '03-peao-e2-e4',
    title: 'Peão e2 → e4',
    headline: 'Peão',
    move: 'e2 → e4',
    piece: 'wP',
    fen: START_FEN,
    from: 'e2',
    to: 'e4',
    intro: 'Movimento direto com retorno à origem',
    subline: 'Traçado direto · ímã ligado apenas sobre a peça',
    chips: ['trajeto direto', 'ímã ON/OFF', 'retorno a 0,0'],
    slow: 2,
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function clearDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Set();

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id) {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
        return;
      }
      for (const handler of this.handlers) {
        try {
          handler(msg);
        } catch (error) {
          console.error('event handler error', error);
        }
      }
    };
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    return new CDP(ws);
  }

  send(method, params = {}, timeout = 30000) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeout);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  onEvent(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async evaluate(expression, { awaitPromise = true, timeout = 30000 } = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture: true,
      },
      timeout
    );

    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(
        details.exception?.description || details.text || 'Runtime.evaluate failed'
      );
    }

    return result.result.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function getPageTarget() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((target) => target.type === 'page');
      if (page) return page;
    } catch {}
    await sleep(200);
  }
  throw new Error('Nenhum target de página encontrado.');
}

const DEMO_CSS = String.raw`
  html, body {
    background: #070b10 !important;
    overflow: hidden !important;
    scrollbar-width: none !important;
  }
  body::-webkit-scrollbar { display: none !important; }
  .app {
    width: 1400px !important;
    max-width: 1400px !important;
    margin: 0 auto !important;
    padding: 0 !important;
  }
  .topbar, .footer { display: none !important; }
  .layout {
    display: grid !important;
    grid-template-columns: minmax(0, 1fr) 480px !important;
    gap: 32px !important;
    align-items: start !important;
    margin-top: 100px !important;
  }
  .board-column {
    grid-column: 1 !important;
    max-width: 840px !important;
    width: 100% !important;
    margin: 0 auto !important;
    gap: 0 !important;
  }
  .player-card, .status-row, .actions { display: none !important; }
  .board-shell {
    display: block !important;
    max-width: 840px !important;
    margin: 0 auto !important;
    padding: 10px !important;
    box-sizing: border-box !important;
    transition: box-shadow 0.6s ease !important;
  }
  .board-shell.demo-done {
    box-shadow:
      0 0 0 1px rgba(76, 227, 170, 0.35),
      0 0 70px rgba(76, 227, 170, 0.16),
      0 34px 70px rgba(0, 0, 0, 0.55),
      0 6px 18px rgba(0, 0, 0, 0.35) !important;
  }
  .eval-rail { display: none !important; }
  .board-wrap { width: 100% !important; }
  .board { width: 100% !important; }

  .sidebar {
    grid-column: 2 !important;
    display: block !important;
    width: 100% !important;
    margin-top: 0 !important;
  }
  .voice-panel { display: none !important; }
  .lower-panel {
    background: transparent !important;
    border: 0 !important;
    box-shadow: none !important;
    padding: 0 !important;
    overflow: visible !important;
  }
  .lower-panel .tabs { display: none !important; }
  #tab-xy, #tab-xy.hidden { display: block !important; padding: 0 !important; }

  .xy-panel { gap: 13px !important; }
  .xy-panel-head b { font-size: 18px !important; letter-spacing: -0.01em !important; }
  .xy-panel-head small { font-size: 11.5px !important; margin-top: 3px !important; }
  .xy-dot { width: 9px !important; height: 9px !important; flex-basis: 9px !important; }
  .xy-value { padding: 10px 12px !important; }
  .xy-value small { font-size: 9px !important; }
  .xy-value b { font-size: 22px !important; }
  .xy-value b span { font-size: 10px !important; }
  .xy-badges { gap: 6px !important; }
  .xy-badge { font-size: 10px !important; padding: 5px 9px !important; }
  .xy-plan { padding: 11px !important; }
  .xy-plan-head { font-size: 12px !important; margin-bottom: 8px !important; }
  .xy-plan-head span { font-size: 10px !important; }
  .xy-plan-list { max-height: 240px !important; gap: 5px !important; }
  .xy-plan-row { grid-template-columns: 64px 1fr auto !important; padding: 7px 8px !important; gap: 9px !important; }
  .xy-role { font-size: 8px !important; padding: 3px 4px !important; }
  .xy-plan-copy b { font-size: 12px !important; }
  .xy-plan-copy small { font-size: 9.5px !important; }
  .xy-plan-mm { font-size: 9.5px !important; }
  .xy-log { max-height: 160px !important; font-size: 9.5px !important; line-height: 1.55 !important; }
  .xy-empty { font-size: 10.5px !important; }
  .xy-panel .hint { font-size: 10.5px !important; }

  .xy-actions, .xy-enable, .xy-sync, #xyDanger, #xyPromo, .xy-settings, #xyMode, #xyConnHint {
    display: none !important;
  }

  #demoHeader {
    position: fixed;
    inset: 0 0 auto 0;
    height: 100px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 60px;
    z-index: 50;
    background: linear-gradient(180deg, rgba(7, 11, 16, 0.98), rgba(7, 11, 16, 0.82) 62%, transparent);
    pointer-events: none;
  }
  #demoHeader .left { display: flex; flex-direction: column; gap: 2px; }
  #demoHeader .brandline {
    font-size: 12px;
    letter-spacing: 0.22em;
    color: #7fe7bf;
    font-weight: 800;
  }
  #demoHeader .brandline span { color: #6f8092; font-weight: 600; }
  #demoHeader .titleline {
    font-size: 34px;
    font-weight: 300;
    color: #eef4f9;
    letter-spacing: -0.025em;
    line-height: 1.08;
  }
  #demoHeader .titleline b { font-weight: 700; color: #4ce3aa; }
  #demoHeader .subline {
    font-size: 12px;
    color: #93a3b4;
    transition: color 0.4s ease;
  }
  #demoHeader .subline.done { color: #9ef0cd; }
  #demoHeader .right { display: flex; align-items: center; gap: 10px; }
  #demoHeader .dtag {
    padding: 7px 12px;
    border: 1px solid rgba(76, 227, 170, 0.28);
    border-radius: 999px;
    color: #bdf7df;
    background: rgba(76, 227, 170, 0.07);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.14em;
  }
  #demoHeader .ddot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #4ce3aa;
    box-shadow: 0 0 14px rgba(76, 227, 170, 0.85);
  }

  #demoLegend {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 22px;
    margin-top: 14px;
    color: #8fa0b1;
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  #demoLegend .lg { display: inline-flex; align-items: center; gap: 7px; }
  #demoLegend i {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 50%;
  }
  #demoLegend i.target { background: #4ce3aa; box-shadow: 0 0 8px rgba(76, 227, 170, 0.55); }
  #demoLegend i.clear { background: #f2bb61; box-shadow: 0 0 8px rgba(242, 187, 97, 0.45); }
  #demoLegend i.restore { background: #9bd3ff; box-shadow: 0 0 8px rgba(155, 211, 255, 0.45); }
  #demoLegend i.head { background: #eef4f9; box-shadow: 0 0 8px rgba(238, 244, 249, 0.45); }

  #demoIntro {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background:
      radial-gradient(900px 600px at 50% 38%, rgba(30, 92, 70, 0.35), transparent 70%),
      #070b10;
    opacity: 1;
    transition: opacity 0.42s ease;
  }
  #demoIntro.out { opacity: 0; pointer-events: none; }
  #demoIntro .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 0 40px;
  }
  #demoIntro .intro-piece {
    width: 150px;
    height: 150px;
    filter: drop-shadow(0 18px 40px rgba(0, 0, 0, 0.6)) drop-shadow(0 0 26px rgba(76, 227, 170, 0.22));
    animation: demoPiece 2.6s ease-in-out infinite;
  }
  @keyframes demoPiece {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-9px); }
  }
  #demoIntro .kicker {
    margin-top: 24px;
    color: #7fe7bf;
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.24em;
  }
  #demoIntro .kicker span { color: #6f8092; font-weight: 600; }
  #demoIntro h1 {
    margin: 12px 0 0;
    font-size: 58px;
    font-weight: 300;
    letter-spacing: -0.035em;
    color: #eef4f9;
  }
  #demoIntro h1 em { font-style: normal; font-weight: 750; color: #4ce3aa; }
  #demoIntro p {
    margin: 13px 0 0;
    color: #93a3b4;
    font-size: 18px;
  }
  #demoIntro .chips {
    display: flex;
    gap: 9px;
    margin-top: 26px;
  }
  #demoIntro .chip {
    padding: 7px 12px;
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 999px;
    color: #b6c4d1;
    background: rgba(255, 255, 255, 0.025);
    font-size: 10.5px;
    font-weight: 600;
  }
  #demoIntro .foot {
    margin-top: 34px;
    color: #4e6072;
    font-size: 9.5px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  .board-busy { display: none !important; }
  .xy-overlay { z-index: 4 !important; }
  #xyBoardOverlay .xy-path-under { stroke-width: 6.5 !important; }
  #xyBoardOverlay .xy-path { stroke-width: 3.2 !important; }
  #xyBoardOverlay .xy-path-ghost { stroke-width: 2 !important; opacity: 0.8 !important; }
  #xyBoardOverlay .xy-ring { stroke-width: 2.8 !important; }
`;

function headerHtml(scenario) {
  return `
    <div class="left">
      <div class="brandline">XADREZ VOZ <span>+ MESA XY</span></div>
      <div class="titleline">Path tracing <b>· ${scenario.title}</b></div>
      <div class="subline" id="demoSubline">${scenario.subline}</div>
    </div>
    <div class="right"><span class="dtag">SIMULAÇÃO</span><span class="ddot"></span></div>
  `;
}

function introHtml(scenario) {
  return `
    <div class="card">
      <img class="intro-piece" src="assets/pieces/${scenario.piece}.svg" alt="">
      <div class="kicker">XADREZ VOZ <span>+ MESA XY</span></div>
      <h1>${scenario.headline} <em>${scenario.move}</em></h1>
      <p>${scenario.intro}</p>
      <div class="chips">${scenario.chips.map((chip) => `<span class="chip">${chip}</span>`).join('')}</div>
      <div class="foot">path tracing · demonstração</div>
    </div>
  `;
}

function legendHtml() {
  return `
    <span class="lg"><i class="target"></i> Peça principal</span>
    <span class="lg"><i class="clear"></i> Desvio temporário</span>
    <span class="lg"><i class="restore"></i> Devolução</span>
    <span class="lg"><i class="head"></i> Cabeça magnética</span>
  `;
}

const WAIT_LOG_FN = `
  window.__demoWaitLog = (needle, timeout = 90000) => new Promise((resolve) => {
    const el = document.getElementById('xyLog');
    const finish = (reason) => {
      observer.disconnect();
      clearTimeout(timer);
      resolve(reason);
    };
    const check = () => {
      if (el && el.textContent.includes(needle)) finish('found');
    };
    const observer = new MutationObserver(check);
    observer.observe(el, { childList: true, subtree: true, characterData: true });
    const timer = setTimeout(() => finish('timeout'), timeout);
    check();
  });

  window.__demoCleanLog = () => {
    const el = document.getElementById('xyLog');
    if (!el) return;
    const kill = /Mesa XY pronta|O jogo mantém regras|aguardando sincronização inicial|Jogo alterado|Simulação iniciada|Mesa física confirmada na posição atual/i;
    const clean = () => {
      const rows = [...el.children];
      const firstExec = rows.findIndex((row) => /Executando lance/i.test(row.textContent || ''));
      if (firstExec > 0) rows.slice(0, firstExec).forEach((row) => row.remove());
      for (const row of [...el.children]) {
        if (kill.test(row.textContent || '')) row.remove();
      }
    };
    new MutationObserver(clean).observe(el, { childList: true, subtree: true, characterData: true });
    clean();
  };

  window.__demoDone = () => {
    const subline = document.getElementById('demoSubline');
    if (subline) {
      subline.textContent = 'Plano concluído · mesa em 0,0';
      subline.classList.add('done');
    }
    document.querySelector('.board-shell')?.classList.add('demo-done');
  };
`;

async function waitForReady(cdp) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const ready = await cdp.evaluate(
        '!!(window.__xvoz && window.__xvoz.xyTable && document.querySelectorAll(".square").length === 64)',
        { awaitPromise: false, timeout: 5000 }
      );
      if (ready) return;
    } catch {}
    await sleep(200);
  }
  throw new Error('App não ficou pronta.');
}

async function installDemoChrome(cdp, scenario) {
  await cdp.evaluate(`(() => {
    let style = document.getElementById('demo-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'demo-style';
      document.head.appendChild(style);
    }
    style.textContent = ${JSON.stringify(DEMO_CSS)};

    let header = document.getElementById('demoHeader');
    if (!header) {
      header = document.createElement('div');
      header.id = 'demoHeader';
      document.body.appendChild(header);
    }
    header.innerHTML = ${JSON.stringify(headerHtml(scenario))};

    let legend = document.getElementById('demoLegend');
    if (!legend) {
      legend = document.createElement('div');
      legend.id = 'demoLegend';
      document.querySelector('.board-column')?.appendChild(legend);
    }
    legend.innerHTML = ${JSON.stringify(legendHtml())};

    let intro = document.getElementById('demoIntro');
    if (!intro) {
      intro = document.createElement('div');
      intro.id = 'demoIntro';
      document.body.appendChild(intro);
    }
    intro.classList.remove('out');
    intro.innerHTML = ${JSON.stringify(introHtml(scenario))};

    ${WAIT_LOG_FN}

    return true;
  })()`);
}

async function setupScenario(cdp, scenario) {
  const result = await cdp.evaluate(`(async () => {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const X = window.__xvoz;
    if (!X) return { ok: false, reason: 'sem __xvoz' };

    X.state.mode = '2p';
    X.state.humanColor = 'w';
    X.state.orientation = 'w';
    X.state.game.load(${JSON.stringify(scenario.fen)});
    X.state.moves = [];
    X.state.selected = null;
    X.state.lastMove = null;
    X.state.hintMove = null;
    X.state.pendingPromotion = null;
    X.state.gameOver = false;
    X.state.endStatus = null;
    X.state.ended = false;
    X.state.resigned = false;
    X.state.status = null;
    X.state.evalCp = 0;
    X.state.thinking = false;
    X.state.xyBusy = false;

    document.getElementById('gameOverModal')?.classList.add('hidden');
    document.getElementById('confirmModal')?.classList.add('hidden');
    document.getElementById('promotionModal')?.classList.add('hidden');

    X.renderAll();
    X.xyTable.noteGameChanged(X.state.game.fen(), { reason: 'fen' });

    document.querySelector('.tab[data-tab="xy"]')?.click();
    await delay(90);
    document.querySelector('[data-xy-mode="sim"]')?.click();
    await delay(90);
    document.getElementById('xyConnect')?.click();
    await delay(900);
    X.xyTable.noteGameCommitted(X.state.game.fen(), { physical: true });
    await delay(150);

    window.__demoCleanLog();

    window.__demoClicks = [];
    document.getElementById('squares')?.addEventListener(
      'click',
      (event) => {
        window.__demoClicks.push(event.target.closest('.square')?.dataset.sq || null);
      },
      true
    );

    return {
      ok: true,
      connected: X.xyTable.isConnected(),
      busy: X.xyTable.isBusy(),
      sync: X.xyTable.getStatus(),
    };
  })()`, { timeout: 30000 });

  if (!result?.ok) throw new Error(`Setup falhou: ${JSON.stringify(result)}`);
  return result;
}

function startScreencast(cdp, scenario) {
  const frameDir = path.join(FRAMES_ROOT, scenario.id);
  clearDir(frameDir);

  const frames = [];
  let firstTs = null;
  let count = 0;

  const remove = cdp.onEvent((msg) => {
    if (msg.method !== 'Page.screencastFrame') return;
    const { data, sessionId, metadata } = msg.params;
    const ts = Number(metadata?.timestamp || Date.now() / 1000);
    if (firstTs === null) firstTs = ts;

    const file = path.join(frameDir, `${String(count).padStart(5, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file: path.basename(file), t: Math.max(0, ts - firstTs) });
    count += 1;

    cdp.send('Page.screencastFrameAck', { sessionId }, 5000).catch(() => {});
  });

  return {
    frameDir,
    frames,
    async stop() {
      remove();
      const stoppedAt = Date.now() / 1000;
      await cdp.send('Page.stopScreencast');
      await sleep(250);
      const endRel = firstTs === null ? 0 : Math.max(0, stoppedAt - firstTs);
      return { frames, endRel };
    },
  };
}

async function recordScenario(cdp, scenario) {
  console.log(`\n=== ${scenario.id} ===`);

  let slowScriptId = null;
  if (scenario.slow !== 1) {
    const added = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const original = performance.now.bind(performance);
        Object.defineProperty(performance, 'now', {
          configurable: true,
          value: () => original() * ${1 / scenario.slow},
        });
      })();`,
    });
    slowScriptId = added.identifier;
  }

  await cdp.send('Page.navigate', { url: APP_URL });
  await waitForReady(cdp);

  if (slowScriptId) {
    await cdp
      .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: slowScriptId })
      .catch(() => {});
  }

  await installDemoChrome(cdp, scenario);
  const setup = await setupScenario(cdp, scenario);
  console.log('setup', setup.sync);

  await sleep(180);

  const rec = startScreencast(cdp, scenario);
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 92,
    maxWidth: 1920,
    maxHeight: 1080,
    everyNthFrame: 1,
  });
  console.log('gravando...');

  let triggerResult;
  try {
    triggerResult = await cdp.evaluate(`(async () => {
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const intro = document.getElementById('demoIntro');

      await delay(1500);
      intro?.classList.add('out');
      await delay(480);

      const from = document.querySelector('.square[data-sq="${scenario.from}"]');
      if (!from) return { ok: false, reason: 'casa de origem não encontrada' };

      from.click();
      await delay(760);
      const to = document.querySelector('.square[data-sq="${scenario.to}"]');
      if (!to) return { ok: false, reason: 'casa de destino não encontrada' };

      const rect = to.getBoundingClientRect();
      const topEl = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);

      const d1 = {
        selected: [...document.querySelectorAll('.square.selected')].map((s) => s.dataset.sq),
        stateSelected: window.__xvoz.state.selected,
        feedback: document.getElementById('feedback')?.textContent,
        xyBusy: window.__xvoz.state.xyBusy,
        thinking: window.__xvoz.state.thinking,
        topEl: topEl ? topEl.tagName + '.' + topEl.className : null,
        legal: window.__xvoz.legalMovesFromTo('${scenario.from}', '${scenario.to}').length,
        clicks: [...(window.__demoClicks || [])],
      };

      to.click();
      await delay(900);
      const d2 = {
        selected: [...document.querySelectorAll('.square.selected')].map((s) => s.dataset.sq),
        stateSelected: window.__xvoz.state.selected,
        feedback: document.getElementById('feedback')?.textContent,
        xyBusy: window.__xvoz.state.xyBusy,
        thinking: window.__xvoz.state.thinking,
        boardBusy: document.getElementById('boardBusy')?.className,
        plan: document.getElementById('xyPlanList')?.textContent,
        phase: document.getElementById('xyPhase')?.textContent,
        log: document.getElementById('xyLog')?.textContent.slice(-700),
        modalHidden: document.getElementById('confirmModal')?.classList.contains('hidden'),
        modalText: document.getElementById('confirmText')?.textContent,
        clicks: [...(window.__demoClicks || [])],
        status: window.__xvoz.currentStatus(),
      };

      const waitResult = await window.__demoWaitLog('Movimento físico concluído', 90000);

      await delay(120);
      window.__demoDone();
      await delay(1900);

      const log = document.getElementById('xyLog')?.textContent || '';
      return {
        ok: waitResult === 'found',
        waitResult,
        d1,
        d2,
        logTail: log.slice(-1200),
        plan: document.getElementById('xyPlanList')?.textContent || '',
        phase: document.getElementById('xyPhase')?.textContent || '',
      };
    })()`, { timeout: 120000 });
  } finally {
    const meta = await rec.stop();
    ensureDir(VIDEO_ROOT);

    const payload = {
      scenario,
      frames: meta.frames,
      endRel: meta.endRel,
      recordedAt: new Date().toISOString(),
      triggerResult,
    };
    fs.writeFileSync(path.join(rec.frameDir, 'meta.json'), JSON.stringify(payload, null, 2));
    console.log(`frames: ${meta.frames.length} · duração: ${meta.endRel.toFixed(2)}s`);
    console.log('resultado', triggerResult);
  }
}

async function main() {
  ensureDir(OUT_ROOT);
  ensureDir(VIDEO_ROOT);
  ensureDir(FRAMES_ROOT);

  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  ensureDir(USER_DATA_DIR);

  const edge = spawn(
    EDGE,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${USER_DATA_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--hide-scrollbars',
      '--mute-audio',
      '--force-device-scale-factor=1',
      '--window-size=1920,1080',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  try {
    const target = await getPageTarget();
    const cdp = await CDP.connect(target.webSocketDebuggerUrl);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    cdp.onEvent((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        console.error('EXCEPTION', msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        console.error(
          'CONSOLE',
          msg.params.args?.map((arg) => arg.value ?? arg.description).join(' ')
        );
      }
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false,
    });

    for (const scenario of SCENARIOS) {
      if (only && scenario.id !== only && !scenario.id.includes(only)) continue;
      await recordScenario(cdp, scenario);
    }

    cdp.close();
  } finally {
    edge.kill();
    await sleep(600);
    try {
      fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
