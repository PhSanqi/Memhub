import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import Database from "better-sqlite3";
import { MemhubBridgeQueue, bridgeRetryDelayMs, saveBridgeConfig } from "../dist/bridge.js";
import { FileProjectArchitectureSource } from "../dist/architecture-source.js";
import { JsonProjectRegistry } from "../dist/project-registry.js";
import { addAccount, ensureLocalAdminToken, setAccountRole } from "../dist/auth.js";
import { createDevice, countCaptureEvents, listCaptureEvents } from "../dist/capture.js";
import { defaultMemoryUserId } from "../dist/memory-source.js";
import {
  completeDistillationJob,
  enqueueDerivedDistillationJob,
  enqueueDistillationJob,
  failDistillationJob,
  leaseDistillationJob,
  listDistillationJobs,
  retryDistillationJob,
  setDistillationConfig
} from "../dist/distillation-jobs.js";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const mcpEntry = resolve(here, "../dist/mcp.js");
const bridgeEntry = resolve(here, "../dist/bridge.js");
const root = await mkdtemp(join(tmpdir(), "memhub-mcp-"));
const historyDbPath = join(root, "history.sqlite");
const historyDb = new Database(historyDbPath);

await testProjectDescriptionPrecedence();

function assertInlineScriptsParse(html) {
  const open = "<scr" + "ipt>";
  const close = "</scr" + "ipt>";
  const scripts = html.split(open).slice(1).map((part) => part.split(close)[0]);
  assert.ok(scripts.length > 0, "expected at least one inline script");
  for (const script of scripts) {
    assert.doesNotThrow(() => new Function(script));
  }
}

function chromiumExecutable() {
  const candidates = [
    process.env.MEMHUB_CHROMIUM,
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
}

function spawnCapture(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`chromium layout smoke failed (${code ?? signal}): ${stderr.slice(-1200)}`));
    });
  });
}

