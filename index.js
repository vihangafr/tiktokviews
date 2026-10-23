#!/usr/bin/env node
'use strict';

/**
 * tiktok-fake-views.js — CommonJS
 *
 * Inflates a TikTok video's play counter by loading it in real headless Chrome.
 * TikTok counts a view when the web player actually starts playing, so each
 * fresh browser context == one play event.
 *
 * Usage:
 *   node tiktok-fake-views.js --views=100 --concurrency=4
 *   node tiktok-fake-views.js "https://www.tiktok.com/@nejan_x/video/7652559093244136724" --views=500
 *   node tiktok-fake-views.js --views=200 --proxy=http://user:pass@host:port,http://host2:port
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
const toInt = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

// --------------------------------------------------------------------------
// args
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    url: DEFAULT_URL,
    views: 50,
    concurrency: 3,
    holdMs: 5500,      // how long the player stays open (must exceed ~1s)
    jitterMs: 2500,    // random extra hold so timing isn't robotic
    timeout: 45000,    // per-page navigation / element timeout
    retries: 2,
    proxies: [],
    headful: false,
    verify: true,
    source: 'embed',   // 'embed' | 'page'
    help: false,
  };

  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      opts.url = arg;
      continue;
    }
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
      case 'retries': opts.retries = toInt(val, opts.retries); break;
      case 'source': opts.source = val; break;
      case 'headful': case 'head': opts.headful = true; break;
      case 'no-verify': opts.verify = false; break;
      case 'help': case 'h': opts.help = true; break;
      case 'proxy': case 'proxies':
        opts.proxies = val.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case 'proxies-file': {
        const lines = fs.readFileSync(val, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        opts.proxies = opts.proxies.concat(lines);
        break;
      }
      default:
        console.warn(`! unknown flag --${key}`);
    }
  }

  opts.views = Math.max(1, opts.views);
  opts.concurrency = Math.max(1, Math.min(opts.concurrency, opts.views));
  return opts;
}

function usage() {
  console.log(`
tiktok-fake-views — pump a TikTok video's play counter

  node tiktok-fake-views.js [url] [options]

Options
  --views=N            how many plays to fire            (default 50)
  --concurrency=N      parallel browsers/tabs            (default 3)
  --hold=MS            time player stays open            (default 5500)
  --jitter=MS          random extra hold 0..MS           (default 2500)
  --timeout=MS         page load timeout                 (default 45000)
  --retries=N          retries per view                  (default 2)
  --proxy=a,b,c        comma separated proxy list (one browser each)
  --proxies-file=FILE  one proxy per line
  --source=embed|page  embed player or full page         (default embed)
  --headful            show the browser windows
  --no-verify          skip before/after play count read
  -h, --help           this text
`);
}

function extractVideoId(url) {
  const m = String(url).match(/\/video\/(\d+)/);
  if (!m) throw new Error(`could not find a video id in: ${url}`);
  return m[1];
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

async function createContext(browser) {
  if (typeof browser.createBrowserContext === 'function') {
    return browser.createBrowserContext();          // puppeteer >= 22
  }
  return browser.createIncognitoBrowserContext();   // older
}

async function waitForVideo(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const has = await frame.evaluate(() => !!document.querySelector('video'));
        if (has) return frame;
      } catch (_) { /* frame detached */ }
    }
    await sleep(250);
  }
  return null;
}

async function fetchPlayCount(videoUrl) {
  try {
    const res = await fetch(videoUrl, {
      redirect: 'follow',
      headers: {
        'user-agent': UA_POOL[0],
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    for (const p of [/"playCount":(\d+)/, /"playCount":"(\d+)"/, /"viewCount":(\d+)/]) {
      const m = html.match(p);
      if (m) return Number(m[1]);
    }
  } catch (_) { /* offline-ish, ignore */ }
  return null;
}

// --------------------------------------------------------------------------
// one play
// --------------------------------------------------------------------------

async function playOnce(browser, opts, targetUrl) {
  const context = await createContext(browser);
  const page = await context.newPage();
  try {
    await page.setUserAgent(pick(UA_POOL));
    await page.setViewport({ ...pick(VIEWPORTS), deviceScaleFactor: 1 });
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });

    // hide the most obvious automation tell
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
    await page.bringToFront();

    const frame = await waitForVideo(page, opts.timeout);
    if (!frame) throw new Error('no <video> element appeared');

    // force it to actually play, muted
    await frame.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return;
      v.muted = true;
      v.volume = 0;
      v.loop = false;
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    });

    await sleep(opts.holdMs + Math.random() * opts.jitterMs);

    const state = await frame.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      return { currentTime: v.currentTime, paused: v.paused };
    });

    if (!state || state.currentTime < 0.8) {
      throw new Error(`playback did not progress (t=${state ? state.currentTime.toFixed(2) : 'n/a'})`);
    }
    return { ok: true, currentTime: state.currentTime };
  } finally {
    try { await page.close(); } catch (_) {}
    try { await context.close(); } catch (_) {}
  }
}

// --------------------------------------------------------------------------
// worker pool
// --------------------------------------------------------------------------

async function runPool(total, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= total) return;
      await worker(i);
    }
  });
  await Promise.all(runners);
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();

  const videoId = extractVideoId(opts.url);
  const targetUrl = opts.source === 'page'
    ? opts.url
    : `https://www.tiktok.com/embed/v2/${videoId}?lang=en-US`;

  console.log(`video id     : ${videoId}`);
  console.log(`target       : ${targetUrl}`);
  console.log(`views        : ${opts.views}`);
  console.log(`concurrency  : ${opts.concurrency}`);
  console.log(`proxies      : ${opts.proxies.length || 'none'}`);
  console.log('');

  let before = null;
  if (opts.verify) {
    before = await fetchPlayCount(opts.url);
    console.log(`play count before: ${before === null ? 'unknown' : before.toLocaleString()}\n`);
  }

  // one browser per proxy; otherwise a single shared browser
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
    ];
    if (proxy) args.push(`--proxy-server=${proxy}`);

    browsers.push(await puppeteer.launch({
      headless: opts.headful ? false : true,
      args,
      defaultViewport: null,
      protocolTimeout: 180000,
    }));
  }

  const shutdown = async () => {
    for (const b of browsers) { try { await b.close(); } catch (_) {} }
  };
  process.on('SIGINT', async () => { await shutdown(); process.exit(0); });

  const started = Date.now();
  let done = 0;
  let played = 0;
  let failed = 0;

  await runPool(opts.views, opts.concurrency, async (i) => {
    const browser = browsers[i % browsers.length];
    let lastErr = null;

    for (let attempt = 0; attempt <= opts.retries; attempt++) {
      try {
        const res = await playOnce(browser, opts, targetUrl);
        played++;
        done++;
        console.log(`[${done}/${opts.views}] ok    t=${res.currentTime.toFixed(2)}s` +
          (attempt ? ` (retry ${attempt})` : ''));
        return;
      } catch (err) {
        lastErr = err;
      }
    }

    failed++;
    done++;
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
    if (before !== null && after !== null) {
      console.log(`delta            : ${(after - before).toLocaleString()} (counter lags, may keep rising)`);
    }
  }
  console.log('---------------------------------------------');

  await shutdown();
}

main().catch((err) => {
  console.error('\nfatal:', err && err.message ? err.message : err);
  process.exit(1);
});
