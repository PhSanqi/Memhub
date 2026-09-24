import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const pagesDir = resolve(repo, ".review-runtime/redesign-v2/pages");
const runtimeDir = resolve(repo, ".review-runtime/redesign-v2");
const chromeCandidates = [process.env.MEMHUB_CHROMIUM, process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean);

async function exists(path) { try { await access(path, fsConstants.F_OK); return true; } catch { return false; } }
async function firstExisting(items) { for (const item of items) if (await exists(item)) return item; return null; }
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: repo, env: process.env, stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "", stderr = "";
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (x) => { stdout += x; process.stdout.write(x); });
    child.stderr?.on("data", (x) => { stderr += x; process.stderr.write(x); });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolvePromise({ stdout, stderr }) : reject(new Error(`${command} failed (${code ?? signal})\n${stderr.slice(-3000)}`)));
  });
}

class CdpPipe {
  constructor(chrome) { this.chrome = chrome; this.child = null; this.id = 0; this.buffer = ""; this.pending = new Map(); }
  async start() {
    this.child = spawn(this.chrome, ["--headless=new", "--no-sandbox", "--remote-debugging-pipe", "--disable-background-networking", "--disable-sync", "--metrics-recording-only", "--disable-component-update", "about:blank"], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", () => {});
    this.child.stdio[4].on("data", (chunk) => {
      this.buffer += chunk.toString();
      let split;
      while ((split = this.buffer.indexOf("\0")) >= 0) {
        const raw = this.buffer.slice(0, split); this.buffer = this.buffer.slice(split + 1);
        if (!raw) continue;
        const msg = JSON.parse(raw);
        const pending = msg.id ? this.pending.get(msg.id) : null;
        if (pending) { this.pending.delete(msg.id); msg.error ? pending.reject(new Error(JSON.stringify(msg.error))) : pending.resolve(msg.result); }
      }
    });
    await this.send("Browser.getVersion");
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolvePromise, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  }
  async page(width, height) {
    const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    await this.send("Page.enable", {}, sessionId);
    await this.send("Runtime.enable", {}, sessionId);
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height }, sessionId);
    return { targetId, sessionId };
  }
  async evaluate(sessionId, expression, awaitPromise = true) {
    const out = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, sessionId);
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || "Runtime.evaluate failed");
    return out.result?.value;
  }
  async navigate(sessionId, url) { await this.send("Page.navigate", { url }, sessionId); await sleep(450); }
  async screenshot(sessionId) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }, sessionId);
    return Buffer.from(data, "base64");
  }
  async closePage(targetId) { await this.send("Target.closeTarget", { targetId }); }
  async stop() { try { await this.send("Browser.close"); } catch {} await sleep(100); if (this.child && !this.child.killed) this.child.kill("SIGTERM"); }
}

async function uniquePackDir() {
  const base = resolve(repo, ".review-runtime/review-pack-v2");
  if (!(await exists(base))) return base;
  for (let i = 2; i < 100; i++) { const candidate = `${base}-${i}`; if (!(await exists(candidate))) return candidate; }
  throw new Error("could not allocate a clean review-pack directory");
}

const basePages = { landing: "landing.html", user: "workspace.html", admin: "admin.html" };
const docsPages = { docs: "docs.html", install: "install.html", workflows: "workflows.html", privacy: "privacy.html", troubleshooting: "troubleshooting.html" };
const viewportSpecs = [{ width: 1440, height: 1100 }, { width: 1024, height: 1000 }, { width: 768, height: 1000 }, { width: 390, height: 844 }];

const metricsExpression = `(()=>{const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth};const interactive=[...document.querySelectorAll('a[href],button,select,input:not([type="hidden"]),textarea,summary')].filter(visible);const small=interactive.map(el=>{const r=el.getBoundingClientRect();return{tag:el.tagName,id:el.id||'',class:String(el.className||''),width:Math.round(r.width),height:Math.round(r.height)}}).filter(x=>x.width<44||x.height<44);const flow=document.querySelector('.memory-flow'),mv=document.getElementById('mobile-view-select'),cm=document.getElementById('console-menu-toggle'),lm=document.getElementById('mobile-menu-toggle'),dm=document.getElementById('docs-menu-toggle');const rect=e=>e?e.getBoundingClientRect():null,mr=rect(mv),cr=rect(cm),lr=rect(lm),dr=rect(dm);return{title:document.title,lang:document.documentElement.lang,theme:document.documentElement.dataset.theme,innerWidth,innerHeight,clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,rootOverflow:document.documentElement.scrollWidth-document.documentElement.clientWidth,visibleInteractive:interactive.length,smallTargets:small,lifecycle:flow?{buttons:flow.querySelectorAll('[data-view-target]').length,clientWidth:flow.clientWidth,scrollWidth:flow.scrollWidth}:null,mobileViewVisible:!!(mr&&mr.width>0&&mr.height>0),mobileViewHeight:mr?Math.round(mr.height):null,consoleMenuVisible:!!(cr&&cr.width>0&&cr.height>0),consoleMenuSize:cr?[Math.round(cr.width),Math.round(cr.height)]:null,landingMenuVisible:!!(lr&&lr.width>0&&lr.height>0),docsMenuVisible:!!(dr&&dr.width>0&&dr.height>0)}})()`;