async function assertResponsiveLayoutWithChromium(pages) {
  const chromium = chromiumExecutable();
  assert.ok(chromium, "responsive Chromium regression requires Chrome/Chromium; set MEMHUB_CHROMIUM when it is not on a standard path");
  const layoutRoot = join(root, "responsive-layout");
  await mkdir(layoutRoot, { recursive: true });
  const collectedMetrics = [];
  for (const [page, html] of Object.entries(pages)) {
    const safeHtml = html.replace(
      "<script>",
      "<script>try{history.pushState=()=>{};history.replaceState=()=>{}}catch{};window.fetch=async()=>new Response(JSON.stringify({counts:{projects:2,L1:4,L2:3,L3:2,L4:1,Skill:2,pendingTodo:1},todos:{pending:[]},processing:{pending:0,leased:0},items:[]}),{status:200,headers:{'content-type':'application/json'}});</script><script>"
    );
    const encoded = Buffer.from(safeHtml).toString("base64");
    for (const width of [390, 768, 1024, 1440]) {
      const wrapperPath = join(layoutRoot, `${page}-${width}.html`);
      const wrapper = `<!doctype html><html><body style="margin:0"><iframe id="frame" style="width:${width}px;height:1200px;border:0;display:block"></iframe><pre id="layout-result"></pre><script>
const frame=document.getElementById('frame');
frame.onload=()=>setTimeout(()=>{
  try{
  const d=frame.contentDocument,w=frame.contentWindow;
  const visible=(el)=>{const r=el.getBoundingClientRect(),s=w.getComputedStyle(el);return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<w.innerHeight&&r.left<w.innerWidth};
  const small=[...d.querySelectorAll('a[href],button,select,input:not([type="hidden"]),textarea,summary')].filter(visible).map(el=>{const r=el.getBoundingClientRect();return {tag:el.tagName,id:el.id||'',cls:el.className||'',w:Math.round(r.width),h:Math.round(r.height)}}).filter(x=>x.w<44||x.h<44);
  const images=[...d.querySelectorAll('img')].map(el=>({src:el.getAttribute('src')||'',width:el.getAttribute('width'),height:el.getAttribute('height')})).filter(x=>!x.width||!x.height);
  const sidebar=d.querySelector('.console-sidebar'),flow=d.querySelector('.memory-flow'),mobileView=d.getElementById('mobile-view-select'),consoleMenuToggle=d.getElementById('console-menu-toggle'),landingMenuToggle=d.getElementById('mobile-menu-toggle');
  const active=sidebar?.querySelector('button.active'),sidebarRect=sidebar?.getBoundingClientRect(),activeRect=active?.getBoundingClientRect();
  const flowButtons=flow?[...flow.querySelectorAll('[data-view-target]')]:[];
  const mvRect=mobileView?.getBoundingClientRect(),cmRect=consoleMenuToggle?.getBoundingClientRect(),lmRect=landingMenuToggle?.getBoundingClientRect();
  document.getElementById('layout-result').textContent=JSON.stringify({
    innerWidth:w.innerWidth,
    clientWidth:d.documentElement.clientWidth,
    scrollWidth:d.documentElement.scrollWidth,
    small,
    imagesWithoutDimensions:images,
    colorScheme:w.getComputedStyle(d.documentElement).colorScheme,
    sidebarOverflowX:sidebar?w.getComputedStyle(sidebar).overflowX:null,
    sidebarClientWidth:sidebar?sidebar.clientWidth:null,
    sidebarScrollWidth:sidebar?sidebar.scrollWidth:null,
    sidebarCanScrollRight:sidebar?sidebar.classList.contains('can-scroll-right'):false,
    activeNavVisible:activeRect&&sidebarRect?activeRect.left>=sidebarRect.left-1&&activeRect.right<=sidebarRect.right+1:null,
    flowOverflowX:flow?w.getComputedStyle(flow).overflowX:null,
    flowClientWidth:flow?flow.clientWidth:null,
    flowScrollWidth:flow?flow.scrollWidth:null,
    flowButtonCount:flowButtons.length,
    mobileViewVisible:!!(mvRect&&mvRect.width>0&&mvRect.height>0),
    mobileViewHeight:mvRect?Math.round(mvRect.height):null,
    consoleMenuVisible:!!(cmRect&&cmRect.width>0&&cmRect.height>0),
    consoleMenuHeight:cmRect?Math.round(cmRect.height):null,
    landingMenuVisible:!!(lmRect&&lmRect.width>0&&lmRect.height>0)
  });
  }catch(error){document.getElementById('layout-result').textContent=JSON.stringify({error:String(error),stack:error?.stack||''})}
},180);
setTimeout(()=>{if(!document.getElementById('layout-result').textContent){document.getElementById('layout-result').textContent=JSON.stringify({error:'layout-timeout',frameReady:frame.contentDocument?.readyState||null})}},900);
frame.srcdoc=atob('${encoded}');
</script></body></html>`;
      await writeFile(wrapperPath, wrapper);
      const output = await spawnCapture(chromium, [
        "--headless=new",
        "--no-sandbox",
        "--disable-background-networking",
        "--disable-sync",
        "--metrics-recording-only",
        "--window-size=1800,1500",
        "--virtual-time-budget=1800",
        "--dump-dom",
        `file://${wrapperPath}`
      ]);
      const match = /<pre id="layout-result">([^<]+)<\/pre>/.exec(output);
      assert.ok(match?.[1], `${page} ${width}px should produce Chromium layout metrics`);
      const metrics = JSON.parse(match[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
      assert.equal(metrics.error, undefined, `${page} ${width}px Chromium layout harness must complete`);
      assert.equal(metrics.innerWidth, width, `${page} ${width}px must use the requested CSS viewport width`);
      assert.ok(metrics.clientWidth <= width && metrics.clientWidth >= width - 24, `${page} ${width}px document width may differ only by the browser scrollbar`);
      assert.equal(metrics.scrollWidth, metrics.clientWidth, `${page} ${width}px must not leak horizontal overflow to the root`);
      if (width <= 768) assert.deepEqual(metrics.small, [], `${page} ${width}px visible interactive targets must be at least 44×44px`);
      assert.deepEqual(metrics.imagesWithoutDimensions, [], page+" "+width+"px images must include intrinsic width and height attributes");
      assert.equal(metrics.colorScheme, "light", page+" "+width+"px default theme must expose light native controls");
      collectedMetrics.push({ page, width, ...metrics });
      if (page === "landing" && width <= 768) assert.equal(metrics.landingMenuVisible, true, `${page} ${width}px must expose an explicit mobile navigation menu`);
      if (page !== "landing" && width <= 768) {
        assert.equal(metrics.mobileViewVisible, true, `${page} ${width}px must expose the mobile view selector`);
        assert.ok(metrics.mobileViewHeight >= 44, `${page} ${width}px mobile view selector must be touch sized`);
        assert.equal(metrics.consoleMenuVisible, true, `${page} ${width}px must expose cross-page mobile navigation`);
        assert.ok(metrics.consoleMenuHeight >= 44, `${page} ${width}px cross-page navigation trigger must be touch sized`);
        if (metrics.sidebarScrollWidth > metrics.sidebarClientWidth) {
          assert.match(metrics.sidebarOverflowX, /^(auto|scroll)$/, `${page} sidebar must contain its own horizontal scrolling`);
          if (metrics.sidebarScrollWidth - metrics.sidebarClientWidth > 3) assert.equal(metrics.sidebarCanScrollRight, true, `${page} sidebar must expose a continuation affordance when more items remain to the right`);
        }
        if (metrics.flowScrollWidth > metrics.flowClientWidth) {
          assert.match(metrics.flowOverflowX, /^(auto|scroll)$/, `${page} memory flow must contain its own horizontal scrolling`);
        }
        if (width === 390) {
          assert.equal(metrics.flowButtonCount, 4, `${page} mobile lifecycle must expose all four memory layers`);
          assert.ok(metrics.flowScrollWidth <= metrics.flowClientWidth + 1, `${page} 390px lifecycle should fit as a complete compact layout without hidden layers`);
        }
      }
    }
  }
  if (process.env.MEMHUB_WRITE_REVIEW_PAGES === "1") {
    const reviewDir = resolve(here, "../.review-runtime/redesign-v2");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(join(reviewDir, "deterministic-metrics.json"), JSON.stringify({
      generatedAt: new Date().toISOString(),
      chromium,
      viewports: collectedMetrics
    }, null, 2));
  }
}

function consoleHtmlWithBrowserMocks(html) {
  const payloads = {
    overview:{counts:{projects:2,pendingTodo:1,L1:2,L2:1,L3:1,L4:1,Skill:1},todos:{pending:[{project_id:"alpha",project_name:"Alpha Project",text:"Verify responsive governance layout"}]},processing:{pending:1,leased:0}},
    projects:{total:2,items:[
      {project_id:"alpha",title:"Alpha Project",description:"A deliberately long project description used by the browser regression to verify that realistic content remains contained inside the project card without leaking horizontal layout.",aliases:["alpha-old"],status:"active",updated_at:"2026-09-21T09:00:00.000Z",pending_todo_count:1,pending_todos:[{id:"todo-1",text:"Verify responsive governance layout",status:"pending"}],todos:[{id:"todo-1",text:"Verify responsive governance layout",status:"pending",createdAt:"2026-09-21T08:00:00.000Z"}]},
      {project_id:"beta",title:"Beta Project",description:"Second project used for URL filter history coverage.",aliases:[],status:"active",updated_at:"2026-09-21T08:30:00.000Z",pending_todo_count:0,pending_todos:[],todos:[]}
    ]},
    l1:{total:1,items:[{event_id:"turn-browser-1",source_kind:"capture",user_text:"A long source turn that exercises realistic wrapping and drawer rendering.",assistant_text:"The assistant response is intentionally non-trivial so the row is representative.",capture_status:"complete",project_hint:"alpha",timestamp:"2026-09-21T08:10:00.000Z"}]},
    l2:{total:1,items:[{id:"l2-browser-1",project_id:"alpha",title:"Alpha timeline",summary:"Current project chronology",body:"# Alpha timeline\\n\\n## 2026-09-20 Initial decision\\nThe first durable decision was recorded.\\n\\n## 2026-09-21 Responsive review\\nThe mobile review identified navigation discoverability work.",updatedAt:"2026-09-21T08:20:00.000Z"}]},
    l3:{total:1,items:[{id:"l3-browser-1",project_id:"alpha",title:"Alpha durable rules",summary:"Durable project rules",body:"- Preserve root overflow at zero.\\n- Keep mobile navigation discoverable.\\n- Verify browser evidence before acceptance.",updatedAt:"2026-09-21T08:25:00.000Z"}]},
    l4:{total:1,items:[{id:"l4-browser-1",title:"Cross-project profile",summary:"Stable cross-project working profile",body:"- Prefers evidence-backed verification.\\n- Prefers minimal sufficient architecture.",updatedAt:"2026-09-21T08:30:00.000Z"}]},
    skills:{total:1,items:[{id:"skill-browser-1",title:"Responsive review",summary:"Reusable frontend review procedure",status:"active"}]},
    processing:{config:{auto_enabled:true,turn_threshold:8,idle_minutes:30},items:[{job_id:"job-browser-1",target:"l2",project_id:"alpha",reason:"threshold",evidence_refs:["l1:browser"],status:"failed",failure:"Simulated L2 evidence mismatch",failed_at:"2026-09-21T08:35:00.000Z",attempts:2,updated_at:"2026-09-21T08:35:00.000Z"}]},
    accounts:{total:1,items:[{account_id:"acct-browser",username:"browser-admin",cloudflare_email:"operator.long.identity@example.org",role:"admin",status:"active"}]}
  };
  const serialized=JSON.stringify(payloads).replaceAll("<","\\u003c");
  const mockScript=[
    "<script>",
    "localStorage.memhubTheme=localStorage.memhubTheme||'light';localStorage.memhubLang=localStorage.memhubLang||'en';",
    "const __browserPayloads="+serialized+";",
    "window.__browserMock={mutations:0,mutationDelay:180,failMutation:false,failNext:false,delayNextGet:false};",
    "for(const pair of [['alpha','Alpha Project'],['beta','Beta Project']]){const s=document.getElementById('project-select');if(s&&![...s.options].some(o=>o.value===pair[0])){const o=document.createElement('option');o.value=pair[0];o.textContent=pair[1];s.append(o)}}",
    "window.confirm=()=>true;",
    "window.fetch=async(input,init={})=>{const method=String(init.method||'GET').toUpperCase();if(method==='POST'){window.__browserMock.mutations+=1;await new Promise(r=>setTimeout(r,window.__browserMock.mutationDelay));if(window.__browserMock.failMutation){window.__browserMock.failMutation=false;return new Response('mock mutation failure',{status:500})}return new Response(JSON.stringify({ok:true}),{status:200,headers:{'content-type':'application/json'}})}if(window.__browserMock.delayNextGet){window.__browserMock.delayNextGet=false;await new Promise(r=>setTimeout(r,150))}if(window.__browserMock.failNext){window.__browserMock.failNext=false;return new Response('mock backend failure',{status:500})}const u=new URL(String(input),'https://memhub.test');const kind=u.searchParams.get('kind')||'overview';return new Response(JSON.stringify(__browserPayloads[kind]||{items:[]}),{status:200,headers:{'content-type':'application/json'}})};",
    "</script>"
  ].join("");
  return html.replace("<script>",mockScript+"<script>");
}

async function runConsoleBrowserScenario({chromium,html,page,width,full}) {
  const dir=join(root,"browser-interaction");
  await mkdir(dir,{recursive:true});
  const childPath=join(dir,page+"-"+width+"-child.html");
  await writeFile(childPath,consoleHtmlWithBrowserMocks(html));
  const childUrl=pathToFileURL(childPath).href+"?view=l2&project=alpha";
  const wrapperPath=join(dir,page+"-"+width+"-wrapper.html");
  const fullFlag=full?"true":"false";
  const script=[
    "const frame=document.getElementById('frame'),out=document.getElementById('interaction-result');",
    "const wait=ms=>new Promise(r=>setTimeout(r,ms));const checks=[];",
    "function check(name,value,detail=''){if(!value)throw new Error(name+(detail?': '+detail:''));checks.push(name)}",
    "async function run(){let d=frame.contentDocument,w=frame.contentWindow;const settle=async(ms=100)=>{await wait(ms);d=frame.contentDocument;w=frame.contentWindow};",
    "const clickView=async view=>{const mobile=d.getElementById(\'mobile-view-select\');if(mobile&&w.innerWidth<=900){const mr=mobile.getBoundingClientRect();check(\'mobile-view-visible\',mr.width>0&&mr.height>=44);mobile.value=view;mobile.dispatchEvent(new Event(\'change\',{bubbles:true}))}else{const b=d.querySelector(\'aside button[data-view=\\\"\'+view+\'\\\"]\');check(\'view-button-\'+view,!!b);b.click()}await settle();check(\'url-view-\'+view,new URL(w.location.href).searchParams.get(\'view\')===view,w.location.href)};",
    "await settle(230);const initialMobile=d.getElementById(\'mobile-view-select\'),menuToggle=d.getElementById(\'console-menu-toggle\');check(\'initial-view-from-url\',w.innerWidth<=900?initialMobile?.value===\'l2\':d.querySelector(\'aside button[data-view=\\\"l2\\\"]\')?.classList.contains(\'active\'));if(w.innerWidth<=900){const mr=initialMobile?.getBoundingClientRect(),tr=menuToggle?.getBoundingClientRect();check(\'mobile-view-selector-visible\',!!mr&&mr.width>0&&mr.height>=44);check(\'mobile-cross-page-menu-visible\',!!tr&&tr.width>=44&&tr.height>=44)}check(\'initial-project-from-url\',d.getElementById(\'project-select\')?.value===\'alpha\');check(\'root-overflow-initial\',d.documentElement.scrollWidth===d.documentElement.clientWidth);",
    "const sidebar=d.querySelector(\'.console-sidebar\'),flow=d.querySelector(\'.memory-flow\');check(\'lifecycle-four-layers\',flow?.querySelectorAll(\'[data-view-target]\').length===4);if("+width+"===390)check(\'lifecycle-complete-mobile\',flow.scrollWidth<=flow.clientWidth+1);",
    "if("+JSON.stringify(page)+"==='workspace'){const ps=d.getElementById('project-select');ps.value='';ps.dispatchEvent(new Event('change',{bubbles:true}));await settle();await clickView('overview');check('all-projects-portfolio',d.querySelectorAll('.portfolio-record').length>=2,String(d.querySelectorAll('.portfolio-record').length));check('overview-title-continue',/Continue working|继续工作/.test(d.getElementById('workspace-title')?.textContent||''));await clickView('l2');check('subview-title-specific',!/Continue working|继续工作/.test(d.getElementById('workspace-title')?.textContent||'')&&/Project chronology|项目时间线/.test(d.getElementById('workspace-title')?.textContent||''))}",
    "if(!"+fullFlag+"){await clickView(\'processing\');await settle(260);check(\'mobile-view-processing\',d.getElementById(\'mobile-view-select\')?.value===\'processing\');check(\'root-overflow-after-nav\',d.documentElement.scrollWidth===d.documentElement.clientWidth);out.textContent=JSON.stringify({checks});return}",
    "for(const v of ['overview','projects','l1','l2','l3','l4','processing']){await clickView(v);check('rendered-'+v,!!d.getElementById('items')?.textContent.trim())}",
    "if("+JSON.stringify(page)+"==='admin'){await clickView('overview');check('overview-single-heading',d.getElementById('view-title').getClientRects().length===0);check('overview-followup-wide',d.querySelector('.overview-todos')?.getBoundingClientRect().width>=d.querySelector('.admin-health-card')?.getBoundingClientRect().width-1);await clickView('processing');const toggle=d.getElementById('cfg-auto');check('policy-switch-semantic',toggle?.getAttribute('role')==='switch'&&toggle?.closest('label')?.textContent.includes('Automatic'));check('processing-failure-summary',d.querySelector('.job-error')?.textContent.includes('evidence mismatch'));check('processing-retry-action',!!d.querySelector('.job-quick-retry'));d.querySelector('.job-row')?.click();await settle(40);check('processing-detail-failure',d.querySelector('.job-failure-detail')?.textContent.includes('evidence mismatch'));w.closeDrawer();await settle(30);await clickView('accounts');check('account-email-primary',d.querySelector('.account-identity')?.textContent==='operator.long.identity@example.org');check('account-uuid-secondary',d.querySelector('.account-record-meta code')?.textContent==='acct-browser');check('account-no-default-json',!d.querySelector('.account-record pre'));d.querySelector('.account-record-main')?.click();await settle(40);check('account-structured-detail',!!d.querySelector('.account-detail')&&d.getElementById('drawer-title')?.textContent.includes('operator.long.identity@example.org'));w.closeDrawer()}",
    "await clickView('projects');check('long-project-content',d.querySelector('.project-ledger-record p')?.textContent.length>80);w.__browserMock.delayNextGet=true;d.querySelector('aside button[data-view=\\\"l1\\\"]')?.click();check('loading-state-visible',!!d.querySelector('.loading-state'));await settle(230);check('loading-state-clears',!d.querySelector('.loading-state'));",
    "w.__browserMock.failNext=true;d.getElementById('refresh').click();await settle(110);check('load-error-visible',!!d.querySelector('.load-error'));check('load-error-retry',!!d.querySelector('.load-error button'));check('load-error-details',!!d.querySelector('.load-error details'));d.querySelector('.load-error button').click();await settle();check('load-error-recovers',!d.querySelector('.load-error'));",
    "await clickView('projects');const card=d.querySelector('.project-ledger-record');card.focus();card.click();await settle(40);const drawer=d.getElementById('drawer');check('drawer-open',!drawer.classList.contains('hidden'));const labelled=drawer.getAttribute('aria-labelledby');check('drawer-accessible-name',!!(labelled&&d.getElementById(labelled)?.textContent.trim()));check('drawer-focus-enters',drawer.contains(d.activeElement));check('background-inert',d.getElementById('main-content').hasAttribute('inert'));let fs=[...drawer.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex=\\\"-1\\\"])')].filter(e=>e.getClientRects().length);fs.at(-1).focus();d.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));check('drawer-tab-trap',d.activeElement===fs[0]);",
    "d.querySelector('[data-project-action=\\\"todos\\\"]')?.click();await settle(40);const todo=d.getElementById('project-todo-text');check('todo-accessible-name',!!(todo?.labels?.length||todo?.getAttribute('aria-label')));d.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await settle(30);check('drawer-escape-closes',drawer.classList.contains('hidden'));check('drawer-focus-restores',d.activeElement===card||(d.activeElement?.classList?.contains('project-ledger-record')&&d.activeElement?.dataset?.itemIndex===card.dataset.itemIndex),d.activeElement?.outerHTML?.slice(0,160)||String(d.activeElement));check('background-inert-clears',!d.getElementById('main-content').hasAttribute('inert'));",
    "const before=d.documentElement.dataset.theme;d.getElementById('theme-toggle').click();check('theme-toggle',d.documentElement.dataset.theme!==before);check('theme-color-sync',d.querySelector('meta[name=\\\"theme-color\\\"]').content==='#101216');d.getElementById('lang').click();check('language-toggle',d.documentElement.lang==='zh-CN');",
    "await clickView('l3');const ps=d.getElementById('project-select');ps.value='beta';ps.dispatchEvent(new Event('change',{bubbles:true}));await settle();check('url-project-beta',new URL(w.location.href).searchParams.get('project')==='beta');await clickView('l4');w.history.back();await settle(180);check('history-back-view',new URL(w.location.href).searchParams.get('view')==='l3');check('history-back-project',d.getElementById('project-select').value==='beta');w.history.forward();await settle(180);check('history-forward-view',new URL(w.location.href).searchParams.get('view')==='l4');",
    "const reloadUrl=w.location.href;const loaded=new Promise(resolve=>frame.addEventListener('load',resolve,{once:true}));w.location.reload();await loaded;await wait(260);d=frame.contentDocument;w=frame.contentWindow;check('reload-url-preserved',w.location.href===reloadUrl);check('reload-view-restored',d.querySelector('aside button[data-view=\\\"l4\\\"]')?.classList.contains('active'));check('reload-project-restored',d.getElementById('project-select')?.value==='beta');",
    "await clickView('projects');const c2=d.querySelector('.project-ledger-record');c2.focus();c2.click();await settle(40);d.querySelector('[data-project-action=\\\"todos\\\"]')?.click();await settle(40);const form=d.getElementById('project-todo-form'),submit=form.querySelector('button[type=\\\"submit\\\"]'),input=d.getElementById('project-todo-text');input.value='Duplicate guard browser test';const base=w.__browserMock.mutations;w.__browserMock.failMutation=true;submit.click();form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));check('mutation-busy-disabled',submit.disabled&&submit.getAttribute('aria-busy')==='true');check('mutation-local-guard',!d.querySelector('.drawer-close').disabled);await settle(250);check('mutation-deduplicated',w.__browserMock.mutations===base+1,String(w.__browserMock.mutations-base));check('mutation-failure-restores',!submit.disabled&&!submit.hasAttribute('aria-busy'));check('mutation-failure-keeps-form',!d.getElementById('drawer').classList.contains('hidden'));check('root-overflow-final',d.documentElement.scrollWidth===d.documentElement.clientWidth);out.textContent=JSON.stringify({checks,mutations:w.__browserMock.mutations})}",
    "frame.addEventListener('load',()=>setTimeout(()=>run().catch(e=>{out.textContent=JSON.stringify({error:String(e),stack:e?.stack||'',checks})}),170),{once:true});setTimeout(()=>{if(!out.textContent)out.textContent=JSON.stringify({error:'interaction-timeout',checks})},5000);"
  ].join("\n");
  assert.doesNotThrow(()=>new Function(script),page+' '+width+'px interaction wrapper script should parse');
  const wrapper='<!doctype html><html><body style="margin:0"><iframe id="frame" src="'+childUrl+'" style="width:'+width+'px;height:1250px;border:0;display:block"></iframe><pre id="interaction-result"></pre><script>'+script+'</script></body></html>';
  await writeFile(wrapperPath,wrapper);
  const profilePath=join(dir,"profile-"+page+"-"+width);await mkdir(profilePath,{recursive:true});
  const output=await spawnCapture(chromium,["--headless=new","--no-sandbox","--allow-file-access-from-files","--disable-web-security","--user-data-dir="+profilePath,"--disable-background-networking","--disable-sync","--metrics-recording-only","--window-size=1800,1500","--virtual-time-budget=5600","--dump-dom",pathToFileURL(wrapperPath).href]);
  const match=/<pre id="interaction-result">([\s\S]*?)<\/pre>/.exec(output);
  if(!match?.[1]?.trim()){
    const debugDir=resolve(here,"../.review-runtime/browser-debug");
    await mkdir(debugDir,{recursive:true});
    await writeFile(join(debugDir,page+"-"+width+"-dump.html"),output);
  }
  assert.ok(match?.[1]?.trim(),page+" "+width+"px should produce Chromium interaction results\n"+output.slice(-2400));
  const result=JSON.parse(match[1].replaceAll("&quot;",'"').replaceAll("&amp;","&").replaceAll("&lt;","<").replaceAll("&gt;",">"));
  assert.equal(result.error,undefined,page+" "+width+"px browser interaction failed: "+(result.error||"")+"\\n"+(result.stack||""));return result;
}

async function assertBrowserInteractionsWithChromium({workspaceHtml,adminHtml}) {
  const chromium=chromiumExecutable();assert.ok(chromium,"browser interaction regression requires Chrome/Chromium; set MEMHUB_CHROMIUM when it is not on a standard path");
  const admin=await runConsoleBrowserScenario({chromium,html:adminHtml,page:"admin",width:390,full:true});assert.ok(admin.checks.includes("mutation-deduplicated"));
  const workspace=await runConsoleBrowserScenario({chromium,html:workspaceHtml,page:"workspace",width:768,full:false});assert.ok(workspace.checks.includes("mobile-view-processing"));assert.ok(workspace.checks.includes("all-projects-portfolio"));assert.ok(workspace.checks.includes("overview-title-continue"));assert.ok(workspace.checks.includes("subview-title-specific"));
}


historyDb.exec(`
  CREATE TABLE memories (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT, memory_value TEXT NOT NULL,
    memory_layer TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]', info_json TEXT NOT NULL DEFAULT '{}',
    properties_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    deleted_at TEXT, status TEXT NOT NULL
  );
  CREATE TABLE user_memories (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, content TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL
  );
`);
const historyUserId = defaultMemoryUserId("acct-test");
const insertMemory = historyDb.prepare(`
  INSERT INTO memories (
    id, user_id, conversation_id, memory_value, memory_layer, tags_json, info_json, properties_json,
    created_at, updated_at, deleted_at, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'activated')
`);
insertMemory.run(
  "history-project-memory-1", historyUserId, "legacy-project-chat", "Project architecture decision from earlier history",
  "L1", JSON.stringify(["project:aide"]), JSON.stringify({ project_id: "aide" }), "{}",
  "2026-09-17T08:00:00.000Z", "2026-09-17T08:00:00.000Z"
);
insertMemory.run(
  "history-other-account", "acct_other_user", "other-chat", "DO NOT LEAK OTHER ACCOUNT MEMORY",
  "L1", "[]", "{}", "{}", "2026-09-17T09:00:00.000Z", "2026-09-17T09:00:00.000Z"
);
historyDb.close();
const requests = [];
const idempotency = new Map();
const memoryIdempotency = new Map();
const memoryRecords = new Map();
const memoryById = new Map();
const rawTurnRecords = [];
let memorySequence = 0;
const memory = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  requests.push({ url: request.url, body });
  response.setHeader("content-type", "application/json");
  if (request.url === "/api/v1/memory/search") {
    if (body.query === "__long_context_probe__") {
      response.end(JSON.stringify({ hits: [{
        id: "long-context-probe",
        kind: "profile",
        memoryLayer: "L4",
        status: "activated",
        snippet: "界".repeat(600_000),
        score: 0.99,
        tags: ["global"],
        source: "search"
      }] }));
      return;
    }
    const project = body.namespace?.projectId;
    response.end(JSON.stringify({ hits: project
      ? [hit("global", "global", ["global"]), hit("project", `project ${project}`, [`project:${project}`])]
      : [hit("global", "global", ["global"])] }));
    return;
  }
  if (request.url === "/api/v1/memory/add") {
    const idempotencyKey = typeof body.requestId === "string" && body.requestId
      ? `memory.add:${body.adapterId ?? ""}:${body.requestId}`
      : undefined;
    const serialized = JSON.stringify(body);
    if (idempotencyKey && memoryIdempotency.has(idempotencyKey)) {
      const previous = memoryIdempotency.get(idempotencyKey);
      if (previous.serialized !== serialized) {
        response.statusCode = 409;
        response.end(JSON.stringify({ error: "idempotency conflict" }));
        return;
      }
      response.end(JSON.stringify({ ...previous.response, duplicate: true }));
      return;
    }
    const memoryKey = [
      body.namespace?.tenantId ?? "",
      body.namespace?.projectId ?? "global",
      body.layer ?? "L1",
      body.sourceArtifactId ?? body.sourceSkillId ?? body.title ?? body.content,
      ...(body.layer === "Skill" ? [body.sourceSkillVersion ?? "unversioned"] : [])
    ].join("\0");
    const prior = memoryRecords.get(memoryKey);
    const id = prior?.id ?? `memory-${++memorySequence}`;
    const record = {
      id,
      memoryLayer: body.layer ?? "L1",
      status: "activated",
      title: body.title,
      summary: String(body.content ?? "").split(/\r?\n/, 1)[0],
      body: body.content,
      tags: Array.isArray(body.tags) ? body.tags : [],
      namespace: body.namespace,
      metadata: {
        info: { project_id: body.namespace?.projectId },
        properties: { internal_info: {
          source_agent_id: body.sourceAgentId,
          source_skill_id: body.sourceSkillId,
          source_skill_version: body.sourceSkillVersion
        } }
      },
      version: (prior?.version ?? 0) + 1
    };
    memoryRecords.set(memoryKey, record);
    memoryById.set(id, record);
    const result = { id, status: "activated", memoryLayer: record.memoryLayer };
    if (idempotencyKey) memoryIdempotency.set(idempotencyKey, { serialized, response: result });
    response.end(JSON.stringify(result));
    return;
  }
  const viewerPath = (request.url ?? "").split("?")[0];
  if (request.method === "POST" && viewerPath === "/api/v1/skills/archive") {
    const item = memoryById.get(body.skillId);
    if (!item) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    item.status = "archived";
    response.end(JSON.stringify({ id: item.id, status: "archived" }));
    return;
  }
  const viewerUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const memoryGet = /^\/api\/v1\/memory\/([^/]+)$/.exec(viewerPath);
  if (request.method === "GET" && memoryGet) {
    const item = memoryById.get(decodeURIComponent(memoryGet[1]));
    if (!item) {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    response.end(JSON.stringify(item));
    return;
  }
  if (request.method === "GET" && viewerPath === "/api/v1/raw-turns") {
    const userId = viewerUrl.searchParams.get("userId");
    const projectId = viewerUrl.searchParams.get("projectId");
    const page = Math.max(1, Number(viewerUrl.searchParams.get("page") ?? 1));
    const limit = Math.max(1, Math.min(100, Number(viewerUrl.searchParams.get("limit") ?? 100)));
    const filtered = rawTurnRecords
      .filter((item) => !userId || item.userId === userId)
      .filter((item) => !projectId || item.projectId === projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const offset = (page - 1) * limit;
    const items = filtered.slice(offset, offset + limit);
    response.end(JSON.stringify({
      items,
      page,
      pageSize: limit,
      total: filtered.length,
      totalPages: Math.max(1, Math.ceil(filtered.length / limit)),
      hasNext: offset + items.length < filtered.length,
      hasPrev: page > 1,
      stats: {
        total: filtered.length,
        succeeded: filtered.filter((item) => item.status === "succeeded").length,
        captureManaged: filtered.filter((item) => item.sessionSource === "memhub-capture").length,
        captureManagedSucceeded: filtered.filter((item) => item.sessionSource === "memhub-capture" && item.status === "succeeded").length
      }
    }));
    return;
  }
  if (request.method === "GET" && [
    "/api/v1/overview", "/api/v1/l1", "/api/v1/l2", "/api/v1/l3", "/api/v1/l4", "/api/v1/skills"
  ].includes(viewerPath)) {
    if (viewerPath === "/api/v1/overview") {
      response.end(JSON.stringify({ metrics: { memories: memoryById.size } }));
      return;
    }
    const layer = viewerPath === "/api/v1/skills" ? "Skill" : viewerPath.slice("/api/v1/".length).toUpperCase();
    const userId = viewerUrl.searchParams.get("userId");
    const projectId = viewerUrl.searchParams.get("projectId");
    const items = [...memoryById.values()]
      .filter((item) => item.memoryLayer === layer)
      .filter((item) => !userId || item.namespace?.userId === userId)
      .filter((item) => !projectId || item.namespace?.projectId === projectId);
    response.end(JSON.stringify({ items, total: items.length }));
    return;
  }
  if (request.url === "/api/v1/sessions/open") {
    if (!acceptIdempotent(body, "session.open", response)) return;
    response.end(JSON.stringify({
      sessionId: body.sessionId,
      projectId: body.projectId ?? body.namespace?.projectId ?? null
    }));
    return;
  }
  if (request.url === "/api/v1/turns/start") {
    response.end(JSON.stringify({
      turnId: body.turnId,
      sessionId: body.sessionId,
      status: "started"
    }));
    return;
  }
  if (request.url?.startsWith("/api/v1/turns/") && request.url.endsWith("/complete")) {
    if (!acceptIdempotent(body, "turn.complete", response)) return;
    response.end(JSON.stringify({ l1MemoryId: `l1-${body.sessionId}`, status: "captured" }));
    return;
  }
  response.statusCode = 404;
  response.end("{}");
});

await new Promise((ready, reject) => {
  memory.once("error", reject);
  memory.listen(0, "127.0.0.1", ready);
});
const memoryPort = memory.address().port;

try {
  await testStdio(memoryPort);
  await testHttp(memoryPort);
  await testLocalAdmin(memoryPort);
  await testRootBasePath(memoryPort);
  await testBridgeMcpProxy();
  console.log("memhub-mcp-e2e: ok");
} finally {
  await new Promise((resolveClose) => memory.close(resolveClose));
  await rm(root, { recursive: true, force: true });
}

async function testBridgeMcpProxy() {
  const upstreamPort = await freePort();
  const bridgePort = await freePort();
  const bridgeRoot = join(root, "bridge-proxy");
  const deviceToken = `mhdev_${"x".repeat(48)}`;
  const observed = [];
  const upstream = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    observed.push({ headers: request.headers, body: raw, method: request.method, url: request.url });
    if (request.url === "/context") {
      const parsed = raw ? JSON.parse(raw) : {};
      if (parsed.query === "__timeout__") {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ late: true }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"content":"');
      for (let index = 0; index < 12; index += 1) response.write("界".repeat(50_000));
      response.end('"}');
      return;
    }
    response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "bridge-proxy-session" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
  });
  await new Promise((ready, reject) => {
    upstream.once("error", reject);
    upstream.listen(upstreamPort, "127.0.0.1", ready);
  });
  await saveBridgeConfig(bridgeRoot, {
    mcpEndpoint: `http://127.0.0.1:${upstreamPort}/mcp`,
    captureEndpoint: `http://127.0.0.1:${upstreamPort}/capture`,
    deviceToken,
    cloudflareAccessClientId: "test-service-id",
    cloudflareAccessClientSecret: "test-service-secret"
  });
  const child = spawn(process.execPath, [resolve(here, "../dist/bridge.js"), "serve", "--port", String(bridgePort)], {
    env: { ...process.env, MEMHUB_BRIDGE_HOME: bridgeRoot, MEMHUB_BRIDGE_UPSTREAM_TIMEOUT_MS: "100" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => { stderr += data; });
  try {
    const deadline = Date.now() + 5_000;
    while (!stderr.includes("[memhub-bridge] listening") && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    assert.match(stderr, /\[memhub-bridge\] listening/);
    const response = await fetch(`http://127.0.0.1:${bridgePort}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("mcp-session-id"), "bridge-proxy-session");
    assert.equal(observed.length, 1);
    assert.equal(observed[0].headers["x-memhub-device-token"], deviceToken);
    assert.equal(observed[0].headers["cf-access-client-id"], "test-service-id");
    assert.equal(observed[0].headers["cf-access-client-secret"], "test-service-secret");

    const longContext = await fetch(`http://127.0.0.1:${bridgePort}/context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "long context passthrough" })
    });
    assert.equal(longContext.status, 200);
    const longContextPayload = await longContext.json();
    assert.equal(longContextPayload.content.length, 600_000);
    assert.equal(observed.at(-1).url, "/context");

    const oversizedMcp = await fetch(`http://127.0.0.1:${bridgePort}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(4_000_001)
    });
    assert.equal(oversizedMcp.status, 413);
    assert.equal((await oversizedMcp.json()).error, "request_body_too_large");

    const timedOutContext = await fetch(`http://127.0.0.1:${bridgePort}/context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "__timeout__" })
    });
    assert.equal(timedOutContext.status, 504);
    assert.equal((await timedOutContext.json()).error, "upstream_timeout");

    await new Promise((resolveClose, rejectClose) => upstream.close((error) => error ? rejectClose(error) : resolveClose()));
    const unavailableContext = await fetch(`http://127.0.0.1:${bridgePort}/context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "upstream unavailable classification" })
    });
    assert.equal(unavailableContext.status, 502);
    assert.equal((await unavailableContext.json()).error, "upstream_unavailable");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => {
      child.once("exit", resolveExit);
      setTimeout(resolveExit, 500);
    });
    if (upstream.listening) await new Promise((resolveClose) => upstream.close(resolveClose));
  }
}

async function testLocalAdmin(memoryPort) {
  const port = await freePort();
  const stateRoot = join(root, "local-admin");
  const account = await addAccount(stateRoot, "admin-test", "admin@example.com");
  await setAccountRole(stateRoot, account.account_id, "admin");
  const device = await createDevice(stateRoot, account.account_id, "control-plane-l1-test");
  const controlUserId = defaultMemoryUserId(account.account_id);
  memoryById.set("legacy-control-l1", {
    id: "legacy-control-l1",
    memoryLayer: "L1",
    status: "activated",
    title: "Legacy Memmy L1",
    summary: "Legacy Memory Core L1 must remain visible after the Capture/Turn Log migration.",
    tags: ["project:ui-beta", "legacy-memmy"],
    namespace: { userId: controlUserId, projectId: "ui-beta" },
    createdAt: "2026-09-19T04:00:00.000Z",
    updatedAt: "2026-09-19T04:30:00.000Z",
    metadata: { source: "memhub:chatgpt:mcp" }
  });
  memoryById.set("legacy-linked-control-l1", {
    id: "legacy-linked-control-l1",
    memoryLayer: "L1",
    status: "activated",
    title: "Legacy Memmy L1 linked to raw turn",
    summary: "This memory is a derived representation of the same legacy raw turn.",
    body: "Summary: derived legacy trace\nRawTurn: raw_legacy_ui_beta\nUser:\nLegacy raw user turn for ui-beta.\nAssistant:\nLegacy raw assistant turn for ui-beta.",
    tags: ["project:ui-beta", "legacy-memmy"],
    namespace: { userId: controlUserId, projectId: "ui-beta" },
    createdAt: "2026-09-18T03:01:00.000Z",
    updatedAt: "2026-09-18T03:01:00.000Z",
    metadata: { source: "legacy-codex" }
  });
  memoryById.set("capture-managed-control-l1", {
    id: "capture-managed-control-l1",
    memoryLayer: "L1",
    status: "activated",
    title: "Capture-managed L1",
    summary: "This row belongs to the new capture pipeline and must not seed the legacy rebuild.",
    tags: ["project:ui-beta", "memhub-capture"],
    namespace: { userId: controlUserId, projectId: "ui-beta" },
    createdAt: "2026-09-20T04:00:00.000Z",
    updatedAt: "2026-09-20T04:30:00.000Z",
    metadata: { source: "memhub-capture" }
  });
  rawTurnRecords.push({
    rawTurnId: "raw_legacy_ui_beta",
    sessionId: "legacy-session-ui-beta",
    episodeId: "legacy-episode-ui-beta",
    turnId: "legacy-turn-ui-beta",
    userId: controlUserId,
    conversationId: "legacy-conversation-ui-beta",
    projectId: "ui-beta",
    sessionSource: "codex",
    userText: "Legacy raw user turn for ui-beta.",
    assistantText: "Legacy raw assistant turn for ui-beta.",
    reasoningSummary: "Legacy raw reasoning summary.",
    status: "succeeded",
    createdAt: "2026-09-18T03:00:00.000Z"
  });
  rawTurnRecords.push({
    rawTurnId: "raw_legacy_unresolved",
    sessionId: "legacy-session-unresolved",
    episodeId: "legacy-episode-unresolved",
    turnId: "legacy-turn-unresolved",
    userId: controlUserId,
    conversationId: "legacy-conversation-unresolved",
    projectId: "ws_unresolved_hash",
    sessionSource: "codex",
    userText: "Legacy raw turn with unresolved workspace scope.",
    assistantText: "Keep this visible account-wide without guessing a project.",
    status: "succeeded",
    createdAt: "2026-09-18T02:00:00.000Z"
  });
  const token = await ensureLocalAdminToken(stateRoot);
  const child = spawn(process.execPath, [
    mcpEntry,
    "--http", String(port),
    "--account", account.account_id,
    "--memory-url", `http://127.0.0.1:${memoryPort}`,
    "--state-root", stateRoot,
    "--bindings", join(root, "local-admin-bindings.json"),
    "--public-host", "memhub.example.test",
  ], { env: { ...process.env, MEMHUB_MEMORY_DB: historyDbPath }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => { stderr += data; });
  try {
    const deadline = Date.now() + 5_000;
    while (!stderr.includes("listening on http://127.0.0.1:") && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    const partialCapture = await fetch(`http://127.0.0.1:${port}/memhub/capture`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-memhub-device-token": device.token },
      body: JSON.stringify({
        event_id: "control-plane-live-turn",
        host: "chatgpt",
        conversation_id: "control-plane-live-chat",
        timestamp: "2026-09-20T12:44:13.827Z",
        user_text: "This live conversation has not reached assistant final yet.",
        capture_status: "partial"
      })
    });
    assert.equal(partialCapture.status, 201);
    const anonymous = await fetch(`http://127.0.0.1:${port}/memhub/admin`);
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get("www-authenticate") ?? "", /Memhub local admin/);
    const authorization = `Basic ${Buffer.from(`memhub:${token}`).toString("base64")}`;
    const authenticated = await fetch(`http://127.0.0.1:${port}/memhub/admin`, { headers: { authorization } });
    assert.equal(authenticated.status, 200);
    assert.equal(authenticated.headers.get("x-frame-options"), "DENY");
    assert.match(authenticated.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(authenticated.headers.get("referrer-policy"), "no-referrer");
    const authenticatedHtml = await authenticated.text();
    assertInlineScriptsParse(authenticatedHtml);
    assert.match(authenticatedHtml, /Local token .* loopback/);
    assert.match(authenticatedHtml, /ADMIN \/ OPERATIONS/);
    assert.match(authenticatedHtml, /class="admin-body memory-console-body admin-mode"/);
    assert.match(authenticatedHtml, /@media\(max-width:900px\)/);
    assert.match(authenticatedHtml, /id="console-menu-toggle"/);
    assert.match(authenticatedHtml, /name="theme-color"/);
    assert.match(authenticatedHtml, /class="skip-link" href="#main-content"/);
    assert.match(authenticatedHtml, /touch-action:manipulation/);
    assert.match(authenticatedHtml, /overscroll-behavior:contain/);
    assert.match(authenticatedHtml, /name="memory-filter"/);
    assert.match(authenticatedHtml, /name="project-description"/);
    assert.match(authenticatedHtml, /autocomplete="off"/);
    assert.match(authenticatedHtml, /id="refresh"/);
    assert.match(authenticatedHtml, /id="theme-toggle"/);
    assert.match(authenticatedHtml, /localStorage\.memhubTheme/);
    assert.match(authenticatedHtml, /localStorage\.memhubLang/);
    assert.match(authenticatedHtml, /Intl\.DateTimeFormat/);
    assert.match(authenticatedHtml, /L1 · MEMORY/);
    assert.match(authenticatedHtml, /data-theme="light"/);
    assert.match(authenticatedHtml, /data-view="projects"/);
    assert.match(authenticatedHtml, /data-view="l1"/);
    assert.match(authenticatedHtml, /data-view="l2"/);
    assert.match(authenticatedHtml, /data-view="l3"/);
    assert.match(authenticatedHtml, /data-view="l4"/);
    assert.match(authenticatedHtml, /data-view="skills"/);
    assert.match(authenticatedHtml, /data-view="processing"/);
    assert.match(authenticatedHtml, /id="account-select"/);
    assert.match(authenticatedHtml, /id="mobile-view-select"/);
    assert.match(authenticatedHtml, /data-en="Admin"/);
    assert.match(authenticatedHtml, /id="memory-flow"/);
    assert.match(authenticatedHtml, /id="primary-action"/);
    assert.match(authenticatedHtml, /class="nav-group"/);
    assert.match(authenticatedHtml, /class="project-ledger-record"/);
    assert.match(authenticatedHtml, /class="policy-card"/);
    assert.match(authenticatedHtml, /create-project/);
    assert.match(authenticatedHtml, /set-distillation-config/);
    assert.match(authenticatedHtml, /id="project-delete-confirm"/);
    assert.match(authenticatedHtml, /HIGH IMPACT/);
    assert.doesNotMatch(authenticatedHtml, /data-view="captures"/);
    assert.doesNotMatch(authenticatedHtml, /data-view="episodes"/);
    assert.match(authenticatedHtml, /function renderOverview/);
    assert.match(authenticatedHtml, /class="site-header console-topbar"/);
    assert.match(authenticatedHtml, /class="site-brand"/);
    assert.match(authenticatedHtml, /aria-live="polite"/);
    assert.match(authenticatedHtml, /role="dialog"/);
    assert.match(authenticatedHtml, /prefers-reduced-motion:reduce/);
    const landing = await fetch(`http://127.0.0.1:${port}/memhub`);
    assert.equal(landing.status, 200);
    const landingHtml = await landing.text();
    assertInlineScriptsParse(landingHtml);
    assert.match(landingHtml, /DURABLE AI MEMORY/);
    assert.match(landingHtml, /class="memory-model-v2"/);
    assert.match(landingHtml, /href="\/memhub\/docs\/workflows"/);
    assert.match(landingHtml, /github\.com\/PhSanqi\/Memhub/);
    assert.match(landingHtml, /href="\/memhub\/docs"/);
    assert.match(landingHtml, /href="\/memhub\/docs\/install"/);
    assert.match(landingHtml, /id="theme-toggle"/);
    assert.match(landingHtml, /class="hero-product-proof"/);
    assert.match(landingHtml, /class="memory-topology"/);
    assert.match(landingHtml, /class="skill-plane"/);
    assert.match(landingHtml, /Skill 不是第五层/);
    assert.match(landingHtml, /\/assets\/logo-mark\.png/);
    for (const asset of ["logo-mark.png", "logo-lockup.png"]) {
      const response = await fetch(`http://127.0.0.1:${port}/memhub/assets/${asset}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /image\/png/);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.ok(bytes.length > 1000, `${asset} should be a real PNG asset`);
      assert.equal(String.fromCharCode(...bytes.slice(1, 4)), "PNG");
    }
    assert.match(landingHtml, /id="lang-toggle"/);
    assert.match(landingHtml, /data-en="Let the next AI session/);
    assert.match(landingHtml, /class="quickstart"/);
    assert.match(landingHtml, /name="theme-color"/);
    assert.match(landingHtml, /class="skip-link" href="#main-content"/);
    assert.match(landingHtml, /data-theme="light"/);
    assert.match(landingHtml, /landing-brand site-brand/);
    assert.match(landingHtml, /prefers-reduced-motion:reduce/);
    for (const docsPath of ["/memhub/docs", "/memhub/docs/install", "/memhub/docs/workflows", "/memhub/docs/privacy", "/memhub/docs/troubleshooting"]) {
      const docsResponse = await fetch(`http://127.0.0.1:${port}${docsPath}`);
      assert.equal(docsResponse.status, 200, `${docsPath} should be public`);
      const docsHtml = await docsResponse.text();
      assertInlineScriptsParse(docsHtml);
      assert.match(docsHtml, /MEMHUB DOCS/);
      assert.match(docsHtml, /aria-current="page"/);
      assert.match(docsHtml, /class="docs-task-meta"/);
      assert.match(docsHtml, /class="docs-page-toc"/);
      assert.match(docsHtml, /class="docs-pagination"/);
      const countMatch = docsHtml.match(/<b>(\d+) 字<\/b>/);
      assert.ok(countMatch && Number(countMatch[1]) >= 3000, `${docsPath} should expose at least 3000 Chinese characters`);
    }
    const workspaceView = await fetch(`http://127.0.0.1:${port}/memhub/user`, { headers: { authorization } });
    assert.equal(workspaceView.status, 200);
    const workspaceHtml = await workspaceView.text();
    assertInlineScriptsParse(workspaceHtml);
    assert.match(workspaceHtml, /data-en="My memory"/);
    assert.match(workspaceHtml, /data-en="Continue working"/);
    assert.match(workspaceHtml, /id="workspace-title"/);
    assert.match(workspaceHtml, /function updateWorkspaceShell/);
    assert.match(workspaceHtml, /function renderPortfolioOverview/);
    assert.match(workspaceHtml, /class="portfolio-record"/);
    assert.match(workspaceHtml, /class="project-ledger-record"/);
    assert.match(workspaceHtml, /data-view="l1"/);
    assert.match(workspaceHtml, /data-view="l2"/);
    assert.match(workspaceHtml, /data-view="l3"/);
    assert.match(workspaceHtml, /data-view="l4"/);
    assert.match(workspaceHtml, /data-view="skills"/);
    assert.match(workspaceHtml, /data-view="processing"/);
    assert.doesNotMatch(workspaceHtml, /id="account-select"/);
    assert.doesNotMatch(workspaceHtml, /DEVICE ACCESS/);
    assert.doesNotMatch(workspaceHtml, /data-view="captures"/);
    assert.doesNotMatch(workspaceHtml, /data-view="episodes"/);
    assert.match(workspaceHtml, /class="admin-body memory-console-body workspace-mode"/);
    assert.match(workspaceHtml, /id="theme-toggle"/);
    assert.match(workspaceHtml, /id="lang"/);
    assert.match(workspaceHtml, /localStorage\.memhubTheme/);
    assert.match(workspaceHtml, /localStorage\.memhubLang/);
    assert.match(workspaceHtml, /function artifactBodyHtml/);
    assert.match(workspaceHtml, /class="timeline-event"/);
    assert.match(workspaceHtml, /__memhubAutoRefresh/);
    assert.match(workspaceHtml, /load\(current,true,'none'\)/);
    assert.match(workspaceHtml, /data-theme="light"/);
    assert.match(workspaceHtml, /class="site-header console-topbar"/);
    assert.match(workspaceHtml, /class="site-brand"/);
    if (process.env.MEMHUB_WRITE_REVIEW_PAGES === "1") {
      const reviewDir = resolve(here, "../.review-runtime/redesign-v2/pages");
      await mkdir(reviewDir, { recursive: true });
      await writeFile(join(reviewDir, "landing.html"), landingHtml);
      await writeFile(join(reviewDir, "workspace.html"), consoleHtmlWithBrowserMocks(workspaceHtml));
      await writeFile(join(reviewDir, "admin.html"), consoleHtmlWithBrowserMocks(authenticatedHtml));
      const reviewDocs = {
        "docs.html": "/memhub/docs",
        "install.html": "/memhub/docs/install",
        "workflows.html": "/memhub/docs/workflows",
        "privacy.html": "/memhub/docs/privacy",
        "troubleshooting.html": "/memhub/docs/troubleshooting"
      };
      for (const [filename, pathname] of Object.entries(reviewDocs)) {
        const html = await (await fetch(`http://127.0.0.1:${port}${pathname}`)).text();
        await writeFile(join(reviewDir, filename), html);
      }
    }
    await assertResponsiveLayoutWithChromium({
      landing: landingHtml,
      workspace: workspaceHtml,
      admin: authenticatedHtml
    });
    await assertBrowserInteractionsWithChromium({
      workspaceHtml,
      adminHtml: authenticatedHtml
    });
    const projectView = await fetch(`http://127.0.0.1:${port}/memhub/admin/api?kind=projects`, { headers: { authorization } });
    assert.equal(projectView.status, 200);
    const projectPayload = await projectView.json();
    assert.equal(Array.isArray(projectPayload.items), true);
    const l1View = await fetch(`http://127.0.0.1:${port}/memhub/admin/api?kind=l1`, { headers: { authorization } });
    assert.equal(l1View.status, 200);
    const l1Payload = await l1View.json();
    assert.ok(l1Payload.items.some((item) => item.id === "legacy-control-l1" && item.source_kind === "memory-core"));
    assert.ok(l1Payload.items.some((item) => item.event_id === "control-plane-live-turn" && item.source_kind === "capture"));
    assert.ok(l1Payload.items.some((item) => item.rawTurnId === "raw_legacy_unresolved" && item.source_kind === "raw-turn" && item.project_unresolved === true));
    assert.ok(l1Payload.total >= 2);
    assert.equal(l1Payload.counts.incomplete >= 1, true);
    const adminAction = async (body) => fetch(`http://127.0.0.1:${port}/memhub/admin/action`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const createAlpha = await adminAction({
      action: "create-project",
      project: "ui-alpha",
      name: "UI Alpha",
      description: "Project created by Control Plane E2E.",
      aliases: ["Alpha UI"]
    });
    assert.equal(createAlpha.status, 200);
    const createBeta = await adminAction({
      action: "create-project",
      project: "ui-beta",
      name: "UI Beta",
      description: "Merge target for Control Plane E2E.",
      aliases: []
    });
    assert.equal(createBeta.status, 200);
    const addAlphaTodo = await adminAction({ action: "add-project-todo", project: "ui-alpha", text: "Finish the pending Alpha task." });
    assert.equal(addAlphaTodo.status, 200);
    const alphaTodoPayload = await addAlphaTodo.json();
    const alphaTodo = alphaTodoPayload.result.todos.find((todo) => todo.text === "Finish the pending Alpha task.");
    assert.ok(alphaTodo);
    assert.equal(alphaTodo.status, "pending");
    const addBetaTodo = await adminAction({ action: "add-project-todo", project: "ui-beta", text: "Completed Beta history item." });
    assert.equal(addBetaTodo.status, 200);
    const betaTodoPayload = await addBetaTodo.json();
    const betaTodo = betaTodoPayload.result.todos.find((todo) => todo.text === "Completed Beta history item.");
    assert.ok(betaTodo);
    const completeBetaTodo = await adminAction({ action: "set-project-todo-status", project: "ui-beta", todo_id: betaTodo.id, status: "done" });
    assert.equal(completeBetaTodo.status, 200);
    const reopenBetaTodo = await adminAction({ action: "set-project-todo-status", project: "ui-beta", todo_id: betaTodo.id, status: "pending" });
    assert.equal(reopenBetaTodo.status, 200);
    assert.equal((await reopenBetaTodo.json()).result.todos.find((todo) => todo.id === betaTodo.id)?.completedAt, undefined);
    const recompleteBetaTodo = await adminAction({ action: "set-project-todo-status", project: "ui-beta", todo_id: betaTodo.id, status: "done" });
    assert.equal(recompleteBetaTodo.status, 200);
    const rebuildBeta = await adminAction({ action: "queue-legacy-rebuild", project: "ui-beta" });
    assert.equal(rebuildBeta.status, 200);
    const rebuildPayload = await rebuildBeta.json();
    assert.equal(rebuildPayload.rebuild.queued_jobs, 1);
    assert.equal(rebuildPayload.rebuild.projects[0].project_id, "ui-beta");
    assert.equal(rebuildPayload.rebuild.projects[0].evidence_count, 2);
    assert.equal(rebuildPayload.rebuild.projects[0].raw_turn_count, 1);
    assert.equal(rebuildPayload.rebuild.projects[0].memory_count, 1);
    assert.equal(rebuildPayload.rebuild.projects[0].deduped_memory_count, 1);
    assert.equal(rebuildPayload.rebuild.projects[0].excluded_capture_count, 1);
    const migrationJob = (await listDistillationJobs(stateRoot, account.account_id))
      .find((job) => job.reason === "migration" && job.project_id === "ui-beta");
    assert.ok(migrationJob);
    assert.equal(migrationJob.target, "l2");
    assert.deepEqual(migrationJob.evidence_refs, ["raw-turn:raw_legacy_ui_beta", "l1-memory:legacy-control-l1"]);
    assert.equal(migrationJob.evidence.some((item) => item.kind === "turn" && item.ref === "raw-turn:raw_legacy_ui_beta"), true);
    assert.equal(migrationJob.evidence.some((item) => item.kind === "memory" && item.ref === "l1-memory:legacy-control-l1"), true);
    const scopedL1 = await fetch(`http://127.0.0.1:${port}/memhub/admin/api?kind=l1&project=ui-beta`, { headers: { authorization } });
    assert.equal(scopedL1.status, 200);
    const scopedL1Payload = await scopedL1.json();
    assert.ok(scopedL1Payload.items.some((item) => item.rawTurnId === "raw_legacy_ui_beta" && item.project_id === "ui-beta"));
    assert.equal(scopedL1Payload.items.some((item) => item.rawTurnId === "raw_legacy_unresolved"), false);
    const updateAlpha = await adminAction({
      action: "update-project",
      project: "ui-alpha",
      name: "UI Alpha Updated",
      description: "Updated through the Admin Control Plane.",
      aliases: ["Alpha UI", "Alpha Updated"]
    });
    assert.equal(updateAlpha.status, 200);
    const mergeAlpha = await adminAction({ action: "merge-project", project: "ui-alpha", target: "ui-beta" });
    assert.equal(mergeAlpha.status, 200);
    const createDelete = await adminAction({
      action: "create-project",
      project: "ui-delete",
      description: "Disposable Control Plane project.",
      aliases: []
    });
    assert.equal(createDelete.status, 200);
    const deleteBlocker = await enqueueDerivedDistillationJob({
      stateRoot,
      accountId: account.account_id,
      target: "l3",
      projectId: "ui-delete",
      evidence: [{
        ref: "artifact:ui-delete-blocker",
        kind: "artifact",
        timestamp: "2026-09-22T00:00:00.000Z",
        project_id: "ui-delete",
        layer: "L2",
        content: "Pending Control Plane deletion blocker."
      }]
    });
    const blockedDeleteProject = await adminAction({ action: "delete-project", project: "ui-delete" });
    assert.equal(blockedDeleteProject.status, 409);
    const blockedDeletePayload = await blockedDeleteProject.json();
    assert.equal(blockedDeletePayload.error, "unfinished_distillation_jobs");
    assert.ok(blockedDeletePayload.jobs.some((job) => job.job_id === deleteBlocker.job.job_id));
    const deleteBlockerHarness = "ui-delete-blocker-harness";
    const leasedDeleteBlocker = await leaseDistillationJob(stateRoot, account.account_id, {
      projectId: "ui-delete",
      target: "l3",
      harness: deleteBlockerHarness
    });
    assert.equal(leasedDeleteBlocker?.job_id, deleteBlocker.job.job_id);
    await completeDistillationJob(
      stateRoot,
      account.account_id,
      deleteBlocker.job.job_id,
      { kind: "noop" },
      deleteBlockerHarness
    );
    const deleteProject = await adminAction({ action: "delete-project", project: "ui-delete" });
    assert.equal(deleteProject.status, 200);
    const projectsAfterMutations = await fetch(`http://127.0.0.1:${port}/memhub/admin/api?kind=projects`, { headers: { authorization } });
    const projectsAfterPayload = await projectsAfterMutations.json();
    const mergedTarget = projectsAfterPayload.items.find((item) => item.project_id === "ui-beta");
    assert.ok(mergedTarget);
    assert.ok(mergedTarget.aliases.includes("ui-alpha"));
    assert.equal(mergedTarget.pending_todo_count, 1);
    assert.deepEqual(mergedTarget.pending_todos.map((todo) => todo.text), ["Finish the pending Alpha task."]);
    assert.equal(mergedTarget.todos.length, 2);
    assert.equal(mergedTarget.todos.find((todo) => todo.id === betaTodo.id)?.status, "done");
    assert.ok(mergedTarget.todos.find((todo) => todo.id === betaTodo.id)?.completedAt);
    assert.equal(projectsAfterPayload.items.some((item) => item.project_id === "ui-alpha"), false);
    assert.equal(projectsAfterPayload.items.some((item) => item.project_id === "ui-delete"), false);
    const userProjectMutation = await fetch(`http://127.0.0.1:${port}/memhub/user/action`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ action: "create-project", project: "forbidden-user-project", description: "must fail" })
    });
    assert.equal(userProjectMutation.status, 403);
    const userTodoMutation = await fetch(`http://127.0.0.1:${port}/memhub/user/action`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ action: "add-project-todo", project: "ui-beta", text: "must fail" })
    });
    assert.equal(userTodoMutation.status, 403);
    const nonJsonAdminMutation = await fetch(`http://127.0.0.1:${port}/memhub/admin/action`, {
      method: "POST",
      headers: { authorization, "content-type": "text/plain" },
      body: JSON.stringify({ action: "set-distillation-config", auto_enabled: true })
    });
    assert.equal(nonJsonAdminMutation.status, 415);
    const processingBefore = await fetch(`http://127.0.0.1:${port}/memhub/admin/api?kind=processing`, { headers: { authorization } });
    assert.equal(processingBefore.status, 200);
    const processingBeforePayload = await processingBefore.json();
    assert.deepEqual(processingBeforePayload.config, { auto_enabled: false, turn_threshold: 8, idle_minutes: 30 });
    assert.ok(processingBeforePayload.items.length >= 1);
    assert.equal("evidence" in processingBeforePayload.items[0], false);
    assert.equal("result_content" in processingBeforePayload.items[0], false);
    assert.equal(typeof processingBeforePayload.items[0].evidence_count, "number");
    const updatePolicy = await adminAction({ action: "set-distillation-config", auto_enabled: true, turn_threshold: 12, idle_minutes: 45 });
    assert.equal(updatePolicy.status, 200);
    const processingAfter = await fetch(`http://127.0.0.1:${port}/memhub/admin/api?kind=processing`, { headers: { authorization } });
    assert.deepEqual((await processingAfter.json()).config, { auto_enabled: true, turn_threshold: 12, idle_minutes: 45 });
    const userOverview = await fetch(`http://127.0.0.1:${port}/memhub/user/api?kind=overview`, { headers: { authorization } });
    assert.equal(userOverview.status, 200);
    const userOverviewPayload = await userOverview.json();
    assert.equal(userOverviewPayload.account.account_id, account.account_id);
    assert.equal(userOverviewPayload.counts.pendingTodo, 1);
    assert.equal(userOverviewPayload.todos.total, 1);
    assert.equal(userOverviewPayload.todos.projects, 1);
    assert.deepEqual(userOverviewPayload.todos.pending.map((todo) => todo.text), ["Finish the pending Alpha task."]);
    const hiddenLegacyView = await fetch(`http://127.0.0.1:${port}/memhub/admin/api?kind=captures`, { headers: { authorization } });
    assert.equal(hiddenLegacyView.status, 400);
    const accountsView = await fetch(`http://127.0.0.1:${port}/memhub/admin/api?kind=accounts`, { headers: { authorization } });
    assert.equal(accountsView.status, 200);
    const tunnelLike = await fetch(`http://127.0.0.1:${port}/memhub/admin`, {
      headers: { authorization, "cf-ray": "test-ray" }
    });
    assert.equal(tunnelLike.status, 401);
    assert.match(await tunnelLike.text(), /Cloudflare Access authentication required/);
    const publicHostWithLocalToken = await rawHttp(port, "/memhub/admin", {
      authorization,
      host: "memhub.example.test"
    });
    assert.equal(publicHostWithLocalToken.status, 401);
    assert.match(publicHostWithLocalToken.body, /Cloudflare Access authentication required/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => {
      child.once("exit", resolveExit);
      setTimeout(resolveExit, 500);
    });
  }
}

