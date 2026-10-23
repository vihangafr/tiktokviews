#!/usr/bin/env no
'use strict';

/**
 * tiktok-fake-views.js — CommonJS, hardened
 * node index.js [url] --views=50 --concurrency=3 [--chrome=/usr/bin/google-chrome-stable]
 */

const fs = require('fs');
const puppeteer = require('puppeteer');

const DEFAULT_URL = 'https://www.tiktok.com/@nejan_x/video/7652559093244136724';

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const toInt = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

function parseArgs(argv) {
  const opts = {
    url: DEFAULT_URL, views: 50, concurrency: 3,
    holdMs: 5500, jitterMs: 2500, timeout: 45000, retries: 2,
    readyTimeout: 25000,
    proxies: [], headful: false, verify: true, source: 'embed',
    chrome: null, debug: false, help: false,
  };
  for (const arg of argv) {
    if (!arg.startsWith('--')) { opts.url = arg; continue; }
    const eq = arg.indexOf('=');
    const key = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).toLowerCase();
    const val = eq === -1 ? 'true' : arg.slice(eq + 1);
    switch (key) {
      case 'url': opts.url = val; break;
      case 'views': opts.views = toInt(val, opts.views); break;
      case 'concurrency': case 'c': opts.concurrency = toInt(val, opts.concurrency); break;
      case 'hold': opts.holdMs = toInt(val, opts.holdMs); break;
      case 'jitter': opts.jitterMs = toInt(val, opts.jitterMs); break;
      case 'timeout': opts.timeout = toInt(val, opts.timeout); break;
      case 'ready-timeout': opts.readyTimeout = toInt(val, opts.readyTimeout); break;
      case 'retries': opts.retries = toInt(val, opts.retries); break;
      case 'source': opts.source = val; break;
      case 'chrome': opts.chrome = val; break;
      case 'headful': case 'head': opts.headful = true; break;
      case 'debug': opts.debug = true; break;
      case 'no-verify': opts.verify = false; break;
      case 'help': case 'h': opts.help = true; break;
      case 'proxy': case 'proxies':
        opts.proxies = val.split(',').map((s) => s.trim()).filter(Boolean); break;
      case 'proxies-file':
        opts.proxies = opts.proxies.concat(
          fs.readFileSync(val, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)); break;
      default: console.warn(`! unknown flag --${key}`);
    }
  }
  opts.views = Math.max(1, opts.views);
  opts.concurrency = Math.max(1, Math.min(opts.concurrency, opts.views));
  return opts;
}

function usage() {
  console.log(`
node index.js [url] [options]

  --views=N            plays to fire              (default 50)
  --concurrency=N      parallel tabs              (default 3)
  --hold=MS            time player stays open     (default 5500)
  --jitter=MS          random extra hold          (default 2500)
  --ready-timeout=MS   wait for playable video    (default 25000)
  --timeout=MS         page load timeout          (default 45000)
  --retries=N          retries per view           (default 2)
  --chrome=PATH        use system Chrome binary
  --proxy=a,b          proxies (one browser each)
  --proxies-file=FILE  one proxy per line
  --source=embed|page  embed player or full page  (default embed)
  --headful            visible windows
  --debug              log player state on retry
  --no-verify          skip play-count read
  -h, --help
`);
}

function extractVideoId(url) {
  const m = String(url).match(/\/video\/(\d+)/);
  if (!m) throw new Error(`no video id in: ${url}`);
  return m[1];
}

async function createContext(browser) {
  return typeof browser.createBrowserContext === 'function'
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext();
}

// ---- wait for a <video> that is actually decodable -------------------------

async function waitForReadyVideo(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = { frame: null, state: null, reason: 'no <video> element in any frame' };

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      let s;
      try {
        s = await frame.evaluate(() => {
          const v = document.querySelector('video');
          if (!v) return null;
          return {
            src: (v.currentSrc || v.src || '').slice(0, 120),
            readyState: v.readyState,
            networkState: v.networkState,
            errorCode: v.error ? v.error.code : 0,
          };
        });
      } catch (_) { continue; }
      if (!s) continue;

      last = { frame, state: s, reason: '' };
      if (s.errorCode) { last.reason = `media error code ${s.errorCode}`; return last; }
      if (s.src && s.readyState >= 2) return last;
      last.reason = `src=${s.src ? 'ok' : 'EMPTY'} readyState=${s.readyState} networkState=${s.networkState}`;
    }
    await sleep(300);
  }
  return last;
}

// ---- get frames actually moving -------------------------------------------

async function nudgePlayback(page, frame, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let detail = 'no state';

  while (Date.now() < deadline) {
    try {
      await frame.evaluate(() => {
        const v = document.querySelector('video');
        if (!v) return;
        v.muted = true;
        v.volume = 0;
        const p = v.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      });
    } catch (_) {}

    await sleep(400);

    let st;
    try {
      st = await frame.evaluate(() => {
        const v = document.querySelector('video');
        return v ? { t: v.currentTime, paused: v.paused, rs: v.readyState } : null;
      });
    } catch (_) { continue; }

    if (st && st.t > 0.5) return { ok: true };
    if (st) detail = `t=${st.t.toFixed(2)} paused=${st.paused} readyState=${st.rs}`;

    // real user gesture fallback
    try {
      const el = await frame.$('video');
      if (el) await el.click({ delay: 40 });
    } catch (_) {}
  }
  return { ok: false, detail };
}

// ---- one play --------------------------------------------------------------