async function prepareLanguageAndTheme(cdp, sessionId, lang = "zh", theme = "light") {
  await cdp.evaluate(sessionId, `localStorage.memhubLang=${JSON.stringify(lang)};localStorage.memhubTheme=${JSON.stringify(theme)};location.reload();true`);
  await sleep(600);
}

function pngSize(buffer) { return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }; }

async function capture(cdp, packDir, pageFile, name, width, height, { lang = "zh", theme = "light", setup = null, wait = 120, resetScroll = true } = {}) {
  const { targetId, sessionId } = await cdp.page(width, height);
  try {
    await cdp.navigate(sessionId, pathToFileURL(resolve(pagesDir, pageFile)).href);
    await prepareLanguageAndTheme(cdp, sessionId, lang, theme);
    if (setup) { await cdp.evaluate(sessionId, setup); await sleep(wait); }
    if (resetScroll) await cdp.evaluate(sessionId, "scrollTo(0,0);true");
    const metrics = await cdp.evaluate(sessionId, metricsExpression);
    if (metrics.innerWidth !== width) throw new Error(`${name}: requested ${width}px but Chrome rendered ${metrics.innerWidth}px`);
    if (metrics.rootOverflow > 1) throw new Error(`${name}: root horizontal overflow ${metrics.rootOverflow}px`);
    if (width <= 768 && metrics.smallTargets.length) throw new Error(`${name}: undersized visible targets ${JSON.stringify(metrics.smallTargets)}`);
    if ((pageFile === "workspace.html" || pageFile === "admin.html") && width <= 768) {
      if (!metrics.mobileViewVisible || metrics.mobileViewHeight < 44) throw new Error(`${name}: mobile view selector is not available`);
      if (!metrics.consoleMenuVisible || metrics.consoleMenuSize?.[0] < 44 || metrics.consoleMenuSize?.[1] < 44) throw new Error(`${name}: cross-page mobile menu is not touch sized`);
      if (!metrics.lifecycle || metrics.lifecycle.buttons !== 4 || metrics.lifecycle.scrollWidth > metrics.lifecycle.clientWidth + 1) throw new Error(`${name}: lifecycle is incomplete on mobile`);
    }
    if (pageFile === "landing.html" && width <= 768 && !metrics.landingMenuVisible) throw new Error(`${name}: landing mobile navigation is missing`);
    if (Object.values(docsPages).includes(pageFile) && width <= 768 && !metrics.docsMenuVisible) throw new Error(`${name}: docs mobile navigation is missing`);
    const png = await cdp.screenshot(sessionId);
    const size = pngSize(png);
    if (size.width !== width) throw new Error(`${name}: screenshot width ${size.width}px does not match CSS viewport ${width}px`);
    await writeFile(join(packDir, `${name}.png`), png);
    return { ...metrics, screenshot: size };
  } finally { await cdp.closePage(targetId); }
}