async function testRootBasePath(memoryPort) {
  const port = await freePort();
  const stateRoot = join(root, "root-base-path");
  const account = await addAccount(stateRoot, "root-admin", "root@example.com");
  await setAccountRole(stateRoot, account.account_id, "admin");
  const token = await ensureLocalAdminToken(stateRoot);
  const child = spawn(process.execPath, [
    mcpEntry,
    "--http", String(port),
    "--http-path", "/mcp",
    "--capture-path", "/capture",
    "--account", account.account_id,
    "--memory-url", `http://127.0.0.1:${memoryPort}`,
    "--state-root", stateRoot,
    "--bindings", join(root, "root-base-path-bindings.json"),
  ], {
    env: { ...process.env, MEMHUB_BASE_PATH: "/", MEMHUB_MEMORY_DB: historyDbPath },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => { stderr += data; });
  try {
    const deadline = Date.now() + 5_000;
    while (!stderr.includes("listening on http://127.0.0.1:") && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    const landing = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(landing.status, 200);
    const landingHtml = await landing.text();
    assert.match(landingHtml, /href="\/user"/);
    assert.doesNotMatch(landingHtml, /\/memhub\//);
    const legacyLanding = await fetch(`http://127.0.0.1:${port}/memhub`);
    assert.equal(legacyLanding.status, 404);
    const authorization = `Basic ${Buffer.from(`memhub:${token}`).toString("base64")}`;
    const workspace = await fetch(`http://127.0.0.1:${port}/user`, { headers: { authorization } });
    assert.equal(workspace.status, 200);
    const workspaceHtml = await workspace.text();
    assert.match(workspaceHtml, /href="\/admin"/);
    assert.doesNotMatch(workspaceHtml, /\/memhub\//);
    const admin = await fetch(`http://127.0.0.1:${port}/admin`, { headers: { authorization } });
    assert.equal(admin.status, 200);
    const adminHtml = await admin.text();
    assert.match(adminHtml, /\/admin\/api/);
    assert.match(adminHtml, /\/admin\/action/);
    assert.doesNotMatch(adminHtml, /\/memhub\//);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => {
      child.once("exit", resolveExit);
      setTimeout(resolveExit, 500);
    });
  }
}

function rawHttp(port, path, headers = {}) {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, method: "GET", headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolvePromise({ status: response.statusCode, headers: response.headers, body }));
    });
    request.once("error", reject);
    request.end();
  });
}

