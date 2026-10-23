'use strict';
const puppeteer = require('puppeteer');
const EMBED = 'https://www.tiktok.com/embed/v2/7652559093244136724?lang=en-US';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');

  const media = [];
  page.on('response', (r) => {
    const u = r.url();
    if (/tiktokcdn|tiktok\.com\/video\/tos|webapp-prime|mpegurl|\.m3u8|\.mp4/.test(u)) {
      media.push({ status: r.status(), ct: r.headers()['content-type'] || '', u });
    }
  });
  page.on('requestfailed', (r) => media.push({
    status: 'REQFAILED', ct: (r.failure() && r.failure().errorText) || '', u: r.url(),
  }));

  await page.goto(EMBED, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.bringToFront();

  console.log('caps:', await page.evaluate(() => {
    const v = document.createElement('video');
    return {
      nativeHls: v.canPlayType('application/vnd.apple.mpegurl'),
      mse: typeof window.MediaSource !== 'undefined',
      hlsjs: typeof window.Hls !== 'undefined',
    };
  }));

  for (let i = 0; i < 8; i++) {
    for (const f of page.frames()) {
      try {
        const s = await f.evaluate(() => {
          const v = document.querySelector('video');
          if (!v) return null;
          v.muted = true;
          const p = v.play(); if (p && p.catch) p.catch(() => {});
          return {
            FULL: v.currentSrc || v.src || '',
            rs: v.readyState, ns: v.networkState,
            err: v.error ? v.error.code : 0,
            msg: v.error ? v.error.message : '',
            t: +v.currentTime.toFixed(2), paused: v.paused,
          };
        });
        if (s) console.log(`t+${i * 2}s`, s);
      } catch (_) {}
    }
    await sleep(2000);
  }

  console.log('\n--- media requests ---');
  for (const m of media) console.log(m.status, '|', m.ct, '|', m.u.slice(0, 420));
  await browser.close();
})().catch((e) => { console.error('fatal:', e.message); process.exit(1); });
