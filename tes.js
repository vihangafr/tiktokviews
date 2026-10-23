'use strict';
const puppeteer = require('puppeteer');

const TEST_MP4 = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
const EMBED = 'https://www.tiktok.com/embed/v2/7652559093244136724?lang=en-US';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
           '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });

  console.log('chrome path  :', puppeteer.executablePath());
  console.log('browser ver  :', await browser.version());

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');

  // --- test A: can this browser decode H.264 at all? ---
  const codecs = await page.evaluate(() => {
    const v = document.createElement('video');
    return {
      h264: v.canPlayType('video/mp4; codecs="avc1.42E01E"'),
      av1:  v.canPlayType('video/mp4; codecs="av01.0.00M.08"'),
      vp9:  v.canPlayType('video/webm; codecs="vp9"'),
    };
  });
  console.log('codec probe  :', codecs, codecs.h264 === '' ? '<<< NO H.264' : '');

  await page.goto('about:blank');
  const raw = await page.evaluate(async (url) => {
    const v = document.createElement('video');
    v.muted = true; v.src = url; v.playsInline = true;
    document.body.appendChild(v);
    const outcome = await new Promise((res) => {
      const t = setTimeout(() => res('timeout'), 12000);
      v.addEventListener('error', () => { clearTimeout(t); res('error:' + (v.error && v.error.code)); });
      v.addEventListener('canplay', () => { clearTimeout(t); res('canplay'); });
      v.load();
      v.play().catch(() => {});
    });
    await new Promise((r) => setTimeout(r, 2000));
    return { outcome, currentTime: v.currentTime, readyState: v.readyState, err: v.error && v.error.code };
  }, TEST_MP4);
  console.log('raw mp4 test :', raw);

  // --- test B: what does the TikTok embed player actually do? ---
  const failed = [];
  page.on('requestfailed', (r) => failed.push(`${r.failure() && r.failure().errorText} ${r.url().slice(0, 110)}`));

  await page.goto(EMBED, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.bringToFront();

  for (let i = 0; i < 12; i++) {
    let line = `t+${(i * 2).toString().padStart(2)}s`;
    for (const f of page.frames()) {
      try {
        const s = await f.evaluate(() => {
          const v = document.querySelector('video');
          if (!v) return null;
          return {
            src: (v.currentSrc || v.src || '').slice(0, 70),
            rs: v.readyState, ns: v.networkState,
            err: v.error ? v.error.code : 0,
            ct: +v.currentTime.toFixed(2), paused: v.paused,
          };
        });
        if (s) line += ` | src=${s.src || 'EMPTY'} rs=${s.rs} ns=${s.ns} err=${s.err} t=${s.ct} paused=${s.paused}`;
      } catch (_) {}
    }
    console.log(line);
    if (i === 2) {
      for (const f of page.frames()) {
        try { await f.evaluate(() => { const v = document.querySelector('video'); if (v) { v.muted = true; v.play().catch(() => {}); } }); } catch (_) {}
      }
    }
    await sleep(2000);
  }

  console.log('\nvisibility   :', await page.evaluate(() => document.visibilityState));
  console.log('failed reqs  :', failed.length ? failed.slice(0, 15) : 'none');
  await browser.close();
})().catch((e) => { console.error('fatal:', e.message); process.exit(1); });