async function playOnce(browser, opts, targetUrl) {
  const context = await createContext(browser);
  const page = await context.newPage();
  try {
    await page.setUserAgent(pick(UA_POOL));
    await page.setViewport({ ...pick(VIEWPORTS), deviceScaleFactor: 1 });
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(document, 'hidden', { get: () => false });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
    });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
    await page.bringToFront();

    const { frame, reason } = await waitForReadyVideo(page, opts.readyTimeout);
    if (!frame) throw new Error(`player not ready: ${reason}`);

    const nudged = await nudgePlayback(page, frame, 12000);
    if (!nudged.ok) throw new Error(`playback stalled (${nudged.detail})`);

    await sleep(opts.holdMs + Math.random() * opts.jitterMs);

    const final = await frame.evaluate(() => {
      const v = document.querySelector('video');
      return v ? { t: v.currentTime } : null;
    });
    if (!final || final.t < 0.8) {
      throw new Error(`playback did not progress (t=${final ? final.t.toFixed(2) : 'n/a'})`);
    }
    return { ok: true, currentTime: final.t };
  } finally {
    try { await page.close(); } catch (_) {}
    try { await context.close(); } catch (_) {}
  }
}

async function fetchPlayCount(videoUrl) {
  try {
    const res = await fetch(videoUrl, {
      redirect: 'follow',
      headers: { 'user-agent': UA_POOL[0], accept: 'text/html,application/xhtml+xml',
                 'accept-language': 'en-US,en;q=0.9' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    for (const p of [/"playCount":(\d+)/, /"playCount":"(\d+)"/, /"viewCount":(\d+)/]) {
      const m = html.match(p);
      if (m) return Number(m[1]);
    }
  } catch (_) {}
  return null;
}

async function runPool(total, concurrency, worker) {
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= total) return;
      await worker(i);
    }
  }));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();

  const videoId = extractVideoId(opts.url);
  const targetUrl = opts.source === 'page'
    ? opts.url
    : `https://www.tiktok.com/embed/v2/${videoId}?lang=en-US`;

  console.log(`video id    : ${videoId}`);
  console.log(`target      : ${targetUrl}`);
  console.log(`views       : ${opts.views}`);
  console.log(`concurrency : ${opts.concurrency}`);
  console.log(`proxies     : ${opts.proxies.length || 'none'}`);
  if (opts.chrome) console.log(`chrome      : ${opts.chrome}`);

  const proxySlots = opts.proxies.length ? opts.proxies : [null];
  const browsers = [];

  for (const proxy of proxySlots) {
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
      '--mute-audio',
      '--window-size=1280,800',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
      '--use-gl=angle',
      '--use-angle=swiftshader',
    ];
    if (proxy) args.push(`--proxy-server=${proxy}`);

    const launch = { headless: opts.headful ? false : true, args, defaultViewport: null, protocolTimeout: 180000 };
    if (opts.chrome) launch.executablePath = opts.chrome;
    browsers.push(await puppeteer.launch(launch));
  }

  console.log('browser     :', await browsers[0].version());

  // codec self-test
  const probe = await (async () => {
    const p = await browsers[0].newPage();
    try {
      return await p.evaluate(() => {
        const v = document.createElement('video');
        return { h264: v.canPlayType('video/mp4; codecs="avc1.42E01E"'),
                 av1: v.canPlayType('video/mp4; codecs="av01.0.00M.08"') };
      });
    } finally { await p.close(); }
  })();
  console.log('codecs      :', probe);
  if (!probe.h264) console.log('  !! no H.264 — install Google Chrome and rerun with --chrome=/usr/bin/google-chrome-stable');
  console.log('');

  let before = null;
  if (opts.verify) {
    before = await fetchPlayCount(opts.url);
    console.log(`play count before: ${before === null ? 'unknown' : before.toLocaleString()}\n`);
  }

  const shutdown = async () => { for (const b of browsers) { try { await b.close(); } catch (_) {} } };
  process.on('SIGINT', async () => { await shutdown(); process.exit(0); });

  const started = Date.now();
  let done = 0, played = 0, failed = 0;

  await runPool(opts.views, opts.concurrency, async (i) => {
    const browser = browsers[i % browsers.length];
    let lastErr = null;
    for (let attempt = 0; attempt <= opts.retries; attempt++) {
      try {
        const r = await playOnce(browser, opts, targetUrl);
        played++; done++;
        console.log(`[${done}/${opts.views}] ok    t=${r.currentTime.toFixed(2)}s${attempt ? ` (retry ${attempt})` : ''}`);
        return;
      } catch (e) { lastErr = e; }
    }
    failed++; done++;
    console.log(`[${done}/${opts.views}] FAIL  ${lastErr && lastErr.message}`);
  });

  const secs = (Date.now() - started) / 1000;
  console.log('\n---------------------------------------------');
  console.log(`attempted : ${opts.views}`);
  console.log(`played    : ${played}`);
  console.log(`failed    : ${failed}`);
  console.log(`elapsed   : ${secs.toFixed(1)}s (${(opts.views / secs).toFixed(2)} views/s)`);
  if (opts.verify) {
    await sleep(4000);
    const after = await fetchPlayCount(opts.url);
    console.log(`play count after : ${after === null ? 'unknown' : after.toLocaleString()}`);
    if (before !== null && after !== null) console.log(`delta            : ${(after - before).toLocaleString()} (counter lags)`);
  }
  console.log('---------------------------------------------');

  await shutdown();
}

main().catch((e) => { console.error('\nfatal:', e && e.message ? e.message : e); process.exit(1); });