async function main() {
  const chrome = await firstExisting(chromeCandidates);
  if (!chrome) throw new Error("Chrome/Chromium is required for WebMaker review rendering");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await run(npm, ["run", "build"]);
  await run(process.execPath, ["tests/mcp-e2e.mjs"], { env: { ...process.env, MEMHUB_WRITE_REVIEW_PAGES: "1" } });
  for (const page of [...Object.values(basePages), ...Object.values(docsPages)]) if (!(await exists(resolve(pagesDir, page)))) throw new Error(`missing review page: ${page}`);

  const packDir = await uniquePackDir();
  await mkdir(packDir, { recursive: true });
  await copyFile(resolve(repo, "DESIGN.md"), join(packDir, "DESIGN.md"));
  await copyFile(resolve(repo, "BRIEF.md"), join(packDir, "BRIEF.md"));

  const cdp = new CdpPipe(chrome); await cdp.start();
  const metrics = { generatedAt: new Date().toISOString(), chromium: chrome, method: "Chrome DevTools Protocol over --remote-debugging-pipe / Emulation.setDeviceMetricsOverride", viewports: {}, states: {} };
  try {
    for (const [page, file] of Object.entries(basePages)) {
      metrics.viewports[page] = {};
      for (const { width, height } of viewportSpecs) metrics.viewports[page][width] = await capture(cdp, packDir, file, `${page}-${width}`, width, height);
    }
    // Capture each independently navigable view, not just the Console Overview.
    const consoleViews = {
      user: ["overview", "projects", "l1", "l2", "l3", "l4", "skills", "processing"],
      admin: ["overview", "accounts", "projects", "processing", "l1", "l2", "l3", "l4", "skills"]
    };
    for (const [page, views] of Object.entries(consoleViews)) {
      const file = basePages[page];
      const sizes = page === "admin" ? viewportSpecs : [viewportSpecs[0], viewportSpecs[3]];
      for (const view of views) {
        for (const { width, height } of sizes) {
          const name = `${page}-${view}-${width}`;
          metrics.states[name] = await capture(cdp, packDir, file, name, width, height, {
            setup: `load(${JSON.stringify(view)});true`, wait: 220
          });
        }
      }
    }
    metrics.states["admin-processing-error-1024"] = await capture(cdp, packDir, "admin.html", "admin-processing-error-1024", 1024, 1000, { setup: `load('processing');true`, wait: 250 });
    metrics.states["admin-account-detail-1024"] = await capture(cdp, packDir, "admin.html", "admin-account-detail-1024", 1024, 1000, { setup: `load('accounts');new Promise(r=>setTimeout(()=>{document.querySelector('.account-record-main')?.click();r(true)},260))`, wait: 180 });
    metrics.states["admin-project-delete-1024"] = await capture(cdp, packDir, "admin.html", "admin-project-delete-1024", 1024, 1000, { setup: `load('projects');new Promise(r=>setTimeout(()=>{document.querySelector('.project-ledger-record')?.click();setTimeout(()=>{document.querySelector('[data-project-action="delete"]')?.click();r(true)},90)},260))`, wait: 140 });
    for (const [page, file] of Object.entries(docsPages)) {
      metrics.viewports[page] = {};
      for (const { width, height } of viewportSpecs) metrics.viewports[page][width] = await capture(cdp, packDir, file, `${page}-${width}`, width, height);
      metrics.states[`${page}-middle-1024`] = await capture(cdp, packDir, file, `${page}-middle-1024`, 1024, 1000, { setup: `(()=>{const hs=[...document.querySelectorAll('.docs-markdown h2')];hs[Math.floor(hs.length/2)]?.scrollIntoView({block:'start'});return true})()`, resetScroll: false });
      metrics.states[`${page}-example-768`] = await capture(cdp, packDir, file, `${page}-example-768`, 768, 1000, { setup: `(()=>{const target=document.querySelector('.docs-code')||[...document.querySelectorAll('.docs-markdown h2')].find(x=>/示例|example|验证|verify/i.test(x.textContent||''))||document.querySelector('.docs-markdown h2');target?.scrollIntoView({block:'start'});return true})()`, resetScroll: false });
      metrics.states[`${page}-bottom-390`] = await capture(cdp, packDir, file, `${page}-bottom-390`, 390, 844, { setup: `document.querySelector('.docs-pagination')?.scrollIntoView({block:'end'});true`, resetScroll: false });
    }

    metrics.states["landing-dark-1440"] = await capture(cdp, packDir, "landing.html", "landing-dark-1440", 1440, 1100, { theme: "dark" });
    metrics.states["user-en-1024"] = await capture(cdp, packDir, "workspace.html", "user-en-1024", 1024, 1000, { lang: "en" });
    metrics.states["admin-drawer-1024"] = await capture(cdp, packDir, "admin.html", "admin-drawer-1024", 1024, 1000, { setup: `load('projects');new Promise(r=>setTimeout(()=>{document.querySelector('.project-ledger-record')?.click();r(true)},260))`, wait: 120 });
    metrics.states["user-focus-768"] = await capture(cdp, packDir, "workspace.html", "user-focus-768", 768, 1000, { setup: `document.getElementById('mobile-view-select')?.focus();true` });
    metrics.states["user-loading-390"] = await capture(cdp, packDir, "workspace.html", "user-loading-390", 390, 844, { setup: `window.__browserMock.delayNextGet=true;load('l1');true`, wait: 25 });
    metrics.states["admin-error-1024"] = await capture(cdp, packDir, "admin.html", "admin-error-1024", 1024, 1000, { setup: `window.__browserMock.failNext=true;load('l1');true`, wait: 180 });
    metrics.states["admin-busy-390"] = await capture(cdp, packDir, "admin.html", "admin-busy-390", 390, 844, { setup: `load('projects');new Promise(r=>setTimeout(()=>{document.querySelector('.project-ledger-record')?.click();setTimeout(()=>{document.querySelector('[data-project-action="todos"]')?.click();setTimeout(()=>{const f=document.getElementById('project-todo-form'),i=document.getElementById('project-todo-text'),b=f?.querySelector('button[type="submit"]');if(i&&f&&b){i.value='Busy state review';window.__browserMock.mutationDelay=1600;f.requestSubmit(b)}r(true)},80)},70)},260))`, wait: 80 });
  } finally { await cdp.stop(); }

  await writeFile(join(packDir, "deterministic-metrics.json"), JSON.stringify(metrics, null, 2));
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, "latest-pack.txt"), packDir + "\n");
  console.log(`WEB_REVIEW_PACK=${packDir}`);
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