async function testStdio(memoryPort) {
  const stateRoot = join(root, "stdio-state");
  const architectureDir = join(root, "normify-aide", "modules", "aide");
  const currentArchitectureDir = join(root, "Memhub", "docs");
  await mkdir(architectureDir, { recursive: true });
  await mkdir(currentArchitectureDir, { recursive: true });
  await writeFile(join(root, "Memhub", "package.json"), JSON.stringify({ name: "memhub-test-project" }) + "\n");
  await writeFile(
    join(architectureDir, "core.md"),
    "# AIDE Core Architecture\n\nBroker routes work to the harness router. Current constraint: preserve explicit workspace ownership.\n"
  );
  await writeFile(
    join(currentArchitectureDir, "ARCHITECTURE.md"),
    "# Memhub Current Architecture\n\nL1 is authoritative source evidence. L2 and L3 are project-scoped, L4 is account-scoped.\n"
  );
  const architectureReader = new FileProjectArchitectureSource({ rootDir: root });
  const discoveredArchitectureProjects = await architectureReader.listProjects("acct-test");
  assert.ok(discoveredArchitectureProjects.some((project) => project.toLowerCase() === "aide"));
  assert.ok(discoveredArchitectureProjects.some((project) => project.toLowerCase() === "memhub"));
  assert.equal(discoveredArchitectureProjects.some((project) => project.toLowerCase() === "docs"), false);
  const currentDocs = await architectureReader.getProjectArchitecture({
    accountId: "acct-test",
    projectId: "memhub",
    query: "L1 L2 L3 L4 scope"
  });
  assert.ok(currentDocs.some((item) => /Memhub Current Architecture/.test(item.content)));
  assert.ok(currentDocs.some((item) => item.provenance?.format === "project-docs"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry, "--account", "acct-test", "--memory-url", `http://127.0.0.1:${memoryPort}`, "--state-root", stateRoot, "--bindings", join(root, "stdio-bindings.json"), "--normify-root", root],
    env: { ...process.env },
    stderr: "pipe"
  });
  const client = new Client({ name: "memhub-stdio-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    await exerciseClient(client, "stdio-chat", stateRoot);
  } finally {
    await client.close();
  }
}

async function testHttp(memoryPort) {
  const port = await freePort();
  const stateRoot = join(root, "state");
  const createdDevice = await createDevice(stateRoot, "acct-test", "test-device");
  const child = spawn(process.execPath, [
    mcpEntry,
    "--http", String(port),
    "--account", "acct-test",
    "--memory-url", `http://127.0.0.1:${memoryPort}`,
    "--state-root", stateRoot,
    "--bindings", join(root, "http-bindings.json"),
  ], { env: { ...process.env, MEMHUB_MEMORY_DB: historyDbPath }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => { stderr += data; });
  try {
    const deadline = Date.now() + 5_000;
    while (!stderr.includes("listening on http://127.0.0.1:") && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    assert.match(stderr, /listening on http:\/\/127\.0\.0\.1:/);
    const health = await fetch(`http://127.0.0.1:${port}/memhub/health`);
    assert.equal(health.status, 200);
    const healthPayload = await health.json();
    assert.equal(healthPayload.ok, true);
    assert.equal(healthPayload.service, "memhub");
    assert.ok(Number.isInteger(healthPayload.uptime_seconds));
    const client = new Client({ name: "memhub-http-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    try {
      await client.connect(transport);
      await exerciseClient(client, "http-chat", stateRoot);
      const projects = JSON.parse((await client.callTool({ name: "memmy_project", arguments: { action: "list" } })).content[0].text);
      assert.ok(projects.projects.includes("aide"));
      assert.ok(!projects.projects.some((project) => /^ws_[a-f0-9]{32,}$/i.test(project)));

      const longContext = JSON.parse((await client.callTool({
        name: "memmy_context",
        arguments: { query: "__long_context_probe__", project: "aide", limit: 1 }
      })).content[0].text);
      const longContextItem = longContext.globalMemory.find((item) => item.id === "long-context-probe");
      assert.ok(longContextItem);
      assert.ok(Buffer.byteLength(longContextItem.content, "utf8") <= longContext.contextBudget.maxItemContentBytes);
      assert.equal(longContextItem.provenance.contextTruncated, true);
      assert.equal(longContextItem.provenance.originalContentBytes, Buffer.byteLength("界".repeat(600_000), "utf8"));
      assert.ok(longContext.contextBudget.truncatedItems >= 1);
      assert.ok(longContext.contextBudget.emittedContentBytes <= longContext.contextBudget.maxContentBytes);

      const longEvidenceProject = "long-evidence-http";
      const registry = new JsonProjectRegistry(join(root, "project-registry.json"));
      if (!(await registry.resolve("acct-test", longEvidenceProject))) {
        await registry.create("acct-test", {
          projectId: longEvidenceProject,
          description: "Dedicated long evidence transport regression project."
        });
      }
      const longEvidenceJob = await enqueueDerivedDistillationJob({
        stateRoot,
        accountId: "acct-test",
        target: "l3",
        projectId: longEvidenceProject,
        evidence: [{
          ref: "artifact:long-evidence-http",
          kind: "artifact",
          timestamp: "2026-09-22T00:00:00.000Z",
          project_id: longEvidenceProject,
          layer: "L2",
          content: "证".repeat(260_000)
        }]
      });
      const longHarness = "http-long-evidence-harness";
      let chunkPayload = JSON.parse((await client.callTool({
        name: "memhub_distill",
        arguments: {
          action: "next",
          kind: "l3",
          scope: "project",
          project: longEvidenceProject,
          source_harness: longHarness,
          evidence_chunk_chars: 100_000
        }
      })).content[0].text);
      assert.equal(chunkPayload.job.job_id, longEvidenceJob.job.job_id);
      assert.equal(chunkPayload.evidence_transport.mode, "chunked");
      assert.equal(chunkPayload.job.evidence[0].content, undefined);
      assert.equal(chunkPayload.job.evidence[0].text_chars.content, 260_000);
      let collectedChars = chunkPayload.evidence_chunk.length;
      while (chunkPayload.evidence_transport.next_offset !== null) {
        chunkPayload = JSON.parse((await client.callTool({
          name: "memhub_distill",
          arguments: {
            action: "next",
            job_id: longEvidenceJob.job.job_id,
            source_harness: longHarness,
            evidence_offset: chunkPayload.evidence_transport.next_offset,
            evidence_chunk_chars: 100_000
          }
        })).content[0].text);
        collectedChars += chunkPayload.evidence_chunk.length;
      }
      assert.equal(chunkPayload.evidence_transport.complete, true);
      assert.equal(collectedChars, chunkPayload.evidence_transport.total_chars);
      assert.equal(JSON.parse((await client.callTool({
        name: "memhub_distill",
        arguments: { action: "skip", job_id: longEvidenceJob.job.job_id, source_harness: longHarness }
      })).content[0].text).ok, true);
    } finally {
      await client.close();
    }

    const captureCountBaseline = await countCaptureEvents(stateRoot);
    const distillationCountBaseline = (await listDistillationJobs(stateRoot, "acct-test")).length;

    const captureEvent = {
      event_id: "capture-http-1",
      host: "coworker",
      host_version: "test",
      conversation_id: "capture-conversation",
      turn_id: "turn-1",
      timestamp: "2026-09-18T08:00:00.000Z",
      project_hint: "aide",
      user_text: "continue implementation",
      assistant_text: "implemented capture protocol"
    };
    const direct = await fetch(`http://127.0.0.1:${port}/memhub/capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createdDevice.token}`
      },
      body: JSON.stringify(captureEvent)
    });
    assert.equal(direct.status, 201);
    const duplicate = await fetch(`http://127.0.0.1:${port}/memhub/capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createdDevice.token}`
      },
      body: JSON.stringify(captureEvent)
    });
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).duplicate, true);
    assert.equal(await countCaptureEvents(stateRoot), captureCountBaseline + 1);
    assert.ok(requests.some((entry) => entry.url === "/api/v1/sessions/open"));
    assert.ok(requests.some((entry) => entry.url?.startsWith("/api/v1/turns/") && entry.url.endsWith("/complete")));

    const completeBeforePartial = requests.filter((entry) => entry.url?.startsWith("/api/v1/turns/") && entry.url.endsWith("/complete")).length;
    const partial = await fetch(`http://127.0.0.1:${port}/memhub/capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createdDevice.token}`
      },
      body: JSON.stringify({
        event_id: "capture-partial-1",
        host: "codex",
        conversation_id: "partial-conversation",
        turn_id: "partial-turn",
        timestamp: "2026-09-18T08:01:00.000Z",
        user_text: "user side only"
      })
    });
    assert.equal(partial.status, 201);
    const partialBody = await partial.json();
    assert.equal(partialBody.ingestion.ingested, false);
    assert.equal(partialBody.ingestion.reason, "turn_not_complete:open");
    assert.equal(await countCaptureEvents(stateRoot), captureCountBaseline + 2);
    assert.equal(
      requests.filter((entry) => entry.url?.startsWith("/api/v1/turns/") && entry.url.endsWith("/complete")).length,
      completeBeforePartial
    );

    const completedPartial = await fetch(`http://127.0.0.1:${port}/memhub/capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createdDevice.token}`
      },
      body: JSON.stringify({
        event_id: "capture-partial-1",
        host: "codex",
        conversation_id: "partial-conversation",
        turn_id: "partial-turn",
        timestamp: "2026-09-18T08:01:05.000Z",
        project_hint: "aide",
        assistant_text: "assistant side later"
      })
    });
    assert.equal(completedPartial.status, 200);
    const completedPartialBody = await completedPartial.json();
    assert.equal(completedPartialBody.updated, true);
    assert.equal(completedPartialBody.ingestion.ingested, true);
    assert.equal(completedPartialBody.ingestion.project_id, "aide");
    assert.equal(await countCaptureEvents(stateRoot), captureCountBaseline + 2);
    assert.equal(
      requests.filter((entry) => entry.url?.startsWith("/api/v1/turns/") && entry.url.endsWith("/complete")).length,
      completeBeforePartial + 1
    );

    assert.equal((await listDistillationJobs(stateRoot, "acct-test")).length, distillationCountBaseline);
    const capturesForDistillation = await listCaptureEvents(stateRoot, "acct-test");
    const queued = await enqueueDistillationJob({
      stateRoot,
      accountId: "acct-test",
      projectId: "aide",
      conversationId: "partial-conversation",
      captures: capturesForDistillation.filter((item) => item.conversation_id === "partial-conversation" && item.ingested),
      reason: "manual"
    });
    assert.equal(queued.created, true);
    const distillClient = new Client({ name: "memhub-distill-job-test", version: "1.0.0" });
    const distillTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    try {
      await distillClient.connect(distillTransport);
      const next = await distillClient.callTool({
        name: "memhub_distill",
        arguments: { action: "next", scope: "project", project: "aide", source_harness: "test-harness" }
      });
      const nextPayload = JSON.parse(next.content[0].text);
      assert.equal(nextPayload.job.job_id, queued.job.job_id);
      assert.equal(nextPayload.job.evidence.length, 1);
      assert.equal(nextPayload.job.evidence[0].user_text, "user side only");
      const skipped = await distillClient.callTool({
        name: "memhub_distill",
        arguments: { action: "skip", job_id: queued.job.job_id, source_harness: "test-harness" }
      });
      assert.equal(JSON.parse(skipped.content[0].text).skipped, true);
    } finally {
      await distillClient.close();
    }
    const completedJob = (await listDistillationJobs(stateRoot, "acct-test")).find((item) => item.job_id === queued.job.job_id);
    assert.equal(completedJob.status, "completed");
    assert.equal(completedJob.result_kind, "noop");

    const retrySource = capturesForDistillation.filter((item) => item.conversation_id === "capture-conversation" && item.ingested);
    const retryQueued = await enqueueDistillationJob({
      stateRoot,
      accountId: "acct-test",
      projectId: "aide",
      conversationId: "capture-conversation",
      captures: retrySource,
      reason: "manual"
    });
    const retryLeased = await leaseDistillationJob(stateRoot, "acct-test", { projectId: "aide", harness: "retry-test" });
    assert.equal(retryLeased.job_id, retryQueued.job.job_id);
    assert.equal(retryLeased.attempts, 1);
    await failDistillationJob(stateRoot, "acct-test", retryLeased.job_id, "simulated commit failure", "retry-test");
    const failedJob = (await listDistillationJobs(stateRoot, "acct-test")).find((item) => item.job_id === retryLeased.job_id);
    assert.equal(failedJob.status, "failed");
    assert.match(failedJob.failure, /simulated commit failure/);
    const duplicateAfterFailure = await enqueueDistillationJob({
      stateRoot,
      accountId: "acct-test",
      projectId: "aide",
      conversationId: "capture-conversation",
      captures: retrySource,
      reason: "manual"
    });
    assert.equal(duplicateAfterFailure.created, false);
    assert.equal(duplicateAfterFailure.job.job_id, retryLeased.job_id);
    const retried = await retryDistillationJob(stateRoot, "acct-test", retryLeased.job_id);
    assert.equal(retried.status, "pending");
    assert.equal(retried.evidence_hash, retryLeased.evidence_hash);
    assert.equal(retried.failure, undefined);

    const bridgeRoot = join(root, "bridge");
    assert.equal(bridgeRetryDelayMs(0, 1), 5_000);
    assert.equal(bridgeRetryDelayMs(1, 1), 5_000);
    assert.equal(bridgeRetryDelayMs(2, 1), 10_000);
    assert.equal(bridgeRetryDelayMs(3, 1), 20_000);
    assert.equal(bridgeRetryDelayMs(4, 1), 40_000);
    assert.equal(bridgeRetryDelayMs(5, 1), 60_000);
    assert.equal(bridgeRetryDelayMs(10, 0.8), 48_000);
    assert.equal(bridgeRetryDelayMs(10, 1.2), 72_000);
    const queue = new MemhubBridgeQueue(bridgeRoot);
    await saveBridgeConfig(bridgeRoot, {
      captureEndpoint: "http://127.0.0.1:9/memhub/capture",
      deviceToken: createdDevice.token
    });
    await queue.enqueue({ ...captureEvent, event_id: "capture-queued-1", turn_id: "turn-2" });
    const offline = await queue.flush(await (await import("../dist/bridge.js")).loadBridgeConfig(bridgeRoot));
    assert.equal(offline.sent, 0);
    assert.equal(offline.pending, 1);
    assert.ok(offline.stopped_on_error);
    await saveBridgeConfig(bridgeRoot, {
      captureEndpoint: `http://127.0.0.1:${port}/memhub/capture`,
      deviceToken: createdDevice.token
    });
    const replay = await queue.flush(await (await import("../dist/bridge.js")).loadBridgeConfig(bridgeRoot));
    assert.equal(replay.sent, 1);
    assert.equal(replay.pending, 0);
    assert.equal(await countCaptureEvents(stateRoot), captureCountBaseline + 3);

    const raceRoot = join(root, "bridge-race");
    const raceQueue = new MemhubBridgeQueue(raceRoot);
    const raceRequests = [];
    let releaseFirstUpload;
    let markFirstUploadStarted;
    const firstUploadStarted = new Promise((resolveStarted) => { markFirstUploadStarted = resolveStarted; });
    const firstUploadRelease = new Promise((resolveRelease) => { releaseFirstUpload = resolveRelease; });
    const raceServer = createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      raceRequests.push(JSON.parse(raw));
      if (raceRequests.length === 1) {
        markFirstUploadStarted();
        await firstUploadRelease;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    const racePort = await freePort();
    await new Promise((resolveListen) => raceServer.listen(racePort, "127.0.0.1", resolveListen));
    try {
      await saveBridgeConfig(raceRoot, {
        captureEndpoint: `http://127.0.0.1:${racePort}/capture`,
        deviceToken: createdDevice.token
      });
      const raceConfig = await (await import("../dist/bridge.js")).loadBridgeConfig(raceRoot);
      const raceBase = {
        event_id: "capture-queue-race",
        host: "codex",
        conversation_id: "capture-queue-race",
        continuity_id: "capture-queue-race",
        turn_id: "turn-race",
        timestamp: "2026-09-18T08:00:00.000Z"
      };
      await raceQueue.enqueue({ ...raceBase, user_text: "user half", capture_status: "open" });
      const firstFlush = raceQueue.flush(raceConfig);
      await firstUploadStarted;
      await raceQueue.enqueue({ ...raceBase, assistant_text: "assistant half", capture_status: "open" });
      releaseFirstUpload();
      assert.deepEqual(await firstFlush, { sent: 1, pending: 1 });
      assert.deepEqual(await raceQueue.flush(raceConfig), { sent: 1, pending: 0 });
      assert.equal(raceRequests.length, 2);
      assert.equal(raceRequests[0].user_text, "user half");
      assert.equal(raceRequests[1].assistant_text, "assistant half");
    } finally {
      await new Promise((resolveClose) => raceServer.close(resolveClose));
    }

    const backoffRoot = join(root, "bridge-backoff");
    let backoffRequests = 0;
    const backoffUpstream = createServer(async (request, response) => {
      for await (const _chunk of request) { /* drain */ }
      backoffRequests += 1;
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"error":"temporary"}');
    });
    const backoffUpstreamPort = await freePort();
    await new Promise((resolveListen) => backoffUpstream.listen(backoffUpstreamPort, "127.0.0.1", resolveListen));
    const backoffBridgePort = await freePort();
    await saveBridgeConfig(backoffRoot, {
      captureEndpoint: `http://127.0.0.1:${backoffUpstreamPort}/capture`,
      deviceToken: createdDevice.token
    });
    const backoffChild = spawn(process.execPath, [bridgeEntry, "serve", "--port", String(backoffBridgePort)], {
      env: { ...process.env, MEMHUB_BRIDGE_HOME: backoffRoot },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let backoffStderr = "";
    backoffChild.stderr.setEncoding("utf8");
    backoffChild.stderr.on("data", (data) => { backoffStderr += data; });
    try {
      const readyDeadline = Date.now() + 5_000;
      while (!backoffStderr.includes("[memhub-bridge] listening") && Date.now() < readyDeadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      assert.match(backoffStderr, /\[memhub-bridge\] listening/);
      const postQueuedCapture = (eventId) => fetch(`http://127.0.0.1:${backoffBridgePort}/capture`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event_id: eventId,
          host: "codex",
          conversation_id: "bridge-backoff",
          continuity_id: "bridge-backoff",
          timestamp: "2026-09-22T06:00:00.000Z",
          user_text: eventId,
          capture_status: "complete"
        })
      });
      assert.equal((await postQueuedCapture("bridge-backoff-1")).status, 202);
      let backoffStatus;
      const failureDeadline = Date.now() + 3_000;
      while (Date.now() < failureDeadline) {
        backoffStatus = await (await fetch(`http://127.0.0.1:${backoffBridgePort}/status`)).json();
        if (backoffStatus.retry.failure_streak >= 1) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      assert.equal(backoffRequests, 1);
      assert.equal(backoffStatus.retry.failure_streak, 1);
      assert.ok(backoffStatus.retry.next_retry_at);
      const requestsBeforeSecondCapture = backoffRequests;
      assert.equal((await postQueuedCapture("bridge-backoff-2")).status, 202);
      await new Promise((resolveWait) => setTimeout(resolveWait, 400));
      assert.equal(backoffRequests, requestsBeforeSecondCapture);
      const queuedDuringBackoff = await (await fetch(`http://127.0.0.1:${backoffBridgePort}/status`)).json();
      assert.equal(queuedDuringBackoff.pending, 2);
      assert.equal(queuedDuringBackoff.retry.failure_streak, 1);
    } finally {
      backoffChild.kill("SIGTERM");
      await new Promise((resolveExit) => {
        backoffChild.once("exit", resolveExit);
        setTimeout(resolveExit, 500);
      });
      await new Promise((resolveClose) => backoffUpstream.close(resolveClose));
    }

    await saveBridgeConfig(bridgeRoot, {
      mcpEndpoint: `http://127.0.0.1:${port}/mcp`,
      captureEndpoint: `http://127.0.0.1:${port}/memhub/capture`,
      deviceToken: createdDevice.token
    });
    const bridgePort = await freePort();
    const bridgeChild = spawn(process.execPath, [bridgeEntry, "serve", "--port", String(bridgePort)], {
      env: { ...process.env, MEMHUB_BRIDGE_HOME: bridgeRoot },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let bridgeStderr = "";
    bridgeChild.stderr.setEncoding("utf8");
    bridgeChild.stderr.on("data", (data) => { bridgeStderr += data; });
    try {
      const bridgeDeadline = Date.now() + 5_000;
      while (!bridgeStderr.includes("[memhub-bridge] listening") && Date.now() < bridgeDeadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      assert.match(bridgeStderr, /\[memhub-bridge\] listening/);
      const bridgeClient = new Client({ name: "memhub-bridge-mcp-test", version: "1.0.0" });
      const bridgeTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${bridgePort}/mcp`));
      try {
        await bridgeClient.connect(bridgeTransport);
        const bridgeTools = await bridgeClient.listTools();
        assert.deepEqual(bridgeTools.tools.map((tool) => tool.name).sort(), ["memhub_branch", "memhub_distill", "memhub_result", "memhub_skill", "memhub_todo", "memmy_context", "memmy_project", "memmy_project_list", "memmy_project_manage", "memmy_turn"]);
        const bridgeContext = await bridgeClient.callTool({
          name: "memmy_context",
          arguments: { query: "continue through local bridge", project: "aide", conversation_id: "bridge-proxy-chat" }
        });
        assert.equal(bridgeContext.isError, undefined);
        assert.equal(JSON.parse(bridgeContext.content[0].text).resolvedProjectId, "aide");
        const automaticContext = await fetch(`http://127.0.0.1:${bridgePort}/context`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "continue aide", conversation_id: "bridge-proxy-chat", project: "aide", limit: 12 })
        });
        assert.equal(automaticContext.status, 200);
        const automaticContextBody = await automaticContext.json();
        assert.equal(automaticContextBody.resolvedProjectId, "aide");
        assert.equal(automaticContextBody.recallScope, "global_and_project");
      } finally {
        await bridgeClient.close();
      }
    } finally {
      bridgeChild.kill("SIGTERM");
      await new Promise((resolveExit) => {
        bridgeChild.once("exit", resolveExit);
        setTimeout(resolveExit, 500);
      });
    }

    const capturesBeforeIndexRebuild = await listCaptureEvents(stateRoot, "acct-test");
    await rm(join(stateRoot, "capture-index.sqlite"), { force: true });
    const capturesAfterIndexRebuild = await listCaptureEvents(stateRoot, "acct-test");
    assert.equal(capturesAfterIndexRebuild.length, capturesBeforeIndexRebuild.length);
    assert.deepEqual(
      capturesAfterIndexRebuild.map((item) => item.event_id).sort(),
      capturesBeforeIndexRebuild.map((item) => item.event_id).sort()
    );

    const postCapture = (event) => fetch(`http://127.0.0.1:${port}/memhub/capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createdDevice.token}`
      },
      body: JSON.stringify(event)
    });
    const dirtyRecoveryId = "capture-index-dirty-recovery";
    const dirtyInitial = await postCapture({
      event_id: dirtyRecoveryId,
      host: "codex",
      conversation_id: "dirty-recovery",
      turn_id: "dirty-recovery-turn",
      timestamp: "2026-09-18T08:01:30.000Z",
      user_text: "Persist this partial turn before a simulated crash.",
      capture_status: "open"
    });
    assert.equal(dirtyInitial.status, 201);
    const accountKey = createHash("sha256").update("acct-test", "utf8").digest("hex");
    const dirtyEventKey = createHash("sha256").update(dirtyRecoveryId, "utf8").digest("hex");
    const dirtyRawPath = join(stateRoot, "captures", accountKey, `${dirtyEventKey}.json`);
    const dirtyRaw = JSON.parse(await readFile(dirtyRawPath, "utf8"));
    dirtyRaw.assistant_text = "Complete the turn in the authoritative raw file.";
    dirtyRaw.capture_status = "complete";
    dirtyRaw.project_hint = "aide";
    await writeFile(dirtyRawPath, JSON.stringify(dirtyRaw, null, 2) + "\n");
    const captureIndexDb = new Database(join(stateRoot, "capture-index.sqlite"));
    captureIndexDb.prepare("INSERT OR REPLACE INTO capture_index_dirty(account_id,event_id) VALUES (?,?)")
      .run("acct-test", dirtyRecoveryId);
    captureIndexDb.close();
    const dirtyRecovered = (await listCaptureEvents(stateRoot, "acct-test", { conversationId: "dirty-recovery" }))[0];
    assert.equal(dirtyRecovered.capture_status, "complete");
    assert.equal(dirtyRecovered.project_hint, "aide");

    const boundCaptureId = "capture-bound-project-backfill";
    const boundCapture = await postCapture({
      event_id: boundCaptureId,
      host: "codex",
      conversation_id: "http-chat",
      turn_id: "bound-project-turn",
      timestamp: "2026-09-18T08:02:00.000Z",
      user_text: "Use the conversation binding without sending project_hint.",
      assistant_text: "The raw L1 event should persist the resolved project."
    });
    assert.equal(boundCapture.status, 201);
    const storedBoundCapture = (await listCaptureEvents(stateRoot, "acct-test")).find((item) => item.event_id === boundCaptureId);
    assert.equal(storedBoundCapture.project_hint, "aide");

    await setDistillationConfig(stateRoot, { auto_enabled: true, turn_threshold: 2, idle_minutes: 30 });
    for (let index = 1; index <= 2; index += 1) {
      const response = await postCapture({
        event_id: `capture-unscoped-auto-${index}`,
        host: "codex",
        conversation_id: "unscoped-auto",
        turn_id: `unscoped-auto-${index}`,
        timestamp: `2026-09-18T08:03:0${index}.000Z`,
        user_text: `unscoped user ${index}`,
        assistant_text: `unscoped assistant ${index}`
      });
      assert.equal(response.status, 201);
    }
    assert.equal(
      (await listDistillationJobs(stateRoot, "acct-test")).filter((job) => job.conversation_id === "unscoped-auto").length,
      0
    );

    for (let index = 1; index <= 4; index += 1) {
      const response = await postCapture({
        event_id: `capture-threshold-${index}`,
        host: "codex",
        conversation_id: "threshold-auto",
        turn_id: `threshold-auto-${index}`,
        timestamp: `2026-09-18T08:04:0${index}.000Z`,
        project_hint: "aide",
        user_text: `threshold user ${index}`,
        assistant_text: `threshold assistant ${index}`
      });
      assert.equal(response.status, 201);
    }
    const thresholdJobs = (await listDistillationJobs(stateRoot, "acct-test"))
      .filter((job) => job.conversation_id === "threshold-auto")
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
    assert.equal(thresholdJobs.length, 2);
    assert.deepEqual(thresholdJobs[0].evidence_refs.sort(), ["l1:capture-threshold-1", "l1:capture-threshold-2"]);
    assert.deepEqual(thresholdJobs[1].evidence_refs.sort(), ["l1:capture-threshold-3", "l1:capture-threshold-4"]);

    const longCapturePayload = JSON.stringify({
      event_id: "capture-long-utf8",
      host: "codex",
      conversation_id: "long-utf8",
      timestamp: "2026-09-18T08:05:00.000Z",
      project_hint: "aide",
      user_text: "界".repeat(300_000),
      reasoning_summary: "理".repeat(100_000),
      capture_status: "partial"
    });
    assert.ok(Buffer.byteLength(longCapturePayload, "utf8") > 1_000_000);
    assert.ok(Buffer.byteLength(longCapturePayload, "utf8") < 4_000_000);
    const longCaptureResponse = await fetch(`http://127.0.0.1:${port}/memhub/capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createdDevice.token}`
      },
      body: longCapturePayload
    });
    assert.equal(longCaptureResponse.status, 201);
    const longStored = (await listCaptureEvents(stateRoot, "acct-test", { conversationId: "long-utf8", limit: 2 }))[0];
    assert.equal(longStored.user_text.length, 300_000);
    assert.equal(longStored.reasoning_summary.length, 100_000);

    const oversizedCapturePayload = JSON.stringify({
      event_id: "capture-over-http-limit",
      host: "codex",
      conversation_id: "oversized-http",
      timestamp: "2026-09-18T08:06:00.000Z",
      user_text: "界".repeat(1_400_000)
    });
    assert.ok(Buffer.byteLength(oversizedCapturePayload, "utf8") > 4_000_000);
    const oversizedCaptureResponse = await fetch(`http://127.0.0.1:${port}/memhub/capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createdDevice.token}`
      },
      body: oversizedCapturePayload
    });
    assert.equal(oversizedCaptureResponse.status, 413);
    assert.equal((await oversizedCaptureResponse.json()).error, "request_body_too_large");

    const invalidJsonResponse = await fetch(`http://127.0.0.1:${port}/memhub/capture`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${createdDevice.token}`
      },
      body: '{"event_id":'
    });
    assert.equal(invalidJsonResponse.status, 400);
    assert.equal((await invalidJsonResponse.json()).error, "invalid_json_body");
    await setDistillationConfig(stateRoot, { auto_enabled: false });
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => {
      child.once("exit", resolveExit);
      setTimeout(resolveExit, 500);
    });
  }
}

function acceptIdempotent(body, operation, response) {
  if (typeof body.requestId !== "string" || !body.requestId) return true;
  const key = `${operation}:${body.adapterId ?? ""}:${body.requestId}`;
  const serialized = JSON.stringify(body);
  const previous = idempotency.get(key);
  if (previous !== undefined && previous !== serialized) {
    response.statusCode = 409;
    response.end(JSON.stringify({ error: "idempotency conflict" }));
    return false;
  }
  idempotency.set(key, serialized);
  return true;
}

async function exerciseClient(client, conversationId, stateRoot) {
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["memhub_branch", "memhub_distill", "memhub_result", "memhub_skill", "memhub_todo", "memmy_context", "memmy_project", "memmy_project_list", "memmy_project_manage", "memmy_turn"]);
  assert.match(listed.tools.find((tool) => tool.name === "memmy_context")?.description ?? "", /conversation_id.*不要伪造|不要伪造.*conversation_id/);
  assert.match(listed.tools.find((tool) => tool.name === "memhub_branch")?.description ?? "", /不新增 L1\/L2\/L3\/L4/);
  assert.match(listed.tools.find((tool) => tool.name === "memhub_result")?.description ?? "", /result_id.*next_offset|next_offset.*result_id/);
  assert.match(listed.tools.find((tool) => tool.name === "memmy_project")?.description ?? "", /action=current.*没有 conversation_id 时不会报错/);
  assert.match(listed.tools.find((tool) => tool.name === "memmy_project_list")?.description ?? "", /description.*禁止盲目新建/);
  assert.match(listed.tools.find((tool) => tool.name === "memmy_project_manage")?.description ?? "", /action=plan.*明确授权.*action=execute/);
  assert.match(listed.tools.find((tool) => tool.name === "memhub_todo")?.description ?? "", /Project Registry.*唯一事实源|唯一事实源.*Project Registry/);
  let projectList = JSON.parse((await client.callTool({ name: "memmy_project_list", arguments: { query: "AIDE" } })).content[0].text);
  if (!projectList.projects.some((project) => project.project === "aide")) {
    const createPlan = JSON.parse((await client.callTool({
      name: "memmy_project_manage",
      arguments: {
        action: "plan",
        operation: "create",
        project: "aide",
        description: "AIDE project used by MCP integration tests."
      }
    })).content[0].text);
    assert.equal(createPlan.status, "awaiting_user_authorization");
    const createResult = JSON.parse((await client.callTool({
      name: "memmy_project_manage",
      arguments: { action: "execute", authorization_id: createPlan.authorization_id }
    })).content[0].text);
    assert.equal(createResult.ok, true);
    projectList = JSON.parse((await client.callTool({ name: "memmy_project_list", arguments: { query: "AIDE" } })).content[0].text);
  }
  assert.ok(projectList.projects.some((project) => project.project === "aide"));
  assert.equal(projectList.matches[0]?.project, "aide");
  let workspaceProjectList = JSON.parse((await client.callTool({ name: "memmy_project_list", arguments: { query: "memhub" } })).content[0].text);
  if (!workspaceProjectList.projects.some((project) => project.project === "memhub")) {
    const createWorkspacePlan = JSON.parse((await client.callTool({
      name: "memmy_project_manage",
      arguments: {
        action: "plan",
        operation: "create",
        project: "memhub",
        description: "Memhub project used to verify current-workspace scope precedence."
      }
    })).content[0].text);
    const createWorkspaceResult = JSON.parse((await client.callTool({
      name: "memmy_project_manage",
      arguments: { action: "execute", authorization_id: createWorkspacePlan.authorization_id }
    })).content[0].text);
    assert.equal(createWorkspaceResult.ok, true);
    workspaceProjectList = JSON.parse((await client.callTool({ name: "memmy_project_list", arguments: { query: "memhub" } })).content[0].text);
  }
  assert.ok(workspaceProjectList.projects.some((project) => project.project === "memhub"));
  const branchConversation = `${conversationId}-branches`;
  const retrievalBranch = JSON.parse((await client.callTool({
    name: "memhub_branch",
    arguments: { action: "create", project: "aide", name: "Retrieval", goal: "Improve semantic BM25 retrieval precision." }
  })).content[0].text).branch;
  const webBranch = JSON.parse((await client.callTool({
    name: "memhub_branch",
    arguments: { action: "create", project: "aide", name: "Web", goal: "Finish the Control Plane web interface." }
  })).content[0].text).branch;
  await client.callTool({
    name: "memhub_branch",
    arguments: { action: "create", project: "aide", name: "Network", goal: "Diagnose Cloudflare transport stability." }
  });
  const branchList = JSON.parse((await client.callTool({
    name: "memhub_branch",
    arguments: { action: "list", project: "aide" }
  })).content[0].text);
  assert.equal(branchList.branches.length, 3);
  await client.callTool({
    name: "memhub_branch",
    arguments: { action: "switch", project: "aide", conversation_id: branchConversation, branch: retrievalBranch.branchId }
  });
  const retrievalTurn = JSON.parse((await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "open",
      conversation_id: branchConversation,
      continuity_id: branchConversation,
      project: "aide",
      user_text: "Tune semantic BM25 retrieval precision for the Retrieval branch."
    }
  })).content[0].text);
  await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "commit",
      event_id: retrievalTurn.turn.event_id,
      conversation_id: branchConversation,
      continuity_id: branchConversation,
      assistant_text: "Retrieval ranking work completed for this branch checkpoint."
    }
  });
  let branchContext = JSON.parse((await client.callTool({
    name: "memmy_context",
    arguments: { query: "继续", project: "aide", conversation_id: branchConversation, continuity_id: branchConversation }
  })).content[0].text);
  assert.equal(branchContext.branchContext.branchId, retrievalBranch.branchId);
  assert.equal(branchContext.branchContext.source, "conversation_binding");
  assert.ok(branchContext.recentSession.some((item) => /BM25 retrieval/.test(item.content)));
  branchContext = JSON.parse((await client.callTool({
    name: "memmy_context",
    arguments: { query: "继续", project: "aide", conversation_id: branchConversation, branch: webBranch.branchId }
  })).content[0].text);
  assert.equal(branchContext.branchContext.branchId, webBranch.branchId);
  assert.equal(branchContext.branchContext.source, "explicit");
  const webTurn = JSON.parse((await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "open",
      conversation_id: branchConversation,
      continuity_id: branchConversation,
      project: "aide",
      user_text: "Finish the Control Plane web interface for the Web branch."
    }
  })).content[0].text);
  await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "commit",
      event_id: webTurn.turn.event_id,
      conversation_id: branchConversation,
      continuity_id: branchConversation,
      assistant_text: "Web interface work completed for this branch checkpoint."
    }
  });
  const webScopedContext = JSON.parse((await client.callTool({
    name: "memmy_context",
    arguments: {
      query: "继续",
      project: "aide",
      conversation_id: branchConversation,
      continuity_id: branchConversation
    }
  })).content[0].text);
  assert.equal(webScopedContext.branchContext.branchId, webBranch.branchId);
  assert.ok(webScopedContext.recentSession.some((item) => /Control Plane web interface/.test(item.content)));
  assert.ok(webScopedContext.recentSession.every((item) => !/BM25 retrieval/.test(item.content)));
  const branchCurrent = JSON.parse((await client.callTool({
    name: "memhub_branch",
    arguments: { action: "current", project: "aide", conversation_id: branchConversation }
  })).content[0].text);
  assert.equal(branchCurrent.branch.branchId, webBranch.branchId);
  await client.callTool({
    name: "memhub_branch",
    arguments: { action: "close", project: "aide", branch: webBranch.branchId }
  });
  const branchAfterClose = JSON.parse((await client.callTool({
    name: "memhub_branch",
    arguments: { action: "current", project: "aide", conversation_id: branchConversation }
  })).content[0].text);
  assert.equal(branchAfterClose.branch, null);
  const branchListWithClosed = JSON.parse((await client.callTool({
    name: "memhub_branch",
    arguments: { action: "list", project: "aide", include_closed: true }
  })).content[0].text);
  assert.ok(branchListWithClosed.branches.length >= 3);
  assert.equal(branchListWithClosed.branches.find((branch) => branch.branchId === webBranch.branchId).status, "closed");
  const baselineTodos = JSON.parse((await client.callTool({
    name: "memhub_todo",
    arguments: { action: "list", project: "aide", status: "all" }
  })).content[0].text);
  assert.equal(baselineTodos.project, "aide");
  const baselinePendingCount = baselineTodos.pending_count;
  const baselineTotalCount = baselineTodos.total;
  const addedTodo = JSON.parse((await client.callTool({
    name: "memhub_todo",
    arguments: { action: "add", project: "AIDE", text: "Verify the dedicated MCP todo lifecycle." }
  })).content[0].text);
  assert.equal(addedTodo.ok, true);
  assert.equal(addedTodo.project, "aide");
  assert.equal(addedTodo.todo.status, "pending");
  assert.equal(addedTodo.pending_count, baselinePendingCount + 1);
  const contextWithRelevantTodo = JSON.parse((await client.callTool({
    name: "memmy_context",
    arguments: { query: "dedicated MCP todo lifecycle", project: "AIDE" }
  })).content[0].text);
  const aideCandidateWithTodo = contextWithRelevantTodo.projectCandidates.find((project) => project.project === "aide");
  assert.ok(aideCandidateWithTodo);
  assert.equal(aideCandidateWithTodo.relevantTodos[0].id, addedTodo.todo.id);
  assert.equal(aideCandidateWithTodo.relevantTodos.length, 1);
  assert.deepEqual(aideCandidateWithTodo.relevantTodos[0].matchedTerms, ["dedicated", "mcp", "todo", "lifecycle"]);
  const pendingTodos = JSON.parse((await client.callTool({
    name: "memhub_todo",
    arguments: { action: "list", project: "aide" }
  })).content[0].text);
  assert.equal(pendingTodos.pending_count, baselinePendingCount + 1);
  assert.ok(pendingTodos.todos.some((todo) => todo.id === addedTodo.todo.id));
  const allTodosAfterAdd = JSON.parse((await client.callTool({
    name: "memhub_todo",
    arguments: { action: "list", project: "aide", status: "all" }
  })).content[0].text);
  assert.equal(allTodosAfterAdd.total, baselineTotalCount + 1);
  const completedTodo = JSON.parse((await client.callTool({
    name: "memhub_todo",
    arguments: { action: "complete", project: "aide", todo_id: addedTodo.todo.id }
  })).content[0].text);
  assert.equal(completedTodo.todo.status, "done");
  assert.ok(completedTodo.todo.completedAt);
  assert.equal(completedTodo.pending_count, baselinePendingCount);
  const reopenedTodo = JSON.parse((await client.callTool({
    name: "memhub_todo",
    arguments: { action: "reopen", project: "aide", todo_id: addedTodo.todo.id }
  })).content[0].text);
  assert.equal(reopenedTodo.todo.status, "pending");
  assert.equal(reopenedTodo.todo.completedAt, undefined);
  assert.equal(reopenedTodo.pending_count, baselinePendingCount + 1);
  const accountTodos = JSON.parse((await client.callTool({
    name: "memhub_todo",
    arguments: { action: "list" }
  })).content[0].text);
  assert.equal(accountTodos.scope, "account");
  assert.ok(accountTodos.projects.some((project) => project.project === "aide" && project.todos.some((todo) => todo.id === addedTodo.todo.id)));
  const projectListWithTodo = JSON.parse((await client.callTool({ name: "memmy_project_list", arguments: { query: "AIDE" } })).content[0].text);
  assert.equal(projectListWithTodo.projects.find((project) => project.project === "aide")?.pendingTodoCount, baselinePendingCount + 1);
  const currentWithoutConversation = JSON.parse((await client.callTool({
    name: "memmy_project",
    arguments: { action: "current" }
  })).content[0].text);
  assert.equal(currentWithoutConversation.project, null);
  assert.equal(currentWithoutConversation.binding_available, false);
  assert.equal(currentWithoutConversation.resolution_source, "conversation_id_unavailable");
  const currentExplicitWithoutConversation = JSON.parse((await client.callTool({
    name: "memmy_project",
    arguments: { action: "current", project: "AIDE" }
  })).content[0].text);
  assert.equal(currentExplicitWithoutConversation.project, "aide");
  assert.equal(currentExplicitWithoutConversation.binding_available, false);
  assert.equal(currentExplicitWithoutConversation.resolution_source, "explicit_project");
  assert.equal(currentExplicitWithoutConversation.persisted, false);
  const currentWorkspaceWithoutConversation = JSON.parse((await client.callTool({
    name: "memmy_project",
    arguments: { action: "current", workspace_project: "AIDE" }
  })).content[0].text);
  assert.equal(currentWorkspaceWithoutConversation.project, "aide");
  assert.equal(currentWorkspaceWithoutConversation.resolution_source, "workspace_project");
  const workspacePriorityConversation = `${conversationId}-workspace-priority`;
  await client.callTool({
    name: "memmy_project",
    arguments: { action: "bind", conversation_id: workspacePriorityConversation, project: "aide" }
  });
  const workspacePriority = JSON.parse((await client.callTool({
    name: "memmy_project",
    arguments: { action: "current", conversation_id: workspacePriorityConversation, workspace_project: "memhub" }
  })).content[0].text);
  assert.equal(workspacePriority.project, "memhub");
  assert.equal(workspacePriority.resolution_source, "workspace_project");
  assert.equal(workspacePriority.persisted, false);
  const conflictingTodoScope = await client.callTool({
    name: "memhub_todo",
    arguments: {
      action: "add",
      project: "aide",
      workspace_project: "memhub",
      text: "This conflicting scope must never be written."
    }
  });
  assert.equal(conflictingTodoScope.isError, true);
  assert.match(conflictingTodoScope.content[0].text, /project\/workspace conflict/);
  const unresolved = JSON.parse((await client.callTool({
    name: "memmy_context",
    arguments: { query: "continue the AIDEE work", project: "aidee", conversation_id: conversationId + "-unknown" }
  })).content[0].text);
  assert.equal(unresolved.resolvedProjectId, null);
  assert.equal(unresolved.recallScope, "global_only");
  assert.ok(unresolved.projectCandidates.some((project) => project.project === "aide"));
  assert.ok(unresolved.projectCandidates.every((project) => project.relevantTodos === undefined));
  const updatePlanResult = await client.callTool({
    name: "memmy_project_manage",
    arguments: {
      action: "plan",
      operation: "update",
      project: "aide",
      description: "AIDE project used by MCP integration tests."
    }
  });
  const updatePlan = JSON.parse(updatePlanResult.content[0].text);
  assert.equal(updatePlan.status, "awaiting_user_authorization");
  const updateResult = await client.callTool({
    name: "memmy_project_manage",
    arguments: { action: "execute", authorization_id: updatePlan.authorization_id }
  });
  assert.equal(JSON.parse(updateResult.content[0].text).ok, true);
  const replayedAuthorization = await client.callTool({
    name: "memmy_project_manage",
    arguments: { action: "execute", authorization_id: updatePlan.authorization_id }
  });
  assert.match(replayedAuthorization.content[0].text, /invalid or already-used project authorization/);
  const updatedList = JSON.parse((await client.callTool({ name: "memmy_project_list", arguments: { query: "aide" } })).content[0].text);
  assert.match(updatedList.projects.find((project) => project.project === "aide")?.description ?? "", /integration tests/);
  const mergeTarget = `merge-target-${conversationId}`;
  const mergeSource = `merge-source-${conversationId}`;
  const deleteProject = `delete-${conversationId}`;
  for (const project of [mergeTarget, mergeSource, deleteProject]) {
    const plan = JSON.parse((await client.callTool({
      name: "memmy_project_manage",
      arguments: {
        action: "plan",
        operation: "create",
        project,
        description: `Temporary MCP project-management test project ${project}.`
      }
    })).content[0].text);
    assert.equal(JSON.parse((await client.callTool({
      name: "memmy_project_manage",
      arguments: { action: "execute", authorization_id: plan.authorization_id }
    })).content[0].text).ok, true);
  }
  const mergeHarness = `merge-job-${conversationId}`;
  const mergeJob = await enqueueDerivedDistillationJob({
    stateRoot,
    accountId: "acct-test",
    target: "l3",
    projectId: mergeSource,
    evidence: [{
      ref: `artifact:merge-source-${conversationId}`,
      kind: "artifact",
      timestamp: "2026-09-22T00:00:00.000Z",
      project_id: mergeSource,
      layer: "L2",
      content: "Historical L2 evidence that must remain valid after project merge."
    }]
  });
  const leasedMergeJob = await leaseDistillationJob(stateRoot, "acct-test", {
    projectId: mergeSource,
    target: "l3",
    harness: mergeHarness
  });
  assert.equal(leasedMergeJob?.job_id, mergeJob.job.job_id);
  const mergePlan = JSON.parse((await client.callTool({
    name: "memmy_project_manage",
    arguments: { action: "plan", operation: "merge", project: mergeSource, target: mergeTarget }
  })).content[0].text);
  assert.equal(JSON.parse((await client.callTool({
    name: "memmy_project_manage",
    arguments: { action: "execute", authorization_id: mergePlan.authorization_id }
  })).content[0].text).ok, true);
  const mergedJobDryRun = await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: mergeJob.job.job_id,
      source_harness: mergeHarness,
      content: "Merged projects keep historical evidence valid under the target canonical project.",
      dry_run: true
    }
  });
  assert.equal(mergedJobDryRun.isError, undefined);
  assert.equal(JSON.parse(mergedJobDryRun.content[0].text).project, mergeTarget);
  assert.equal(JSON.parse((await client.callTool({
    name: "memhub_distill",
    arguments: { action: "skip", job_id: mergeJob.job.job_id, source_harness: mergeHarness }
  })).content[0].text).ok, true);

  const deleteJob = await enqueueDerivedDistillationJob({
    stateRoot,
    accountId: "acct-test",
    target: "l3",
    projectId: deleteProject,
    evidence: [{
      ref: `artifact:delete-blocker-${conversationId}`,
      kind: "artifact",
      timestamp: "2026-09-22T00:00:00.000Z",
      project_id: deleteProject,
      layer: "L2",
      content: "Pending evidence blocks project deletion until the job is resolved."
    }]
  });
  const deletePlan = JSON.parse((await client.callTool({
    name: "memmy_project_manage",
    arguments: { action: "plan", operation: "delete", project: deleteProject }
  })).content[0].text);
  assert.ok(deletePlan.impact.blockedByDistillationJobs.some((job) => job.job_id === deleteJob.job.job_id));
  const blockedDelete = await client.callTool({
    name: "memmy_project_manage",
    arguments: { action: "execute", authorization_id: deletePlan.authorization_id }
  });
  assert.equal(blockedDelete.isError, true);
  assert.match(blockedDelete.content[0].text, /unfinished distillation job/);
  const deleteHarness = `delete-job-${conversationId}`;
  const leasedDelete = JSON.parse((await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "next",
      kind: "l3",
      scope: "project",
      project: deleteProject,
      source_harness: deleteHarness
    }
  })).content[0].text);
  assert.equal(leasedDelete.job.job_id, deleteJob.job.job_id);
  assert.equal(JSON.parse((await client.callTool({
    name: "memhub_distill",
    arguments: { action: "skip", job_id: deleteJob.job.job_id, source_harness: deleteHarness }
  })).content[0].text).ok, true);
  const deletePlanAfterResolution = JSON.parse((await client.callTool({
    name: "memmy_project_manage",
    arguments: { action: "plan", operation: "delete", project: deleteProject }
  })).content[0].text);
  assert.equal(deletePlanAfterResolution.impact.blockedByDistillationJobs.length, 0);
  assert.equal(JSON.parse((await client.callTool({
    name: "memmy_project_manage",
    arguments: { action: "execute", authorization_id: deletePlanAfterResolution.authorization_id }
  })).content[0].text).ok, true);
  const historicalProjects = JSON.parse((await client.callTool({
    name: "memmy_project_list",
    arguments: { include_inactive: true }
  })).content[0].text).projects;
  assert.equal(historicalProjects.find((project) => project.project === mergeSource)?.state, "merged");
  assert.equal(historicalProjects.find((project) => project.project === mergeSource)?.mergedInto, mergeTarget);
  assert.equal(historicalProjects.find((project) => project.project === deleteProject)?.state, "deleted");
  await client.callTool({ name: "memmy_project", arguments: { action: "bind", conversation_id: conversationId, project: "aide" } });
  const context = await client.callTool({ name: "memmy_context", arguments: { query: "continue", conversation_id: conversationId } });
  const capsule = JSON.parse(context.content[0].text);
  assert.equal(capsule.resolvedProjectId, "aide");
  assert.equal(capsule.globalMemory.length, 1);
  assert.equal(capsule.projectMemory.length, 1);
  if (conversationId === "stdio-chat") {
    assert.ok(capsule.projectArchitecture.some((item) => /AIDE Core Architecture/.test(item.content)));
    const architecture = JSON.parse((await client.callTool({
      name: "memmy_project",
      arguments: { action: "architecture", project: "aide", query: "broker workspace ownership" }
    })).content[0].text);
    assert.equal(architecture.project, "aide");
    assert.ok(architecture.architecture.some((item) => /Broker routes work/.test(item.content)));
  }
  const openedTurn = JSON.parse((await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "open",
      conversation_id: conversationId,
      continuity_id: conversationId,
      turn_id: `source-${conversationId}`,
      user_text: "Keep this original user message in L1."
    }
  })).content[0].text);
  assert.equal(openedTurn.turn.status, "open");
  assert.equal(openedTurn.turn.project_hint, "aide");
  const l1EventId = openedTurn.turn.event_id;
  await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "checkpoint",
      event_id: l1EventId,
      conversation_id: conversationId,
      continuity_id: conversationId,
      turn_id: `source-${conversationId}`,
      reasoning_summary: "Validated the project binding and memory boundary."
    }
  });
  await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "checkpoint",
      event_id: l1EventId,
      conversation_id: conversationId,
      continuity_id: conversationId,
      turn_id: `source-${conversationId}`,
      reasoning_summary: "Validated the project binding, memory boundary, and lifecycle update semantics.",
      tool_summary: "Checkpoint summaries may advance while the L1 turn is incomplete."
    }
  });
  const committedTurn = JSON.parse((await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "commit",
      event_id: l1EventId,
      conversation_id: conversationId,
      continuity_id: conversationId,
      turn_id: `source-${conversationId}`,
      assistant_text: "Keep this original assistant final in L1.",
      reasoning_summary: "Final public audit summary for this completed turn.",
      tool_summary: "Final tool summary for this completed turn."
    }
  })).content[0].text);
  assert.equal(committedTurn.turn.status, "complete");
  const resumed = JSON.parse((await client.callTool({
    name: "memmy_turn",
    arguments: { action: "resume", conversation_id: conversationId, continuity_id: conversationId }
  })).content[0].text);
  assert.equal(resumed.turns.at(-1).event_id, l1EventId);
  assert.equal(resumed.turns.at(-1).reasoning_summary, "Final public audit summary for this completed turn.");
  assert.equal(resumed.turns.at(-1).tool_summary, "Final tool summary for this completed turn.");
  assert.equal(resumed.incomplete.length, 0);

  const largeResultConversation = `${conversationId}-generic-large-result`;
  const largeResultOpen = JSON.parse((await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "open",
      conversation_id: largeResultConversation,
      project: "aide",
      user_text: "Verify generic MCP result chunk transport."
    }
  })).content[0].text);
  const largeAssistantText = "大".repeat(130_000);
  let largeResultChunk = JSON.parse((await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "commit",
      event_id: largeResultOpen.turn.event_id,
      conversation_id: largeResultConversation,
      assistant_text: largeAssistantText
    }
  })).content[0].text);
  assert.equal(largeResultChunk.result_transport.mode, "chunked");
  let largeResultJson = largeResultChunk.result_chunk;
  while (largeResultChunk.result_transport.next_offset !== null) {
    largeResultChunk = JSON.parse((await client.callTool({
      name: "memhub_result",
      arguments: {
        result_id: largeResultChunk.result_transport.result_id,
        offset: largeResultChunk.result_transport.next_offset,
        chunk_chars: 100_000
      }
    })).content[0].text);
    largeResultJson += largeResultChunk.result_chunk;
  }
  const reconstructedLargeResult = JSON.parse(largeResultJson);
  assert.equal(reconstructedLargeResult.turn.assistant_text, largeAssistantText);
  assert.equal(reconstructedLargeResult.turn.status, "complete");

  const unboundOpen = JSON.parse((await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "open",
      project: "aide",
      user_text: "Capture this turn even when the transport exposes no conversation id."
    }
  })).content[0].text);
  assert.equal(unboundOpen.binding_available, false);
  assert.equal(unboundOpen.transport_conversation_id, null);
  assert.match(unboundOpen.turn.conversation_id, /^memhub-unbound:l1_/);
  assert.equal(unboundOpen.turn.project_hint, "aide");
  const unboundEventId = unboundOpen.turn.event_id;
  const unboundCommit = JSON.parse((await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "commit",
      event_id: unboundEventId,
      assistant_text: "The unbound transport turn still reaches complete L1 safely."
    }
  })).content[0].text);
  assert.equal(unboundCommit.binding_available, false);
  assert.equal(unboundCommit.turn.event_id, unboundEventId);
  assert.equal(unboundCommit.turn.status, "complete");
  assert.equal(unboundCommit.turn.ingested, true);
  assert.equal(unboundCommit.project_id, "aide");
  const colonEventId = `codex:${conversationId}:colon-turn`;
  await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "open",
      event_id: colonEventId,
      conversation_id: conversationId,
      continuity_id: conversationId,
      project: "aide",
      user_text: "Verify L1 evidence ids containing colons remain intact."
    }
  });
  await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "commit",
      event_id: colonEventId,
      conversation_id: conversationId,
      continuity_id: conversationId,
      assistant_text: "Colon-bearing L1 evidence remains resolvable."
    }
  });
  const colonEvidenceDryRun = await client.callTool({
    name: "memhub_distill",
    arguments: {
      kind: "l2",
      scope: "project",
      project: "aide",
      content: "Colon-bearing L1 evidence is accepted without truncating its event id.",
      evidence_refs: [`l1:${colonEventId}`],
      dry_run: true
    }
  });
  assert.equal(JSON.parse(colonEvidenceDryRun.content[0].text).dryRun, true);
  const syntheticBinding = JSON.parse((await client.callTool({
    name: "memmy_project",
    arguments: { action: "current", conversation_id: unboundCommit.turn.conversation_id }
  })).content[0].text);
  assert.equal(syntheticBinding.project, null);
  const invalidResume = await client.callTool({ name: "memmy_turn", arguments: { action: "resume" } });
  assert.equal(invalidResume.isError, true);
  assert.match(invalidResume.content[0].text, /resume requires continuity_id or conversation_id/);

  const continuityContext = JSON.parse((await client.callTool({
    name: "memmy_context",
    arguments: { query: "continue", conversation_id: conversationId, continuity_id: conversationId }
  })).content[0].text);
  assert.ok(continuityContext.recentSession.some((item) => item.id === l1EventId));

  const contractResult = await client.callTool({
    name: "memhub_distill",
    arguments: { inspect_contract: true }
  });
  const contractPayload = JSON.parse(contractResult.content[0].text);
  assert.equal(contractPayload.contract.version, "memhub-distill-v2");
  assert.equal(contractPayload.contract.executor, "connected_mcp_or_harness_model");

  const golden = await exerciseGoldenDistillationChain(client, stateRoot, conversationId, l1EventId);
  const writesBeforeDryRun = requests.filter((entry) => entry.url === "/api/v1/memory/add").length;
  const dryRun = await client.callTool({
    name: "memhub_distill",
    arguments: {
      kind: "l4",
      scope: "account",
      content: "Durable cross-project evidence-backed user profile candidate.",
      evidence_refs: [`l3:${golden.aideL3Id}`, `l3:${golden.betaL3Id}`],
      dry_run: true
    }
  });
  assert.equal(JSON.parse(dryRun.content[0].text).dryRun, true);
  assert.equal(requests.filter((entry) => entry.url === "/api/v1/memory/add").length, writesBeforeDryRun);

  const invalidDryRun = await client.callTool({
    name: "memhub_distill",
    arguments: {
      kind: "l3",
      scope: "project",
      project: "aide",
      content: "This must not validate against invented evidence.",
      evidence_refs: ["l2:not-a-real-memory"],
      dry_run: true
    }
  });
  assert.equal(invalidDryRun.isError, true);
  assert.match(invalidDryRun.content[0].text, /404|not_found|evidence/i);

  const otherAccountEvidenceId = `other-account-l2-${conversationId}`;
  memoryById.set(otherAccountEvidenceId, {
    id: otherAccountEvidenceId,
    memoryLayer: "L2",
    status: "activated",
    title: "Other account timeline",
    summary: "Must never be accepted as current-account evidence.",
    body: "Must never be accepted as current-account evidence.",
    tags: ["artifact:l2", "project:aide"],
    namespace: { tenantId: "acct-other", userId: "acct_other_user", projectId: "aide" },
    version: 1
  });
  const crossAccountEvidence = await client.callTool({
    name: "memhub_distill",
    arguments: {
      kind: "l3",
      scope: "project",
      project: "aide",
      content: "This must not validate against another account's L2.",
      evidence_refs: [`l2:${otherAccountEvidenceId}`],
      dry_run: true
    }
  });
  assert.equal(crossAccountEvidence.isError, true);
  assert.match(crossAccountEvidence.content[0].text, /current account scope/i);

  const reconnectArtifactId = `aide-reconnect-${conversationId}`;
  await client.callTool({
    name: "memhub_distill",
    arguments: {
      kind: "skill",
      scope: "project",
      conversation_id: conversationId,
      title: "AIDE reconnect workflow",
      content: "Use this when AIDE reconnect fails. Inspect state, repair the bridge, then verify reconnection.",
      source_harness: "codex",
      artifact_id: reconnectArtifactId,
      version: "1",
      evidence_refs: ["l1:test-turn"],
      source_conversations: [conversationId],
      confidence: 0.9
    }
  });
  const skillWrite = [...requests].reverse().find((entry) => entry.url === "/api/v1/memory/add");
  assert.equal(skillWrite.body.layer, "Skill");
  assert.equal(skillWrite.body.namespace.projectId, "aide");
  assert.equal(skillWrite.body.namespace.tenantId, "acct-test");
  assert.equal(skillWrite.body.sourceAgentId, "codex");
  assert.equal(skillWrite.body.sourceSkillId, reconnectArtifactId);
  assert.equal(skillWrite.body.sourceSkillVersion, "1");
  assert.ok(skillWrite.body.tags.includes("artifact:skill"));
  assert.ok(skillWrite.body.tags.includes("project:aide"));
  assert.ok(skillWrite.body.tags.includes("distill-contract:memhub-distill-v2"));
  assert.ok(skillWrite.body.tags.includes("evidence:l1:test-turn"));
  assert.ok(skillWrite.body.tags.includes(`source-conversation:${conversationId}`));
  assert.equal(typeof skillWrite.body.requestId, "string");

  const skillRecord = [...memoryById.values()].find((item) => item.memoryLayer === "Skill" &&
    item.title === "AIDE reconnect workflow" &&
    item.metadata?.properties?.internal_info?.source_skill_id === reconnectArtifactId);
  assert.ok(skillRecord);
  const loadedSkill = JSON.parse((await client.callTool({
    name: "memhub_skill",
    arguments: { action: "load", skill_id: skillRecord.id, executor: "codex" }
  })).content[0].text);
  assert.equal(loadedSkill.skill_id, skillRecord.id);
  assert.equal(typeof loadedSkill.execution_id, "string");
  assert.match(loadedSkill.content, /repair the bridge/);
  assert.equal(loadedSkill.metadata.loadRequired, true);
  assert.equal(loadedSkill.metadata.scope, "project:aide");

  const invokedSkill = JSON.parse((await client.callTool({
    name: "memhub_skill",
    arguments: {
      action: "record",
      skill_id: skillRecord.id,
      execution_id: loadedSkill.execution_id,
      stage: "invoked",
      executor: "codex"
    }
  })).content[0].text);
  assert.equal(invokedSkill.event.stage, "invoked");
  const completedSkill = JSON.parse((await client.callTool({
    name: "memhub_skill",
    arguments: {
      action: "record",
      skill_id: skillRecord.id,
      execution_id: loadedSkill.execution_id,
      stage: "success",
      note: "reconnected and verified"
    }
  })).content[0].text);
  assert.equal(completedSkill.summary.successes, 1);
  assert.ok(completedSkill.summary.reliability > 0.5);
  const skillStatus = JSON.parse((await client.callTool({
    name: "memhub_skill",
    arguments: { action: "status", skill_id: skillRecord.id, execution_id: loadedSkill.execution_id }
  })).content[0].text);
  assert.deepEqual(skillStatus.execution.map((event) => event.stage), ["selected", "loaded", "invoked", "success"]);

  const unchangedVersion = await client.callTool({
    name: "memhub_skill",
    arguments: {
      action: "plan", operation: "revise", skill_id: skillRecord.id,
      version: "1", content: "# Same version\n\nImproved procedure", note: "invalid version"
    }
  });
  assert.equal(unchangedVersion.isError, true, "Skill revisions must advance their source version");
  const foreignSkillId = `foreign-${conversationId}`;
  memoryById.set(foreignSkillId, {
    ...skillRecord, id: foreignSkillId,
    namespace: { ...skillRecord.namespace, tenantId: "another-account" },
    tags: skillRecord.tags.map((tag) => tag.startsWith("provenance:account:") ? "provenance:account:another-account" : tag)
  });
  const foreignLoad = await client.callTool({ name: "memhub_skill", arguments: { action: "load", skill_id: foreignSkillId } });
  assert.equal(foreignLoad.isError, true, "cross-account Skill must not be loaded");
  memoryById.delete(foreignSkillId);

  const revisionContent = `# AIDE reconnect workflow\n\n## When to use\nWhen AIDE reconnect fails.\n\n## Procedure\nRead the current project state, repair the bridge, and verify reconnection with a real MCP round trip. Never infer success from a local build alone.`;
  const plan = JSON.parse((await client.callTool({
    name: "memhub_skill",
    arguments: {
      action: "plan", operation: "revise", skill_id: skillRecord.id,
      version: "2.0.0", content: revisionContent, title: "AIDE reconnect workflow",
      tags: ["reconnect", "reusable"], note: "replace stale reconnect checks"
    }
  })).content[0].text);
  assert.equal(plan.status, "awaiting_user_authorization");
  assert.equal(plan.source_skill_id, reconnectArtifactId);
  assert.equal(plan.next_version, "2.0.0");
  assert.equal(skillRecord.status, "activated", "planning must not mutate existing Skill");
  const revised = JSON.parse((await client.callTool({
    name: "memhub_skill",
    arguments: { action: "execute", skill_id: skillRecord.id, authorization_id: plan.authorization_id }
  })).content[0].text);
  assert.equal(revised.ok, true);
  assert.notEqual(revised.skill_id, skillRecord.id);
  assert.equal(revised.source_skill_id, reconnectArtifactId, "stable source identity must survive version changes");
  assert.equal(skillRecord.status, "archived");
  const revisedWrite = [...requests].reverse().find((entry) => entry.url === "/api/v1/memory/add");
  assert.equal(revisedWrite.body.sourceSkillId, reconnectArtifactId);
  assert.equal(revisedWrite.body.sourceSkillVersion, "2.0.0");
  assert.ok(revisedWrite.body.tags.includes(`revision-of:${skillRecord.id}`));
  assert.equal(revisedWrite.body.namespace.projectId, "aide");
  const oldLoad = await client.callTool({ name: "memhub_skill", arguments: { action: "load", skill_id: skillRecord.id } });
  assert.equal(oldLoad.isError, true, "superseded Skill cannot start another execution");
  assert.match(oldLoad.content[0].text, /archived or inactive/);
  const oldStatus = JSON.parse((await client.callTool({ name: "memhub_skill", arguments: { action: "status", skill_id: skillRecord.id } })).content[0].text);
  assert.equal(oldStatus.status, "archived");
  assert.equal(oldStatus.summary.successes, 1, "prior execution telemetry must remain accessible");
  const replay = await client.callTool({
    name: "memhub_skill",
    arguments: { action: "execute", skill_id: skillRecord.id, authorization_id: plan.authorization_id }
  });
  assert.equal(replay.isError, true, "governance authorization must be single-use");
  const newerCall = await client.callTool({ name: "memhub_skill", arguments: { action: "load", skill_id: revised.skill_id } });
  assert.equal(newerCall.isError, undefined, JSON.stringify({ revised, newRecordStatus: memoryById.get(revised.skill_id)?.status, oldRecordStatus: memoryById.get(skillRecord.id)?.status, newerCall }));
  const newer = JSON.parse(newerCall.content[0].text);
  assert.match(newer.content, /real MCP round trip/);
  await client.callTool({ name: "memhub_skill", arguments: { action: "record", skill_id: revised.skill_id, execution_id: newer.execution_id, stage: "invoked" } });
  const failed = JSON.parse((await client.callTool({ name: "memhub_skill", arguments: { action: "record", skill_id: revised.skill_id, execution_id: newer.execution_id, stage: "failure", note: "connection timeout" } })).content[0].text);
  assert.equal(failed.summary.failures, 1);
  const corrected = JSON.parse((await client.callTool({ name: "memhub_skill", arguments: { action: "record", skill_id: revised.skill_id, execution_id: newer.execution_id, stage: "user_correction", note: "use a bounded retry" } })).content[0].text);
  assert.equal(corrected.summary.user_corrections, 1);
  const retry = JSON.parse((await client.callTool({ name: "memhub_skill", arguments: { action: "load", skill_id: revised.skill_id } })).content[0].text);
  await client.callTool({ name: "memhub_skill", arguments: { action: "record", skill_id: revised.skill_id, execution_id: retry.execution_id, stage: "invoked" } });
  const improved = JSON.parse((await client.callTool({ name: "memhub_skill", arguments: { action: "record", skill_id: revised.skill_id, execution_id: retry.execution_id, stage: "success", note: "verified MCP round trip" } })).content[0].text);
  assert.ok(improved.summary.reliability > corrected.summary.reliability, "successful retry must improve version reliability");
  const wrongExecution = await client.callTool({ name: "memhub_skill", arguments: { action: "status", skill_id: skillRecord.id, execution_id: retry.execution_id } });
  assert.equal(wrongExecution.isError, true, "another Skill's execution must not appear under this ID");

  const retirementPlan = JSON.parse((await client.callTool({
    name: "memhub_skill",
    arguments: { action: "plan", operation: "retire", skill_id: revised.skill_id, note: "workflow superseded by external release" }
  })).content[0].text);
  const currentSkill = memoryById.get(revised.skill_id);
  const originalContent = currentSkill.body;
  currentSkill.body += " stale concurrent edit";
  const staleExecution = await client.callTool({
    name: "memhub_skill",
    arguments: { action: "execute", skill_id: revised.skill_id, authorization_id: retirementPlan.authorization_id }
  });
  assert.equal(staleExecution.isError, true, "mutated Skill must invalidate an older governance plan");
  currentSkill.body = originalContent;
  const freshRetirementPlan = JSON.parse((await client.callTool({
    name: "memhub_skill",
    arguments: { action: "plan", operation: "retire", skill_id: revised.skill_id, note: "workflow superseded by external release" }
  })).content[0].text);
  const retired = JSON.parse((await client.callTool({
    name: "memhub_skill",
    arguments: { action: "execute", skill_id: revised.skill_id, authorization_id: freshRetirementPlan.authorization_id }
  })).content[0].text);
  assert.equal(retired.status, "archived");
  assert.equal(memoryById.get(revised.skill_id).status, "archived");

}

async function exerciseGoldenDistillationChain(client, stateRoot, conversationId, aideL1EventId) {
  const harnessA = `golden-a-${conversationId}`;
  const harnessB = `golden-b-${conversationId}`;
  const harnessGlobal = `golden-global-${conversationId}`;
  const parseTool = (result) => JSON.parse(result.content[0].text);

  const captures = await listCaptureEvents(stateRoot, "acct-test");
  const aideCapture = captures.find((item) => item.event_id === aideL1EventId);
  assert.ok(aideCapture);
  const aideQueued = await enqueueDistillationJob({
    stateRoot,
    accountId: "acct-test",
    projectId: "aide",
    conversationId,
    captures: [aideCapture],
    reason: "manual"
  });
  assert.equal(aideQueued.created, true);
  const aideNext = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: { action: "next", kind: "l2", scope: "project", project: "aide", source_harness: harnessA }
  }));
  assert.equal(aideNext.job.job_id, aideQueued.job.job_id);
  const wrongOwner = await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: aideNext.job.job_id,
      content: "This write must be rejected before reaching Memory Core.",
      source_harness: "wrong-harness"
    }
  });
  assert.equal(wrongOwner.isError, true);
  assert.match(wrongOwner.content[0].text, /leased by another harness/i);
  const aideL2V1 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: aideNext.job.job_id,
      content: "AIDE timeline v1: the project binding was validated before memory changes.",
      project_description: "AIDE is an AI development environment focused on project-scoped orchestration and safe routing of work between harnesses.",
      source_harness: harnessA
    }
  }));
  assert.equal(aideL2V1.kind, "l2");
  assert.equal(aideL2V1.next_layer_job.job.target, "l3");
  const aideAfterDistilledDescription = parseTool(await client.callTool({
    name: "memmy_project_list",
    arguments: { query: "aide" }
  })).projects.find((project) => project.project === "aide");
  assert.ok(aideAfterDistilledDescription);
  assert.equal(aideAfterDistilledDescription.description, "AIDE project used by MCP integration tests.");
  assert.equal(aideAfterDistilledDescription.descriptionSource, "manual");
  assert.match(aideAfterDistilledDescription.distilledDescription, /AI development environment focused on project-scoped orchestration/);
  const aideL2Id = aideL2V1.memory.id;
  const aideL2WriteV1 = [...requests].reverse().find((entry) =>
    entry.url === "/api/v1/memory/add" && entry.body?.layer === "L2" && entry.body?.namespace?.projectId === "aide"
  );
  assert.ok(aideL2WriteV1);

  const aideL3Next = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: { action: "next", kind: "l3", scope: "project", project: "aide", source_harness: harnessA }
  }));
  const aideL3V1 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: aideL3Next.job.job_id,
      content: "Within AIDE, validate current state before changing deployment or routing configuration.",
      source_harness: harnessA
    }
  }));
  assert.equal(aideL3V1.kind, "l3");
  const aideL3Id = aideL3V1.memory.id;

  const betaProject = `beta-${conversationId}`;
  const createBetaPlan = parseTool(await client.callTool({
    name: "memmy_project_manage",
    arguments: {
      action: "plan",
      operation: "create",
      project: betaProject,
      name: `Beta ${conversationId}`,
      description: "Second project used to prove cross-project L4 evidence in the golden distillation test."
    }
  }));
  assert.equal(createBetaPlan.status, "awaiting_user_authorization");
  assert.equal(parseTool(await client.callTool({
    name: "memmy_project_manage",
    arguments: { action: "execute", authorization_id: createBetaPlan.authorization_id }
  })).ok, true);

  const betaConversation = `${conversationId}-beta`;
  await client.callTool({ name: "memmy_project", arguments: { action: "bind", conversation_id: betaConversation, project: betaProject } });
  const betaOpen = parseTool(await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "open",
      conversation_id: betaConversation,
      continuity_id: betaConversation,
      turn_id: `source-${betaConversation}`,
      user_text: "Keep the second project evidence isolated from AIDE."
    }
  }));
  const betaCommit = parseTool(await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "commit",
      event_id: betaOpen.turn.event_id,
      conversation_id: betaConversation,
      continuity_id: betaConversation,
      turn_id: `source-${betaConversation}`,
      assistant_text: "Second project evidence remains project-scoped until L4 aggregation."
    }
  }));
  assert.equal(betaCommit.turn.project_hint, betaProject);
  const betaCapture = (await listCaptureEvents(stateRoot, "acct-test")).find((item) => item.event_id === betaOpen.turn.event_id);
  assert.ok(betaCapture);
  const betaQueued = await enqueueDistillationJob({
    stateRoot,
    accountId: "acct-test",
    projectId: betaProject,
    conversationId: betaConversation,
    captures: [betaCapture],
    reason: "manual"
  });
  const betaL2Next = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: { action: "next", kind: "l2", scope: "project", project: betaProject, source_harness: harnessB }
  }));
  assert.equal(betaL2Next.job.job_id, betaQueued.job.job_id);
  const betaL2 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: betaL2Next.job.job_id,
      content: "Beta timeline v1: project evidence is isolated and only crosses projects at L4.",
      source_harness: harnessB
    }
  }));
  assert.equal(betaL2.next_layer_job.job.target, "l3");
  const betaL3Next = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: { action: "next", kind: "l3", scope: "project", project: betaProject, source_harness: harnessB }
  }));
  const betaL3 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: betaL3Next.job.job_id,
      content: "Within Beta, preserve explicit project isolation before cross-project synthesis.",
      source_harness: harnessB
    }
  }));
  assert.equal(betaL3.next_layer_job.job.target, "l4");
  const betaL3Id = betaL3.memory.id;

  const l4NextV1 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: { action: "next", kind: "l4", scope: "account", source_harness: harnessGlobal }
  }));
  assert.equal(l4NextV1.job.evidence.length, 2);
  assert.equal(new Set(l4NextV1.job.evidence.map((item) => item.project_id)).size, 2);
  const l4V1 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: l4NextV1.job.job_id,
      content: "Across projects, prefer explicit state validation and strict project isolation before shared conclusions.",
      source_harness: harnessGlobal
    }
  }));
  assert.equal(l4V1.kind, "l4");
  assert.equal(l4V1.project, null);
  const l4IdV1 = l4V1.memory.id;
  const l4WriteV1 = [...requests].reverse().find((entry) =>
    entry.url === "/api/v1/memory/add" && entry.body?.layer === "L4"
  );
  assert.ok(l4WriteV1);

  const aideOpenV2 = parseTool(await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "open",
      conversation_id: conversationId,
      continuity_id: conversationId,
      turn_id: `source-${conversationId}-v2`,
      user_text: "Update AIDE with a second durable decision."
    }
  }));
  await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "commit",
      event_id: aideOpenV2.turn.event_id,
      conversation_id: conversationId,
      continuity_id: conversationId,
      turn_id: `source-${conversationId}-v2`,
      assistant_text: "The second decision is now part of AIDE current truth."
    }
  });
  const aideCaptureV2 = (await listCaptureEvents(stateRoot, "acct-test")).find((item) => item.event_id === aideOpenV2.turn.event_id);
  assert.ok(aideCaptureV2);
  const aideQueuedV2 = await enqueueDistillationJob({
    stateRoot,
    accountId: "acct-test",
    projectId: "aide",
    conversationId,
    captures: [aideCaptureV2],
    reason: "manual"
  });
  const aideL2NextV2 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: { action: "next", kind: "l2", scope: "project", project: "aide", source_harness: harnessA }
  }));
  assert.equal(aideL2NextV2.job.job_id, aideQueuedV2.job.job_id);
  const aideL2V2 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: aideL2NextV2.job.job_id,
      content: "AIDE timeline v2: preserve the original validation decision and append the second durable decision as current truth.",
      project_description: "AIDE coordinates project-aware AI development work while preserving explicit workspace ownership, routing boundaries, and durable current state.",
      source_harness: harnessA
    }
  }));
  assert.equal(aideL2V2.memory.id, aideL2Id);
  const aideL2Writes = requests.filter((entry) =>
    entry.url === "/api/v1/memory/add" && entry.body?.layer === "L2" && entry.body?.namespace?.projectId === "aide"
  );
  const aideL2WriteV2 = aideL2Writes.at(-1);
  assert.notEqual(aideL2WriteV1.body.requestId, aideL2WriteV2.body.requestId);

  const aideL3NextV2 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: { action: "next", kind: "l3", scope: "project", project: "aide", source_harness: harnessA }
  }));
  const aideL3V2 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: aideL3NextV2.job.job_id,
      content: "Within AIDE, validate current state first and preserve durable decisions as the project evolves.",
      source_harness: harnessA
    }
  }));
  assert.equal(aideL3V2.memory.id, aideL3Id);
  assert.equal(aideL3V2.next_layer_job.job.target, "l4");

  const l4NextV2 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: { action: "next", kind: "l4", scope: "account", source_harness: harnessGlobal }
  }));
  const l4V2 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: l4NextV2.job.job_id,
      content: "Across projects, prefer explicit state validation, durable current truth, and strict project isolation before cross-project synthesis.",
      source_harness: harnessGlobal
    }
  }));
  assert.equal(l4V2.memory.id, l4IdV1);
  const l4Writes = requests.filter((entry) => entry.url === "/api/v1/memory/add" && entry.body?.layer === "L4");
  const l4WriteV2 = l4Writes.at(-1);
  assert.notEqual(l4WriteV1.body.requestId, l4WriteV2.body.requestId);
  assert.equal(memoryById.get(l4IdV1).version >= 2, true);

  return { aideL3Id, betaL3Id };
}

async function testProjectDescriptionPrecedence() {
  const path = join(root, "project-description-registry.json");
  const registry = new JsonProjectRegistry(path);
  await registry.reconcile("acct-description", ["auto-project"]);
  let project = (await registry.list("acct-description")).find((item) => item.projectId === "auto-project");
  assert.ok(project);
  assert.equal(project.description, "");
  await registry.updateDistilledDescription(
    "acct-description",
    "auto-project",
    "Auto Project is an evidence-backed project description derived from its L2 timeline.",
    ["l1-memory:one", "l1-memory:two"]
  );
  project = (await registry.list("acct-description")).find((item) => item.projectId === "auto-project");
  assert.equal(project.descriptionSource, "distilled");
  assert.match(project.description, /evidence-backed project description/);
  assert.deepEqual(project.descriptionEvidenceRefs, ["l1-memory:one", "l1-memory:two"]);
  await registry.update("acct-description", "auto-project", {
    description: "Manual project description set explicitly by the user."
  });
  await registry.updateDistilledDescription(
    "acct-description",
    "auto-project",
    "A newer distilled description that must not overwrite the explicit manual description.",
    ["l1-memory:three"]
  );
  project = (await registry.list("acct-description")).find((item) => item.projectId === "auto-project");
  assert.equal(project.description, "Manual project description set explicitly by the user.");
  assert.equal(project.descriptionSource, "manual");
  assert.equal(project.distilledDescription, "A newer distilled description that must not overwrite the explicit manual description.");
  assert.deepEqual(project.descriptionEvidenceRefs, ["l1-memory:three"]);

  await registry.reconcile("acct-description", ["distilled-target"]);
  await registry.updateDistilledDescription(
    "acct-description",
    "distilled-target",
    "Distilled target description.",
    ["l1-memory:target"]
  );
  await registry.create("acct-description", {
    projectId: "manual-source",
    description: "Manual source description that must win after merge."
  });
  const merged = await registry.merge("acct-description", "manual-source", "distilled-target");
  assert.equal(merged.target.description, "Manual source description that must win after merge.");
  assert.equal(merged.target.descriptionSource, "manual");
  assert.equal(merged.target.distilledDescription, "Distilled target description.");
}

function hit(id, snippet, tags = []) {
  return { id, kind: "trace", memoryLayer: "L1", status: "activated", snippet, score: 0.9, tags, source: "search" };
}

async function freePort() {
  const server = createServer();
  await new Promise((ready, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", ready);
  });
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}
