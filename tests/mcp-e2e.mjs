import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import Database from "better-sqlite3";
import { FileProjectArchitectureSource } from "../dist/architecture-source.js";
import { JsonProjectRegistry } from "../dist/project-registry.js";
import { addAccount, ensureLocalAdminToken, setAccountRole } from "../dist/auth.js";
import { listCaptureEvents } from "../dist/capture.js";
import { defaultMemoryUserId } from "../dist/memory-source.js";
import {
  completeDistillationJob,
  enqueueDerivedDistillationJob,
  enqueueDistillationJob,
  failDistillationJob,
  leaseDistillationJob,
  listDistillationJobs,
  quarantineDistillationJobAfterCoreCommit,
  recordCompletedDistillationRevision,
  retryDistillationJob,
  setDistillationConfig
} from "../dist/distillation-jobs.js";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const mcpEntry = resolve(here, "../dist/mcp.js");
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
    l3:{total:1,items:[{id:"l3-browser-1",project_id:"alpha",title:"Alpha durable rules",summary:"Durable project rules",body:"Project guidance should remain readable before the detailed rules.\\n\\n## Interaction rules\\n- Preserve root overflow at zero.\\n- Keep mobile navigation discoverable.\\n- Verify browser evidence before acceptance.\\n\\nClosing context should remain visible after the bullet list.",updatedAt:"2026-09-21T08:25:00.000Z"}]},
    l4:{total:1,items:[{id:"l4-browser-1",title:"Cross-project profile",summary:"Stable cross-project working profile",body:"- Prefers evidence-backed verification.\\n- Prefers minimal sufficient architecture.",updatedAt:"2026-09-21T08:30:00.000Z"}]},
    skills:{total:2,items:[
      {id:"skill-browser-1",title:"Responsive review",summary:"Reusable frontend review procedure",status:"activated",tags:["distilled","artifact:skill","project:alpha"]},
      {id:"skill-browser-external",title:"Review agent",summary:"Installed external review workflow",status:"activated",tags:["legacy-import","agent-source","cross-agent-skill"]}
    ]},
    visualization:{schema_version:2,visualization_contract:"memhub-project-state-ir-v1",source_of_truth:"canonical-l2",revision_source:"exact-l2-revision-ledger",projection_only:true,project_id:"alpha",requires_project:false,stats:{events:4,workstreams:2,l2_revisions:3,versions:2,pending_todos:1},state:{current_head_event_id:"event-dashboard-v2",current_l2_memory_ids:["l2-browser-1"],workstreams:[
      {id:"stream-capture",label:"Capture",basis:"inferred",event_count:2,current_event_id:"event-capture-v2",versions:["v1","v2"]},
      {id:"stream-dashboard",label:"Dashboard",basis:"inferred",event_count:2,current_event_id:"event-dashboard-v2",versions:["v1","v2"]}
    ],events:[
      {id:"event-capture-v1",memory_id:"l2-browser-1",date:"2026-09-20",date_label:"2026-09-20",title:"Capture v1 candidate",summary:"Capture validation started.",order:1,workstream_id:"stream-capture",workstream_label:"Capture",workstream_basis:"inferred",stage:"active",version:"v1",current_head:false,workstream_head:false,source_revision_refs:["l2:l2-browser-1:revision-old"],latest_revision_ref:"l2:l2-browser-1:revision-old",evidence_refs:["l1:turn-browser-1"],first_seen_at:"2026-09-20T08:20:00.000Z",last_seen_at:"2026-09-20T08:20:00.000Z"},
      {id:"event-dashboard-v1",memory_id:"l2-browser-1",date:"2026-09-20",date_label:"2026-09-20",title:"Dashboard v1 start",summary:"Project status view started.",order:2,workstream_id:"stream-dashboard",workstream_label:"Dashboard",workstream_basis:"inferred",stage:"active",version:"v1",current_head:false,workstream_head:false,source_revision_refs:["l2:l2-browser-1:revision-old"],latest_revision_ref:"l2:l2-browser-1:revision-old",evidence_refs:["l1:turn-browser-1"],first_seen_at:"2026-09-20T08:20:00.000Z",last_seen_at:"2026-09-20T08:20:00.000Z"},
      {id:"event-capture-v2",memory_id:"l2-browser-1",date:"2026-09-21",date_label:"2026-09-21",title:"Capture v2 completed",summary:"Capture v2 passed regression.",order:3,workstream_id:"stream-capture",workstream_label:"Capture",workstream_basis:"inferred",stage:"completed",version:"v2",current_head:false,workstream_head:true,source_revision_refs:["l2:l2-browser-1:revision-current"],latest_revision_ref:"l2:l2-browser-1:revision-current",evidence_refs:["l1:turn-browser-1"],first_seen_at:"2026-09-21T08:20:00.000Z",last_seen_at:"2026-09-21T08:20:00.000Z"},
      {id:"event-dashboard-v2",memory_id:"l2-browser-1",date:"2026-09-21",date_label:"2026-09-21",title:"Dashboard v2 pending",summary:"Browser acceptance is still pending.",order:4,workstream_id:"stream-dashboard",workstream_label:"Dashboard",workstream_basis:"inferred",stage:"pending",version:"v2",current_head:true,workstream_head:true,source_revision_refs:["l2:l2-browser-1:revision-current"],latest_revision_ref:"l2:l2-browser-1:revision-current",evidence_refs:["l1:turn-browser-1"],first_seen_at:"2026-09-21T08:20:00.000Z",last_seen_at:"2026-09-21T08:20:00.000Z"}
    ]},drilldown:{revisions:[{ref:"l2:l2-browser-1:revision-old",memory_id:"l2-browser-1",committed_at:"2026-09-20T08:20:00.000Z",current:false,event_ids:["event-capture-v1","event-dashboard-v1"],evidence_refs:["l1:turn-browser-1"]},{ref:"l2:l2-browser-1:revision-current",memory_id:"l2-browser-1",committed_at:"2026-09-21T08:20:00.000Z",current:true,event_ids:["event-capture-v1","event-dashboard-v1","event-capture-v2","event-dashboard-v2"],evidence_refs:["l1:turn-browser-1"]}],todos:[{id:"todo-1",text:"Verify responsive governance layout",status:"pending",created_at:"2026-09-21T08:00:00.000Z",updated_at:"2026-09-21T08:00:00.000Z",completed_at:null}]},archify:{role:"optional_export_and_design_reference",compatible_diagram_types:["lifecycle"],invariant:"projection only",lifecycle_ir:{meta:{title:"Alpha project state",subtitle:"Canonical L2 projection",output:"memhub-project-state-alpha.html"},lanes:[{id:"stream-capture",label:"Capture"},{id:"stream-dashboard",label:"Dashboard"}],states:[],transitions:[]}}},
    processing:{config:{auto_enabled:true,turn_threshold:8,idle_minutes:30},items:[
      {job_id:"job-browser-1",target:"l2",project_id:"alpha",reason:"threshold",evidence_refs:["l1:browser"],status:"failed",failure:"Simulated L2 evidence mismatch",failure_kind:"core_error",failed_at:"2026-09-21T08:35:00.000Z",attempts:2,updated_at:"2026-09-21T08:35:00.000Z"},
      {job_id:"job-browser-ambiguous",target:"l2",project_id:"beta",reason:"threshold",evidence_refs:["l1:ambiguous"],status:"failed",failure:"Ambiguous Core commit requires manual reconciliation",failure_kind:"ambiguous_core_commit",failed_at:"2026-09-21T08:34:00.000Z",attempts:1,updated_at:"2026-09-21T08:34:00.000Z"}
    ]},
    accounts:{total:1,items:[{account_id:"acct-browser",username:"browser-admin",cloudflare_email:"operator.long.identity@example.org",role:"admin",status:"active"}]}
  };
  payloads.overview.projects = payloads.projects.items;
  payloads.overview.layers = { l2: payloads.l2.items, l3: payloads.l3.items };
  payloads.overview.processing = { ...payloads.overview.processing, items: payloads.processing.items };
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
    "if("+JSON.stringify(page)+"==='workspace'){const ps=d.getElementById('project-select');ps.value='';ps.dispatchEvent(new Event('change',{bubbles:true}));await settle();await clickView('overview');check('all-projects-portfolio',d.querySelectorAll('.portfolio-record').length>=2,String(d.querySelectorAll('.portfolio-record').length));check('overview-title-continue',/Continue working|继续工作/.test(d.getElementById('workspace-title')?.textContent||''));ps.value='alpha';ps.dispatchEvent(new Event('change',{bubbles:true}));await settle();const todoRow=d.querySelector('.project-overview-todo-row'),todoMarker=todoRow?.querySelector('.todo-marker');check('project-overview-todo-separated',!!todoRow&&todoRow.getBoundingClientRect().height>=70,String(todoRow?.getBoundingClientRect().height));check('project-overview-todo-marker',todoMarker?.textContent==='•'&&parseFloat(w.getComputedStyle(todoMarker).fontSize)>=20,w.getComputedStyle(todoMarker||d.body).fontSize);await clickView('l2');check('subview-title-specific',!/Continue working|继续工作/.test(d.getElementById('workspace-title')?.textContent||'')&&/Project chronology|项目时间线/.test(d.getElementById('workspace-title')?.textContent||''))}",
    "if(!"+fullFlag+"){await clickView(\'processing\');await settle(260);check(\'mobile-view-processing\',d.getElementById(\'mobile-view-select\')?.value===\'processing\');check(\'root-overflow-after-nav\',d.documentElement.scrollWidth===d.documentElement.clientWidth);out.textContent=JSON.stringify({checks});return}",
    "for(const v of ['overview','projects','l1','l2','l3','l4','skills','processing']){await clickView(v);check('rendered-'+v,!!d.getElementById('items')?.textContent.trim())}await clickView('l3');check('secondary-description-visible',d.getElementById('workspace-description')?.getClientRects().length>0);check('secondary-panel-heading-visible',d.getElementById('view-title')?.getClientRects().length>0);const l3text=d.getElementById('items')?.textContent||'';check('l3-mixed-content-complete',l3text.includes('Project guidance should remain readable')&&l3text.includes('Interaction rules')&&l3text.includes('Closing context should remain visible'));",
    "await clickView('visualization');check('project-state-workstreams',d.querySelectorAll('.project-state-lane-row').length===2,String(d.querySelectorAll('.project-state-lane-row').length));check('project-state-events',d.querySelectorAll('.project-state-event').length===4,String(d.querySelectorAll('.project-state-event').length));check('project-state-current-head',d.querySelectorAll('.project-state-event.is-current').length===1);check('project-state-no-old-graph',d.querySelectorAll('.visual-node,.visual-edge').length===0);const stateEvent=d.querySelector('.project-state-event.is-current');stateEvent?.dispatchEvent(new MouseEvent('click',{bubbles:true}));await settle(40);check('project-state-drawer',!d.getElementById('drawer').classList.contains('hidden'));check('project-state-drawer-revision',/revision-current/.test(d.getElementById('drawer-body')?.textContent||''));check('project-state-drawer-todo',/Verify responsive governance layout/.test(d.getElementById('drawer-body')?.textContent||''));w.closeDrawer();await settle(30);",
    "if("+JSON.stringify(page)+"==='admin'){await clickView('skills');check('skill-governed-group',d.querySelectorAll('.skill-group.governed .memory-row').length===1);check('skill-external-group',d.querySelectorAll('.skill-group.external .memory-row').length===1);check('skill-external-collapsed',!d.querySelector('.skill-group.external')?.open);await clickView('overview');check('overview-single-heading',d.getElementById('view-title').getClientRects().length===0);check('overview-followup-wide',d.querySelector('.overview-todos')?.getBoundingClientRect().width>=d.querySelector('.admin-health-card')?.getBoundingClientRect().width-1);check('overview-human-status',/Failed|处理失败/.test(d.querySelector('.health-metric.failed small')?.textContent||'')&&!/^(failed|pending|leased)$/.test(d.querySelector('.health-metric.failed small')?.textContent||''));await clickView('processing');const toggle=d.getElementById('cfg-auto');check('policy-switch-semantic',toggle?.getAttribute('role')==='switch'&&toggle?.closest('label')?.textContent.includes('Automatic'));check('processing-human-status',d.querySelector('.job-state')?.textContent==='Failed');check('processing-failure-summary',d.querySelector('.job-error')?.textContent.includes('evidence mismatch'));check('processing-retry-action',d.querySelectorAll('.job-quick-retry').length===1);check('processing-ambiguous-no-quick-retry',d.querySelectorAll('.job-entry').length===2&&d.querySelectorAll('.job-entry')[1]?.querySelector('.job-quick-retry')===null);d.querySelector('.job-row')?.click();await settle(40);check('processing-detail-failure',d.querySelector('.job-failure-detail')?.textContent.includes('evidence mismatch'));w.closeDrawer();await settle(30);d.querySelectorAll('.job-row')[1]?.click();await settle(40);check('processing-ambiguous-drawer-no-retry',!d.querySelector('#drawer-body [data-retry-index]'));w.closeDrawer();await settle(30);await clickView('accounts');check('account-email-primary',d.querySelector('.account-identity')?.textContent==='operator.long.identity@example.org');check('account-uuid-secondary',d.querySelector('.account-record-meta code')?.textContent==='acct-browser');check('account-no-default-json',!d.querySelector('.account-record pre'));d.querySelector('.account-record-main')?.click();await settle(40);check('account-structured-detail',!!d.querySelector('.account-detail')&&d.getElementById('drawer-title')?.textContent.includes('operator.long.identity@example.org'));w.closeDrawer()}",
    "await clickView('projects');check('long-project-content',d.querySelector('.project-ledger-record p')?.textContent.length>80);check('primary-projects-no-json',!d.querySelector('#items pre')&&!/\\{\\s*\\\"/.test(d.getElementById('items')?.textContent||''));w.__browserMock.delayNextGet=true;d.querySelector('aside button[data-view=\\\"l1\\\"]')?.click();check('loading-state-visible',!!d.querySelector('.loading-state'));await settle(230);check('loading-state-clears',!d.querySelector('.loading-state'));",
    "w.__browserMock.failNext=true;d.getElementById('refresh').click();await settle(110);check('load-error-visible',!!d.querySelector('.load-error'));check('load-error-retry',!!d.querySelector('.load-error button'));check('load-error-details',!!d.querySelector('.load-error details'));d.querySelector('.load-error button').click();await settle();check('load-error-recovers',!d.querySelector('.load-error'));",
    "await clickView('projects');const card=d.querySelector('.project-ledger-record');card.focus();card.click();await settle(40);const drawer=d.getElementById('drawer'),scrim=d.getElementById('drawer-scrim');check('drawer-open',!drawer.classList.contains('hidden'));check('drawer-scrim-visible',!scrim.classList.contains('hidden')&&scrim.getClientRects().length>0);check('project-structured-detail',!!d.querySelector('.drawer-readable-section')&&!!d.querySelector('.drawer-facts'));check('raw-json-collapsed',d.querySelector('#drawer-body details')?.open===false);const labelled=drawer.getAttribute('aria-labelledby');check('drawer-accessible-name',!!(labelled&&d.getElementById(labelled)?.textContent.trim()));check('drawer-focus-enters',drawer.contains(d.activeElement));check('background-inert',d.getElementById('main-content').hasAttribute('inert'));scrim.click();await settle(30);check('drawer-outside-click-closes',drawer.classList.contains('hidden'));check('drawer-outside-click-clears-inert',!d.getElementById('main-content').hasAttribute('inert'));check('drawer-outside-click-restores-focus',d.activeElement===card);card.click();await settle(40);check('drawer-reopens',!drawer.classList.contains('hidden'));let fs=[...drawer.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex=\\\"-1\\\"])')].filter(e=>e.getClientRects().length);fs.at(-1).focus();d.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));check('drawer-tab-trap',d.activeElement===fs[0]);",
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
  "L1", JSON.stringify(["project:alpha"]), JSON.stringify({ project_id: "alpha" }), "{}",
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
let captureVsRecoveryCoreEntered;
let releaseCaptureVsRecoveryCore;
const captureVsRecoveryCoreStarted = new Promise((resolve) => {
  captureVsRecoveryCoreEntered = resolve;
});
const captureVsRecoveryCoreGate = new Promise((resolve) => {
  releaseCaptureVsRecoveryCore = resolve;
});
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
    if (body.query === "__exact_evidence_ref_probe__" && project) {
      const record = [...memoryById.values()].find((item) =>
        item.memoryLayer === "L2" && item.namespace?.projectId === project
      );
      response.end(JSON.stringify({ hits: record ? [{
        id: record.id,
        kind: "timeline",
        memoryLayer: record.memoryLayer,
        status: record.status,
        snippet: record.body,
        score: 0.99,
        tags: record.tags,
        source: "search",
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
      }] : [] }));
      return;
    }
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
    const writtenAt = new Date().toISOString();
    const record = {
      id,
      memoryLayer: body.layer ?? "L1",
      status: "activated",
      createdAt: prior?.createdAt ?? writtenAt,
      updatedAt: writtenAt,
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
    const includeBody = ["1", "true"].includes((viewerUrl.searchParams.get("includeBody") ?? "").toLowerCase());
    const renderedItems = includeBody ? items : items.map(({ body: _body, ...item }) => item);
    response.end(JSON.stringify({ items: renderedItems, total: items.length }));
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
    if (body.query === "http and recover racing on same event") {
      captureVsRecoveryCoreEntered();
      await captureVsRecoveryCoreGate;
    }
    if (body.query === "inject core idempotency conflict") {
      response.statusCode = 409;
      response.end(JSON.stringify({ error: "idempotency key reused with different request body" }));
      return;
    }
    if (body.query === "inject core transient failure") {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: "injected transient core failure" }));
      return;
    }
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
  console.log("memhub-mcp-e2e: ok");
} finally {
  await new Promise((resolveClose) => memory.close(resolveClose));
  await rm(root, { recursive: true, force: true });
}

async function testLocalAdmin(memoryPort) {
  const port = await freePort();
  const stateRoot = join(root, "local-admin");
  const account = await addAccount(stateRoot, "admin-test", "admin@example.com");
  await setAccountRole(stateRoot, account.account_id, "admin");
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
    const forwardedHttp = await rawHttp(port, "/memhub?source=http", {
      host: "memhub.example.test",
      "x-forwarded-proto": "http"
    });
    assert.equal(forwardedHttp.status, 308);
    assert.equal(forwardedHttp.headers.location, "https://memhub.example.test/memhub?source=http");
    const loopbackClient = new Client({ name: "memhub-local-public-host-test", version: "1.0.0" });
    await loopbackClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    try {
      const partialTurn = JSON.parse((await loopbackClient.callTool({
        name: "memmy_turn",
        arguments: {
          action: "open",
          event_id: "control-plane-live-turn",
          user_text: "This live conversation has not reached assistant final yet."
        }
      })).content[0].text);
      assert.equal(partialTurn.turn.status, "open");
    } finally {
      await loopbackClient.close();
    }
    const anonymous = await fetch(`http://127.0.0.1:${port}/memhub/admin`);
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get("www-authenticate") ?? "", /Memhub local admin/);
    const authorization = `Basic ${Buffer.from(`memhub:${token}`).toString("base64")}`;
    const authenticated = await fetch(`http://127.0.0.1:${port}/memhub/admin`, { headers: { authorization } });
    assert.equal(authenticated.status, 200);
    assert.equal(authenticated.headers.get("strict-transport-security"), "max-age=3600");
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
    assert.match(authenticatedHtml, /data-view="visualization"/);
    assert.match(authenticatedHtml, /Export Archify IR/);
    assert.match(authenticatedHtml, /Export current-view HTML/);
    assert.match(authenticatedHtml, /function projectStateSearchText/);
    assert.match(authenticatedHtml, /Workstreams are derived from repeated L2 terminology/);
    assert.match(authenticatedHtml, /project-state-scope-note/);
    assert.match(authenticatedHtml, /current mainline comes from the canonical L2 head/);
    assert.doesNotMatch(authenticatedHtml, /function selectVisualNodes/);
    assert.doesNotMatch(authenticatedHtml, /openVisualNode/);
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
    assert.match(landingHtml, /EXAMPLE PROJECT/);
    assert.match(landingHtml, /Atlas Demo/);
    assert.match(landingHtml, /虚构示例数据/);
    assert.doesNotMatch(landingHtml, /打开我的记忆|Open my memory/,
      "public Landing must not use the old personal-memory CTA");
    assert.match(landingHtml, /class="console-entry" href="\/memhub\/user" data-zh="进入管理台" data-en="Open console"/);
    assert.equal((landingHtml.match(/href="\/memhub\/user"/g) ?? []).length, 1,
      "Landing may expose exactly one self-hosted console entry");
    const mobileLandingMenu = landingHtml.match(/<div id="mobile-menu"[\s\S]*?<\/div>/)?.[0] ?? "";
    assert.doesNotMatch(mobileLandingMenu, /\/memhub\/user|进入管理台|Open console/,
      "mobile Landing navigation must not expose the console entry");
    assert.match(landingHtml, /href="\/memhub\/docs\/install" data-zh="安装 Memhub"/);
    assert.doesNotMatch(landingHtml, /updated 2m ago/, "public preview must identify its data as a fictional example rather than implying a live project snapshot");
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
    const retryCandidate = await enqueueDerivedDistillationJob({
      stateRoot,
      accountId: account.account_id,
      target: "l3",
      projectId: "ui-beta",
      evidence: [{
        ref: "artifact:ui-beta-retry-authorization",
        kind: "artifact",
        timestamp: "2026-09-26T00:00:00.000Z",
        project_id: "ui-beta",
        layer: "L2",
        content: "Retry authorization boundary fixture."
      }]
    });
    const retryHarness = "ui-retry-authorization-harness";
    const retryLease = await leaseDistillationJob(stateRoot, account.account_id, {
      projectId: "ui-beta", target: "l3", harness: retryHarness
    });
    assert.equal(retryLease?.job_id, retryCandidate.job.job_id);
    await failDistillationJob(
      stateRoot, account.account_id, retryCandidate.job.job_id,
      "simulated retryable admin failure", retryHarness
    );
    const forbiddenUserRetry = await fetch(`http://127.0.0.1:${port}/memhub/user/action`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ action: "retry-distillation", id: retryCandidate.job.job_id })
    });
    assert.equal(forbiddenUserRetry.status, 403,
      "workspace user cannot bypass the Admin-only retry control by posting directly");
    const allowedAdminRetry = await adminAction({
      action: "retry-distillation", id: retryCandidate.job.job_id
    });
    assert.equal(allowedAdminRetry.status, 200);
    assert.equal((await allowedAdminRetry.json()).job.status, "pending");
    const ambiguousCandidate = await enqueueDerivedDistillationJob({
      stateRoot,
      accountId: account.account_id,
      target: "skill",
      projectId: "ui-beta",
      evidence: [{
        ref: "artifact:ui-beta-ambiguous-retry",
        kind: "artifact",
        timestamp: "2026-09-26T00:00:00.000Z",
        project_id: "ui-beta",
        layer: "L2",
        content: "Ambiguous retry boundary fixture."
      }]
    });
    const ambiguousHarness = "ui-ambiguous-retry-harness";
    const ambiguousLease = await leaseDistillationJob(stateRoot, account.account_id, {
      projectId: "ui-beta", target: "skill", harness: ambiguousHarness, useLeaseToken: true
    });
    assert.equal(ambiguousLease?.job_id, ambiguousCandidate.job.job_id);
    await quarantineDistillationJobAfterCoreCommit(
      stateRoot, account.account_id, ambiguousCandidate.job.job_id,
      "Memory Core returned success without a stable result id; ambiguous commit requires manual reconciliation before retry",
      ambiguousHarness, ambiguousLease.lease_token
    );
    const ambiguousAdminRetry = await adminAction({
      action: "retry-distillation", id: ambiguousCandidate.job.job_id
    });
    assert.equal(ambiguousAdminRetry.status, 409);
    assert.equal((await ambiguousAdminRetry.json()).error, "manual_reconciliation_required");
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
    const updatedConfig = (await processingAfter.json()).config;
    assert.equal(updatedConfig.auto_enabled, true);
    assert.equal(updatedConfig.turn_threshold, 12);
    assert.equal(updatedConfig.idle_minutes, 45);
    assert.ok(Number.isFinite(Date.parse(updatedConfig.auto_since)));
    const userOverview = await fetch(`http://127.0.0.1:${port}/memhub/user/api?kind=overview`, { headers: { authorization } });
    assert.equal(userOverview.status, 200);
    const userOverviewPayload = await userOverview.json();
    assert.equal(userOverviewPayload.account.account_id, account.account_id);
    assert.equal(userOverviewPayload.counts.pendingTodo, 1);
    assert.equal(userOverviewPayload.todos.total, 1);
    assert.equal(userOverviewPayload.todos.projects, 1);
    assert.deepEqual(userOverviewPayload.todos.pending.map((todo) => todo.text), ["Finish the pending Alpha task."]);
    assert.ok(Array.isArray(userOverviewPayload.projects));
    assert.ok(userOverviewPayload.projects.every((project) => !Object.hasOwn(project, "todos")));
    assert.ok(Array.isArray(userOverviewPayload.layers?.l2));
    assert.ok(Array.isArray(userOverviewPayload.layers?.l3));
    assert.ok([...userOverviewPayload.layers.l2, ...userOverviewPayload.layers.l3].every((item) =>
      !Object.hasOwn(item, "tags") && !Object.hasOwn(item, "body")
    ));
    assert.ok(Array.isArray(userOverviewPayload.processing?.items));
    assert.ok(userOverviewPayload.processing.items.every((item) =>
      Object.keys(item).every((key) => key === "project_id" || key === "status") &&
      ["failed", "pending", "leased"].includes(item.status)
    ));

    const detailReadsBefore = requests.filter((entry) => /^\/api\/v1\/memory\/[^/?]+$/.test(entry.url ?? "")).length;
    const layerRequestOffset = requests.length;
    const l2View = await fetch(`http://127.0.0.1:${port}/memhub/user/api?kind=l2`, { headers: { authorization } });
    assert.equal(l2View.status, 200);
    const l2ViewPayload = await l2View.json();
    const layerRequests = requests.slice(layerRequestOffset).map((entry) => entry.url ?? "");
    assert.ok(layerRequests.some((value) => {
      const parsed = new URL(value, "http://127.0.0.1");
      return parsed.pathname === "/api/v1/l2" && parsed.searchParams.get("includeBody") === "1";
    }));
    assert.equal(
      requests.filter((entry) => /^\/api\/v1\/memory\/[^/?]+$/.test(entry.url ?? "")).length,
      detailReadsBefore,
      "hydrated memory layers must not perform per-record detail reads"
    );
    if (l2ViewPayload.items.length > 0) assert.equal(typeof l2ViewPayload.items[0].body, "string");

    const visualizationView = await fetch(`http://127.0.0.1:${port}/memhub/user/api?kind=visualization`, { headers: { authorization } });
    assert.equal(visualizationView.status, 200);
    const visualizationPayload = await visualizationView.json();
    assert.equal(visualizationPayload.visualization_contract, "memhub-project-state-ir-v1");
    assert.equal(visualizationPayload.source_of_truth, "canonical-l2");
    assert.equal(visualizationPayload.revision_source, "exact-l2-revision-ledger");
    assert.equal(visualizationPayload.projection_only, true);
    assert.equal(visualizationPayload.requires_project, true);
    assert.deepEqual(visualizationPayload.state.events, []);
    assert.deepEqual(visualizationPayload.state.workstreams, []);
    assert.deepEqual(visualizationPayload.drilldown.revisions, []);
    assert.equal(visualizationPayload.archify.role, "optional_export_and_design_reference");

    const adminOverview = await fetch(`http://127.0.0.1:${port}/memhub/admin/api?kind=overview`, { headers: { authorization } });
    assert.equal(adminOverview.status, 200);
    assert.equal((await adminOverview.json()).account_count, 1);
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
    "--account", account.account_id,
    "--memory-url", `http://127.0.0.1:${memoryPort}`,
    "--state-root", stateRoot,
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
    assert.match(landingHtml, /href="\/docs\/install"/);
    assert.match(landingHtml, /class="console-entry" href="\/user"/);
    assert.equal((landingHtml.match(/href="\/user"/g) ?? []).length, 1);
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
  const architectureDir = join(root, "normify-alpha", "modules", "alpha");
  const currentArchitectureDir = join(root, "Memhub", "docs");
  const nestedBetaDir = join(root, "agent-workspace", "beta");
  await mkdir(architectureDir, { recursive: true });
  await mkdir(currentArchitectureDir, { recursive: true });
  await mkdir(nestedBetaDir, { recursive: true });
  await writeFile(join(root, "Memhub", "package.json"), JSON.stringify({ name: "memhub-test-project" }) + "\n");
  await writeFile(
    join(architectureDir, "core.md"),
    "# ALPHA Core Architecture\n\nBroker routes work to the harness router. Current constraint: preserve explicit workspace ownership.\n"
  );
  await writeFile(
    join(currentArchitectureDir, "ARCHITECTURE.md"),
    "# Memhub Current Architecture\n\nL1 is authoritative source evidence. L2 and L3 are project-scoped, L4 is account-scoped.\n"
  );
  const betaRepoArchitecture = join(nestedBetaDir, "ARCHITECTURE.md");
  const betaRepoBody = "# Beta Repository Architecture\n\nRepository architecture is a read-only migration seed.\n";
  await writeFile(betaRepoArchitecture, betaRepoBody);
  const architectureReader = new FileProjectArchitectureSource({ rootDir: root });
  const betaTarget = await architectureReader.inspectProjectArchitecture({ accountId: "acct-test", projectId: "beta" });
  assert.ok(betaTarget);
  assert.equal(betaTarget.exists, false);
  assert.match(betaTarget.path, /\.memhub-project-architecture\/[^/]+\/beta\/ARCHITECTURE\.md$/);
  assert.match(betaTarget.content, /Repository architecture is a read-only migration seed/);
  const betaWritten = await architectureReader.writeProjectArchitecture({
    accountId: "acct-test",
    projectId: "beta",
    expectedPath: betaTarget.path,
    expectedFingerprint: betaTarget.fingerprint,
    content: "# Beta Managed Architecture\n\nMemhub-managed architecture is canonical after explicit migration.\n"
  });
  assert.equal(betaWritten.after.exists, true);
  assert.match(betaWritten.after.content, /Memhub-managed architecture is canonical/);
  assert.equal(await readFile(betaRepoArchitecture, "utf8"), betaRepoBody,
    "Architecture writer must never mutate the repository source document");
  const discoveredArchitectureProjects = await architectureReader.listProjects("acct-test");
  assert.ok(discoveredArchitectureProjects.some((project) => project.toLowerCase() === "alpha"));
  assert.ok(discoveredArchitectureProjects.some((project) => project.toLowerCase() === "memhub"));
  assert.ok(discoveredArchitectureProjects.some((project) => project.toLowerCase() === "beta"));
  assert.equal(discoveredArchitectureProjects.some((project) => project.toLowerCase() === "docs"), false);
  const currentDocs = await architectureReader.getProjectArchitecture({
    accountId: "acct-test",
    projectId: "memhub",
    query: "L1 L2 L3 L4 scope"
  });
  assert.ok(currentDocs.some((item) => /Memhub Current Architecture/.test(item.content)));
  assert.ok(currentDocs.some((item) => item.provenance?.format === "project-docs"));
  const betaDocs = await architectureReader.getProjectArchitecture({
    accountId: "acct-test",
    projectId: "beta",
    query: "canonical managed architecture"
  });
  assert.ok(betaDocs.some((item) => /Memhub-managed architecture is canonical/.test(item.content)));
  assert.ok(betaDocs.every((item) => item.provenance?.format === "managed-project-doc"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpEntry, "--account", "acct-test", "--memory-url", `http://127.0.0.1:${memoryPort}`, "--state-root", stateRoot, "--normify-root", root],
    env: { ...process.env },
    stderr: "pipe"
  });
  const client = new Client({ name: "memhub-stdio-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    await exerciseClient(client, "stdio-chat", stateRoot);
    await exerciseArchitectureGovernance(client, stateRoot);
  } finally {
    await client.close();
  }
}

async function exerciseArchitectureGovernance(client, stateRoot) {
  const before = JSON.parse((await client.callTool({
    name: "memmy_project",
    arguments: { action: "architecture", project: "memhub", workspace_project: "memhub", query: "L1 L2 L3 L4" }
  })).content[0].text);
  assert.ok(before.architecture.some((item) => /Memhub Current Architecture/.test(item.content)));

  const replacementA = "# Memhub Current Architecture\n\nL1 is evidence. L2 is project chronology. L3 is project durable rules. L4 is account-wide durable profile.\n";
  const replacementB = "# Memhub Current Architecture\n\nL1 preserves evidence. L2 preserves chronology. L3 preserves project rules. L4 preserves account-wide durable profile.\n";
  const currentBody = before.architecture.map((item) => item.content).join("\n");
  const replacement = currentBody.includes("L2 is project chronology") ? replacementB : replacementA;
  const plan = JSON.parse((await client.callTool({
    name: "memmy_project",
    arguments: {
      action: "architecture_plan",
      project: "memhub",
      workspace_project: "memhub",
      content: replacement
    }
  })).content[0].text);
  assert.equal(plan.status, "awaiting_user_authorization");
  assert.equal(plan.proposed_content, replacement);
  assert.match(plan.proposed_sha256, /^[0-9a-f]{64}$/);
  const executed = JSON.parse((await client.callTool({
    name: "memmy_project",
    arguments: {
      action: "architecture_execute",
      project: "memhub",
      workspace_project: "memhub",
      authorization_id: plan.authorization_id
    }
  })).content[0].text);
  assert.equal(executed.ok, true);
  assert.equal(executed.rollback_available, true);
  assert.match(executed.revision_id, /^[0-9a-f-]{36}$/i);

  const after = JSON.parse((await client.callTool({
    name: "memmy_project",
    arguments: { action: "architecture", project: "memhub", workspace_project: "memhub", query: "chronology durable rules" }
  })).content[0].text);
  assert.ok(after.architecture.some((item) => item.content.includes(replacement.split("\n\n", 2)[1].trim())));
  const history = JSON.parse((await client.callTool({
    name: "memmy_project",
    arguments: { action: "architecture_history", project: "memhub", workspace_project: "memhub" }
  })).content[0].text);
  const committedRevision = history.revisions.find((item) => item.revision_id === executed.revision_id);
  assert.equal(committedRevision?.status, "committed");
  assert.ok(committedRevision?.before_content?.trim());
  assert.notEqual(committedRevision.before_content.trim(), replacement.trim());

  const stalePlan = JSON.parse((await client.callTool({
    name: "memmy_project",
    arguments: {
      action: "architecture_plan",
      project: "memhub",
      workspace_project: "memhub",
      content: "# Memhub Current Architecture\n\nThis stale plan must never overwrite a newer file.\n"
    }
  })).content[0].text);
  await writeFile(stalePlan.path, "# Memhub Current Architecture\n\nOut-of-band change after plan.\n");
  const staleExecute = await client.callTool({
    name: "memmy_project",
    arguments: {
      action: "architecture_execute",
      project: "memhub",
      workspace_project: "memhub",
      authorization_id: stalePlan.authorization_id
    }
  });
  assert.equal(staleExecute.isError, true);
  assert.match(staleExecute.content[0].text, /changed after plan/);

  const restorePlan = JSON.parse((await client.callTool({
    name: "memmy_project",
    arguments: {
      action: "architecture_plan",
      project: "memhub",
      workspace_project: "memhub",
      content: replacement
    }
  })).content[0].text);
  const restored = JSON.parse((await client.callTool({
    name: "memmy_project",
    arguments: {
      action: "architecture_execute",
      project: "memhub",
      workspace_project: "memhub",
      authorization_id: restorePlan.authorization_id
    }
  })).content[0].text);
  assert.equal(restored.ok, true);
  assert.equal((await listArchitectureAuditFiles(stateRoot)).length >= 2, true);
}

async function listArchitectureAuditFiles(stateRoot) {
  const rootPath = join(stateRoot, "architecture-history");
  const found = [];
  async function walk(path) {
    let entries = [];
    try { entries = await readdir(path, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile() && entry.name.endsWith(".json")) found.push(next);
    }
  }
  await walk(rootPath);
  return found;
}

async function testHttp(memoryPort) {
  const port = await freePort();
  const stateRoot = join(root, "state");
  const httpEnv = { ...process.env, MEMHUB_MEMORY_DB: historyDbPath, MEMHUB_OWNER_ACCOUNT_ID: "acct-test" };
  delete httpEnv.MEMHUB_ACCOUNT_ID;
  const child = spawn(process.execPath, [
    mcpEntry,
    "--http", String(port),
    "--memory-url", `http://127.0.0.1:${memoryPort}`,
    "--state-root", stateRoot,
  ], { env: httpEnv, stdio: ["ignore", "pipe", "pipe"] });
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
      assert.ok(projects.projects.includes("alpha"));
      assert.ok(!projects.projects.some((project) => /^ws_[a-f0-9]{32,}$/i.test(project)));

      const longContext = JSON.parse((await client.callTool({
        name: "memmy_context",
        arguments: { query: "__long_context_probe__", project: "alpha", limit: 1 }
      })).content[0].text);
      const longContextItem = longContext.globalMemory.find((item) => item.id === "long-context-probe");
      assert.ok(longContextItem);
      assert.ok(Buffer.byteLength(longContextItem.content, "utf8") <= longContext.contextBudget.maxItemContentBytes);
      assert.equal(longContextItem.provenance.contextTruncated, true);
      assert.equal(longContextItem.provenance.originalContentBytes, Buffer.byteLength("界".repeat(600_000), "utf8"));
      assert.ok(longContext.contextBudget.truncatedItems >= 1);
      assert.ok(longContext.contextBudget.emittedContentBytes <= longContext.contextBudget.maxContentBytes);

      const longEvidenceProject = "long-evidence-http";
      const registry = new JsonProjectRegistry(join(stateRoot, "project-registry.json"));
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

    // Retired side-channel endpoints must stay absent. Durable turns now enter
    // exclusively through the MCP memmy_turn contract.
    for (const retiredPath of ["/memhub/capture", "/memhub/context", "/memhub/lifecycle"]) {
      const retired = await fetch(`http://127.0.0.1:${port}${retiredPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      assert.equal(retired.status, 404, `${retiredPath} must remain retired`);
    }

    const directClient = new Client({ name: "memhub-direct-turn-test", version: "1.0.0" });
    await directClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    try {
      const opened = JSON.parse((await directClient.callTool({
        name: "memmy_turn",
        arguments: { action: "open", project: "alpha", user_text: "direct MCP turn without host session identity" }
      })).content[0].text);
      assert.equal(opened.transport_conversation_id, null);
      assert.equal(opened.project_id, "alpha");
      const committed = JSON.parse((await directClient.callTool({
        name: "memmy_turn",
        arguments: { action: "commit", event_id: opened.turn.event_id, project: "alpha", assistant_text: "direct turn committed" }
      })).content[0].text);
      assert.equal(committed.turn.ingested, true);
      assert.equal(committed.project_id, "alpha");
    } finally {
      await directClient.close();
    }
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
  const packageVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  assert.equal(client.getServerVersion()?.version, packageVersion);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["memhub_branch", "memhub_distill", "memhub_memory", "memhub_result", "memhub_skill", "memhub_todo", "memmy_context", "memmy_project", "memmy_project_list", "memmy_project_manage", "memmy_turn"]);
  assert.match(listed.tools.find((tool) => tool.name === "memmy_context")?.description ?? "", /conversation_id.*不参与项目选择|不参与项目选择.*conversation_id/);
  assert.match(listed.tools.find((tool) => tool.name === "memhub_branch")?.description ?? "", /不绑定 host conversation/);
  assert.equal(Object.hasOwn(listed.tools.find((tool) => tool.name === "memhub_distill")?.inputSchema?.properties ?? {}, "conversation_id"), false);
  assert.equal(Object.hasOwn(listed.tools.find((tool) => tool.name === "memhub_todo")?.inputSchema?.properties ?? {}, "conversation_id"), false);
  assert.match(listed.tools.find((tool) => tool.name === "memhub_result")?.description ?? "", /result_id.*next_offset|next_offset.*result_id/);
  assert.match(listed.tools.find((tool) => tool.name === "memhub_memory")?.description ?? "", /Progressive-disclosure.*exact evidenceRef|exact evidenceRef.*Progressive-disclosure/);
  assert.match(listed.tools.find((tool) => tool.name === "memmy_project")?.description ?? "", /不保存 host conversation binding/);
  assert.match(listed.tools.find((tool) => tool.name === "memmy_project_list")?.description ?? "", /description.*禁止盲目新建/);
  assert.match(listed.tools.find((tool) => tool.name === "memmy_project_manage")?.description ?? "", /action=plan.*明确授权.*action=execute/);
  assert.match(listed.tools.find((tool) => tool.name === "memhub_todo")?.description ?? "", /Project Registry.*唯一事实源|唯一事实源.*Project Registry/);
  // MCP tools/list is the authoritative, schema-derived help source; do not maintain a second parameter registry.
  for (const [name, actions, required] of [
    ["memmy_project_manage", ["plan", "execute"], ["action"]],
    ["memhub_todo", ["list", "add", "complete", "reopen"], ["action"]],
    ["memhub_skill", ["load", "record", "status"], ["action", "skill_id"]],
    ["memhub_distill", ["audit", "discover", "consolidate", "recover_ingest", "reconcile_derived", "reconcile_l4", "next", "renew", "submit", "skip"], []],
    ["memhub_memory", ["load", "plan", "execute"], ["action"]],
    ["memhub_branch", ["list", "create", "close", "reopen"], ["action"]],
    ["memmy_project", ["list", "current", "architecture", "architecture_plan", "architecture_execute", "architecture_history"], ["action"]]
  ]) {
    const schema = listed.tools.find((tool) => tool.name === name)?.inputSchema;
    assert.ok(schema, `${name} must expose its live input schema`);
    for (const action of actions) assert.ok(schema.properties.action.enum.includes(action), `${name} schema must advertise ${action}`);
    assert.deepEqual(schema.required ?? [], required);
    assert.equal(schema.additionalProperties, false);
  }
  const distillHelp = listed.tools.find((tool) => tool.name === "memhub_distill").inputSchema;
  assert.equal(distillHelp.properties.event_id.type, "string");
  assert.equal(distillHelp.properties.lease_token.type, "string");
  assert.equal(distillHelp.properties.lease_token_supported.type, "boolean");
  assert.equal(distillHelp.properties.lease_seconds.minimum, 30);
  let projectList = JSON.parse((await client.callTool({ name: "memmy_project_list", arguments: { query: "ALPHA" } })).content[0].text);
  if (!projectList.projects.some((project) => project.project === "alpha")) {
    const createPlan = JSON.parse((await client.callTool({
      name: "memmy_project_manage",
      arguments: {
        action: "plan",
        operation: "create",
        project: "alpha",
        description: "ALPHA project used by MCP integration tests."
      }
    })).content[0].text);
    assert.equal(createPlan.status, "awaiting_user_authorization");
    const createResult = JSON.parse((await client.callTool({
      name: "memmy_project_manage",
      arguments: { action: "execute", authorization_id: createPlan.authorization_id }
    })).content[0].text);
    assert.equal(createResult.ok, true);
    projectList = JSON.parse((await client.callTool({ name: "memmy_project_list", arguments: { query: "ALPHA" } })).content[0].text);
  }
  assert.ok(projectList.projects.some((project) => project.project === "alpha"));
  const distillationAudit = JSON.parse((await client.callTool({
    name: "memhub_distill", arguments: { action: "audit" }
  })).content[0].text);
  assert.equal(distillationAudit.source, "read_only_durable_state");
  assert.equal(distillationAudit.account_scoped, true);
  assert.equal(projectList.matches[0]?.project, "alpha");
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
  const retrievalBranch = JSON.parse((await client.callTool({
    name: "memhub_branch",
    arguments: { action: "create", project: "alpha", name: "Retrieval", goal: "Improve semantic BM25 retrieval precision." }
  })).content[0].text).branch;
  const webBranch = JSON.parse((await client.callTool({
    name: "memhub_branch",
    arguments: { action: "create", project: "alpha", name: "Web", goal: "Finish the Control Plane web interface." }
  })).content[0].text).branch;
  await client.callTool({
    name: "memhub_branch",
    arguments: { action: "create", project: "alpha", name: "Network", goal: "Diagnose Cloudflare transport stability." }
  });
  const branchList = JSON.parse((await client.callTool({
    name: "memhub_branch",
    arguments: { action: "list", project: "alpha" }
  })).content[0].text);
  assert.equal(branchList.branches.length, 3);
  assert.ok(branchList.branches.some((branch) => branch.branchId === retrievalBranch.branchId));

  let branchContext = JSON.parse((await client.callTool({
    name: "memmy_context",
    arguments: { query: "继续", project: "alpha" }
  })).content[0].text);
  assert.equal(branchContext.branchContext, null);
  branchContext = JSON.parse((await client.callTool({
    name: "memmy_context",
    arguments: { query: "继续", project: "alpha", branch: webBranch.branchId }
  })).content[0].text);
  assert.equal(branchContext.branchContext.branchId, webBranch.branchId);
  assert.equal(branchContext.branchContext.source, "explicit");

  await client.callTool({
    name: "memhub_branch",
    arguments: { action: "close", project: "alpha", branch: webBranch.branchId }
  });
  const branchListWithClosed = JSON.parse((await client.callTool({
    name: "memhub_branch",
    arguments: { action: "list", project: "alpha", include_closed: true }
  })).content[0].text);
  assert.ok(branchListWithClosed.branches.length >= 3);
  assert.equal(branchListWithClosed.branches.find((branch) => branch.branchId === webBranch.branchId).status, "closed");
  const closedBranchContext = await client.callTool({
    name: "memmy_context",
    arguments: { query: "继续", project: "alpha", branch: webBranch.branchId }
  });
  assert.equal(closedBranchContext.isError, true);
  await client.callTool({
    name: "memhub_branch",
    arguments: { action: "reopen", project: "alpha", branch: webBranch.branchId }
  });
  const baselineTodos = JSON.parse((await client.callTool({
    name: "memhub_todo",
    arguments: { action: "list", project: "alpha", status: "all" }
  })).content[0].text);
  assert.equal(baselineTodos.project, "alpha");
  const blankTodo = await client.callTool({
    name: "memhub_todo", arguments: { action: "add", project: "alpha", text: "   " }
  });
  assert.equal(blankTodo.isError, true);
  assert.match(blankTodo.content[0].text, /text.*required|text.*non-empty/i);
  const baselinePendingCount = baselineTodos.pending_count;
  const baselineTotalCount = baselineTodos.total;
  const addedTodo = JSON.parse((await client.callTool({
    name: "memhub_todo",
    arguments: { action: "add", project: "ALPHA", text: "Verify the dedicated MCP todo lifecycle." }
  })).content[0].text);
  assert.equal(addedTodo.ok, true);
  assert.equal(addedTodo.project, "alpha");
  assert.equal(addedTodo.todo.status, "pending");
  assert.equal(addedTodo.pending_count, baselinePendingCount + 1);
  const contextWithRelevantTodo = JSON.parse((await client.callTool({
    name: "memmy_context",
    arguments: { query: "dedicated MCP todo lifecycle", project: "ALPHA" }
  })).content[0].text);
  const alphaCandidateWithTodo = contextWithRelevantTodo.projectCandidates.find((project) => project.project === "alpha");
  assert.ok(alphaCandidateWithTodo);
  assert.equal(alphaCandidateWithTodo.relevantTodos[0].id, addedTodo.todo.id);
  assert.equal(alphaCandidateWithTodo.relevantTodos.length, 1);
  assert.deepEqual(alphaCandidateWithTodo.relevantTodos[0].matchedTerms, ["dedicated", "mcp", "todo", "lifecycle"]);
  const pendingTodos = JSON.parse((await client.callTool({
    name: "memhub_todo",
    arguments: { action: "list", project: "alpha" }
  })).content[0].text);
  assert.equal(pendingTodos.pending_count, baselinePendingCount + 1);
  assert.ok(pendingTodos.todos.some((todo) => todo.id === addedTodo.todo.id));
  const allTodosAfterAdd = JSON.parse((await client.callTool({
    name: "memhub_todo",
    arguments: { action: "list", project: "alpha", status: "all" }
  })).content[0].text);
  assert.equal(allTodosAfterAdd.total, baselineTotalCount + 1);
  const completedTodo = JSON.parse((await client.callTool({
    name: "memhub_todo",
    arguments: { action: "complete", project: "alpha", todo_id: addedTodo.todo.id }
  })).content[0].text);
  assert.equal(completedTodo.todo.status, "done");
  assert.ok(completedTodo.todo.completedAt);
  assert.equal(completedTodo.pending_count, baselinePendingCount);
  const repeatedComplete = JSON.parse((await client.callTool({
    name: "memhub_todo",
    arguments: { action: "complete", project: "alpha", todo_id: addedTodo.todo.id }
  })).content[0].text);
  assert.equal(repeatedComplete.todo.completedAt, completedTodo.todo.completedAt);
  assert.equal(repeatedComplete.todo.updatedAt, completedTodo.todo.updatedAt);
  assert.equal(repeatedComplete.pending_count, baselinePendingCount);
  const reopenedTodo = JSON.parse((await client.callTool({
    name: "memhub_todo",
    arguments: { action: "reopen", project: "alpha", todo_id: addedTodo.todo.id }
  })).content[0].text);
  assert.equal(reopenedTodo.todo.status, "pending");
  assert.equal(reopenedTodo.todo.completedAt, undefined);
  assert.equal(reopenedTodo.pending_count, baselinePendingCount + 1);
  const accountTodos = JSON.parse((await client.callTool({
    name: "memhub_todo",
    arguments: { action: "list" }
  })).content[0].text);
  assert.equal(accountTodos.scope, "account");
  assert.ok(accountTodos.projects.some((project) => project.project === "alpha" && project.todos.some((todo) => todo.id === addedTodo.todo.id)));
  const projectListWithTodo = JSON.parse((await client.callTool({ name: "memmy_project_list", arguments: { query: "ALPHA" } })).content[0].text);
  assert.equal(projectListWithTodo.projects.find((project) => project.project === "alpha")?.pendingTodoCount, baselinePendingCount + 1);
  const currentWithoutConversation = JSON.parse((await client.callTool({
    name: "memmy_project",
    arguments: { action: "current" }
  })).content[0].text);
  assert.equal(currentWithoutConversation.project, null);
  assert.equal(currentWithoutConversation.resolution_source, "no_current_turn_project");
  const currentExplicitWithoutConversation = JSON.parse((await client.callTool({
    name: "memmy_project",
    arguments: { action: "current", project: "ALPHA" }
  })).content[0].text);
  assert.equal(currentExplicitWithoutConversation.project, "alpha");
  assert.equal(currentExplicitWithoutConversation.resolution_source, "explicit_project");
  assert.equal(currentExplicitWithoutConversation.persisted, false);
  const currentWorkspaceWithoutConversation = JSON.parse((await client.callTool({
    name: "memmy_project",
    arguments: { action: "current", workspace_project: "ALPHA" }
  })).content[0].text);
  assert.equal(currentWorkspaceWithoutConversation.project, "alpha");
  assert.equal(currentWorkspaceWithoutConversation.resolution_source, "workspace_project");
  const conflictingTodoScope = await client.callTool({
    name: "memhub_todo",
    arguments: {
      action: "add",
      project: "alpha",
      workspace_project: "memhub",
      text: "This conflicting scope must never be written."
    }
  });
  assert.equal(conflictingTodoScope.isError, true);
  assert.match(conflictingTodoScope.content[0].text, /project\/workspace conflict/);
  const unresolved = JSON.parse((await client.callTool({
    name: "memmy_context",
    arguments: { query: "continue the ALPHAE work", project: "alphae", conversation_id: conversationId + "-unknown" }
  })).content[0].text);
  assert.equal(unresolved.resolvedProjectId, null);
  assert.equal(unresolved.recallScope, "global_only");
  assert.ok(unresolved.projectCandidates.some((project) => project.project === "alpha"));
  assert.ok(unresolved.projectCandidates.every((project) => project.relevantTodos === undefined));
  const unchangedUpdate = await client.callTool({
    name: "memmy_project_manage",
    arguments: { action: "plan", operation: "update", project: "alpha", name: projectList.projects.find((item) => item.project === "alpha").name }
  });
  assert.equal(unchangedUpdate.isError, true);
  assert.match(unchangedUpdate.content[0].text, /no effective changes/);
  const invalidAliases = await client.callTool({
    name: "memmy_project_manage",
    arguments: { action: "plan", operation: "update", project: "alpha", aliases: ["valid", 42] }
  });
  assert.equal(invalidAliases.isError, true);
  const blankAlias = await client.callTool({
    name: "memmy_project_manage",
    arguments: { action: "plan", operation: "update", project: "alpha", aliases: ["valid", ""] }
  });
  assert.equal(blankAlias.isError, true);
  assert.match(blankAlias.content[0].text, /aliases must contain only non-empty strings/);
  const updatedDescription = projectList.projects.find((item) => item.project === "alpha").description ===
    "ALPHA project used by MCP integration tests (verified)."
    ? "ALPHA project used by MCP integration tests (reverified)."
    : "ALPHA project used by MCP integration tests (verified).";
  const updatePlanResult = await client.callTool({
    name: "memmy_project_manage",
    arguments: {
      action: "plan",
      operation: "update",
      project: "alpha",
      description: updatedDescription
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
  const updatedList = JSON.parse((await client.callTool({ name: "memmy_project_list", arguments: { query: "alpha" } })).content[0].text);
  assert.match(updatedList.projects.find((project) => project.project === "alpha")?.description ?? "", /integration tests/);
  const context = await client.callTool({ name: "memmy_context", arguments: { query: "continue", conversation_id: conversationId } });
  const capsule = JSON.parse(context.content[0].text);
  assert.equal(capsule.resolvedProjectId, null);
  assert.equal(capsule.globalMemory.length, 1);
  assert.equal(capsule.projectMemory.length, 0);
  const explicitContext = JSON.parse((await client.callTool({
    name: "memmy_context",
    arguments: { query: "continue", project: "alpha", workspace_project: "alpha", conversation_id: conversationId }
  })).content[0].text);
  assert.equal(explicitContext.resolvedProjectId, "alpha");
  assert.equal(explicitContext.projectMemory.length, 1);
  if (conversationId === "stdio-chat") {
    assert.ok(explicitContext.projectArchitecture.some((item) => /ALPHA Core Architecture/.test(item.content)));
    const architecture = JSON.parse((await client.callTool({
      name: "memmy_project",
      arguments: { action: "architecture", project: "alpha", query: "broker workspace ownership" }
    })).content[0].text);
    assert.equal(architecture.project, "alpha");
    assert.ok(architecture.architecture.some((item) => /Broker routes work/.test(item.content)));
  }
  const openedTurn = JSON.parse((await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "open",
      conversation_id: conversationId,
      continuity_id: conversationId,
      turn_id: `source-${conversationId}`,
      project: "alpha",
      user_text: "Keep this original user message in L1."
    }
  })).content[0].text);
  assert.equal(openedTurn.turn.status, "open");
  assert.equal(openedTurn.turn.project_hint, "alpha");
  const l1EventId = openedTurn.turn.event_id;
  await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "checkpoint",
      event_id: l1EventId,
      conversation_id: conversationId,
      continuity_id: conversationId,
      turn_id: `source-${conversationId}`,
      reasoning_summary: "Validated the explicit project scope and memory boundary."
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
      reasoning_summary: "Validated the explicit project scope, memory boundary, and lifecycle update semantics.",
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
      project: "alpha",
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
      project: "alpha",
      user_text: "Capture this turn even when the transport exposes no conversation id."
    }
  })).content[0].text);
  assert.equal(unboundOpen.transport_conversation_id, null);
  assert.match(unboundOpen.turn.conversation_id, /^memhub-unbound:l1_/);
  assert.equal(unboundOpen.turn.project_hint, "alpha");
  const unboundEventId = unboundOpen.turn.event_id;
  const unboundCommit = JSON.parse((await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "commit",
      event_id: unboundEventId,
      assistant_text: "The unbound transport turn still reaches complete L1 safely."
    }
  })).content[0].text);
  assert.equal(unboundCommit.turn.event_id, unboundEventId);
  assert.equal(unboundCommit.turn.status, "complete");
  assert.equal(unboundCommit.turn.ingested, true);
  assert.equal(unboundCommit.project_id, "alpha");
  const colonEventId = `codex:${conversationId}:colon-turn`;
  await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "open",
      event_id: colonEventId,
      conversation_id: conversationId,
      continuity_id: conversationId,
      project: "alpha",
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
      project: "alpha",
      content: "Colon-bearing L1 evidence is accepted without truncating its event id.",
      evidence_refs: [`l1:${colonEventId}`],
      dry_run: true
    }
  });
  assert.equal(JSON.parse(colonEvidenceDryRun.content[0].text).dryRun, true);
  const invalidResume = await client.callTool({ name: "memmy_turn", arguments: { action: "resume" } });
  assert.equal(invalidResume.isError, true);
  assert.match(invalidResume.content[0].text, /resume requires continuity_id or conversation_id/);

  const continuityContext = JSON.parse((await client.callTool({
    name: "memmy_context",
    arguments: { query: "continue", conversation_id: conversationId, continuity_id: conversationId }
  })).content[0].text);
  assert.equal(continuityContext.resolvedProjectId, null);

  const contractResult = await client.callTool({
    name: "memhub_distill",
    arguments: { inspect_contract: true }
  });
  const contractPayload = JSON.parse(contractResult.content[0].text);
  assert.equal(contractPayload.contract.version, "memhub-distill-v3");
  assert.equal(contractPayload.contract.executor, "connected_mcp_or_harness_model");

  const golden = await exerciseGoldenDistillationChain(client, stateRoot, conversationId, l1EventId);
  const writesBeforeDryRun = requests.filter((entry) => entry.url === "/api/v1/memory/add").length;
  const dryRun = await client.callTool({
    name: "memhub_distill",
    arguments: {
      kind: "l4",
      scope: "account",
      content: "Durable cross-project evidence-backed user profile candidate.",
      evidence_refs: [golden.alphaL3Ref, golden.betaL3Ref],
      dry_run: true
    }
  });
  assert.equal(JSON.parse(dryRun.content[0].text).dryRun, true);
  assert.equal(requests.filter((entry) => entry.url === "/api/v1/memory/add").length, writesBeforeDryRun);

  const exactContext = JSON.parse((await client.callTool({
    name: "memmy_context",
    arguments: { query: "__exact_evidence_ref_probe__", project: "alpha" }
  })).content[0].text);
  const exactL2 = exactContext.projectMemory.find((item) => item.id === golden.alphaL2Id);
  assert.ok(exactL2);
  assert.equal(exactL2.evidenceRef, golden.alphaL2Ref);
  assert.equal(exactL2.provenance.hydration.tool, "memhub_memory");
  assert.equal(exactContext.progressiveDisclosure.discover, "memmy_context");
  const hydratedL2 = JSON.parse((await client.callTool({
    name: "memhub_memory",
    arguments: { action: "load", evidence_ref: exactL2.evidenceRef }
  })).content[0].text);
  assert.equal(hydratedL2.item.evidence_ref, golden.alphaL2Ref);
  assert.equal(hydratedL2.item.layer, "L2");
  assert.match(hydratedL2.item.content, /ALPHA/);
  assert.equal(hydratedL2.telemetry.hydrations, 1);

  const governedL3Content = "# ALPHA Project Rules\n\n- Validate current state before modifying project truth.\n- Preserve explicit project and workspace boundaries.\n- User-confirmed rules replace the canonical L3 only after full-text approval.\n";
  const governedL3Plan = JSON.parse((await client.callTool({
    name: "memhub_memory",
    arguments: {
      action: "plan",
      kind: "l3",
      project: "alpha",
      workspace_project: "alpha",
      base_evidence_ref: golden.alphaL3Ref,
      content: governedL3Content,
      note: "User explicitly requested a new project rule."
    }
  })).content[0].text);
  assert.equal(governedL3Plan.status, "awaiting_user_authorization");
  assert.equal(governedL3Plan.proposed_content, governedL3Content);
  assert.equal(governedL3Plan.current_evidence_ref, golden.alphaL3Ref);
  assert.ok(governedL3Plan.instructions.some((line) => /Show proposed_content.*in full/i.test(line)));
  const l3Confirmation = JSON.parse((await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "open",
      conversation_id: `${conversationId}-l3-confirmation`,
      continuity_id: `${conversationId}-l3-confirmation`,
      project: "alpha",
      user_text: "Yes. Write the exact full L3 replacement you just showed me."
    }
  })).content[0].text);
  const governedL3 = JSON.parse((await client.callTool({
    name: "memhub_memory",
    arguments: {
      action: "execute",
      authorization_id: governedL3Plan.authorization_id,
      confirmation_evidence_ref: `l1:${l3Confirmation.turn.event_id}`
    }
  })).content[0].text);
  assert.equal(governedL3.ok, true);
  assert.equal(governedL3.kind, "l3");
  assert.equal(governedL3.project, "alpha");
  assert.equal(governedL3.derived_jobs_enqueued, 0);
  assert.match(governedL3.result_evidence_ref, /^l3:[^:]+:[^:]+$/);
  await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "commit",
      event_id: l3Confirmation.turn.event_id,
      conversation_id: `${conversationId}-l3-confirmation`,
      continuity_id: `${conversationId}-l3-confirmation`,
      assistant_text: "The explicitly approved full L3 replacement was committed."
    }
  });
  const governedL3Hydrated = JSON.parse((await client.callTool({
    name: "memhub_memory",
    arguments: { action: "load", evidence_ref: governedL3.result_evidence_ref }
  })).content[0].text);
  assert.equal(governedL3Hydrated.item.content.trim(), governedL3Content.trim());

  const governedL4Content = "# Cross-project User Profile\n\n- When the user explicitly declares a cross-project rule, show the complete new L4 text before writing it.\n- Only commit after explicit approval of that exact full replacement.\n";
  const governedL4Plan = JSON.parse((await client.callTool({
    name: "memhub_memory",
    arguments: {
      action: "plan",
      kind: "l4",
      base_evidence_ref: golden.l4Ref,
      content: governedL4Content,
      note: "User explicitly requested an account-wide rule."
    }
  })).content[0].text);
  assert.equal(governedL4Plan.current_evidence_ref, golden.l4Ref);
  const l4Confirmation = JSON.parse((await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "open",
      conversation_id: `${conversationId}-l4-confirmation`,
      continuity_id: `${conversationId}-l4-confirmation`,
      project: "alpha",
      user_text: "Confirmed. Write exactly that full L4 replacement."
    }
  })).content[0].text);
  const governedL4 = JSON.parse((await client.callTool({
    name: "memhub_memory",
    arguments: {
      action: "execute",
      authorization_id: governedL4Plan.authorization_id,
      confirmation_evidence_ref: `l1:${l4Confirmation.turn.event_id}`
    }
  })).content[0].text);
  assert.equal(governedL4.ok, true);
  assert.equal(governedL4.kind, "l4");
  assert.equal(governedL4.project, null);
  assert.equal(governedL4.derived_jobs_enqueued, 0);
  await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "commit",
      event_id: l4Confirmation.turn.event_id,
      conversation_id: `${conversationId}-l4-confirmation`,
      continuity_id: `${conversationId}-l4-confirmation`,
      assistant_text: "The explicitly approved full L4 replacement was committed."
    }
  });
  const governedL4Hydrated = JSON.parse((await client.callTool({
    name: "memhub_memory",
    arguments: { action: "load", evidence_ref: governedL4.result_evidence_ref }
  })).content[0].text);
  assert.equal(governedL4Hydrated.item.content.trim(), governedL4Content.trim());

  const staleGovernedPlan = JSON.parse((await client.callTool({
    name: "memhub_memory",
    arguments: {
      action: "plan",
      kind: "l3",
      project: "alpha",
      workspace_project: "alpha",
      base_evidence_ref: governedL3.result_evidence_ref,
      content: "# ALPHA Project Rules\n\nThis stale proposal must not overwrite a newer canonical L3.\n"
    }
  })).content[0].text);
  const concurrentL3 = JSON.parse((await client.callTool({
    name: "memhub_distill",
    arguments: {
      kind: "l3",
      scope: "project",
      project: "alpha",
      content: "# ALPHA Project Rules\n\nA concurrent canonical L3 update happened after the governed plan.\n",
      evidence_refs: [golden.alphaL2Ref],
      source_harness: "concurrent-update-test"
    }
  })).content[0].text);
  assert.match(concurrentL3.result_evidence_ref, /^l3:[^:]+:[^:]+$/);
  const staleConfirmation = JSON.parse((await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "open",
      conversation_id: `${conversationId}-stale-l3-confirmation`,
      continuity_id: `${conversationId}-stale-l3-confirmation`,
      project: "alpha",
      user_text: "Confirm the stale plan."
    }
  })).content[0].text);
  const staleGovernedExecute = await client.callTool({
    name: "memhub_memory",
    arguments: {
      action: "execute",
      authorization_id: staleGovernedPlan.authorization_id,
      confirmation_evidence_ref: `l1:${staleConfirmation.turn.event_id}`
    }
  });
  assert.equal(staleGovernedExecute.isError, true);
  assert.match(staleGovernedExecute.content[0].text, /changed after plan/);

  const stableRefRejected = await client.callTool({
    name: "memhub_distill",
    arguments: {
      kind: "l3",
      scope: "project",
      project: "alpha",
      content: "A mutable stable Memory id must not be accepted as exact L2 evidence.",
      evidence_refs: [`l2:${golden.alphaL2Id}`],
      dry_run: true
    }
  });
  assert.equal(stableRefRejected.isError, true);
  assert.match(stableRefRejected.content[0].text, /MEMHUB_EVIDENCE_REF_INVALID/);
  assert.match(stableRefRejected.content[0].text, /memmy_context/);

  const directL3 = JSON.parse((await client.callTool({
    name: "memhub_distill",
    arguments: {
      kind: "l3",
      scope: "project",
      project: "alpha",
      artifact_id: `direct-ledger-${conversationId}`,
      content: "Direct manual L3 writes also leave an immutable completed revision ledger.",
      evidence_refs: [golden.alphaL2Ref],
      source_harness: "direct-ledger-test"
    }
  })).content[0].text);
  assert.match(directL3.result_evidence_ref, new RegExp(`^l3:${directL3.memory.id}:[^:]+$`));
  const directL4DryRun = JSON.parse((await client.callTool({
    name: "memhub_distill",
    arguments: {
      kind: "l4",
      scope: "account",
      content: "Direct revision refs remain valid immutable evidence for downstream synthesis.",
      evidence_refs: [directL3.result_evidence_ref, golden.betaL3Ref],
      dry_run: true
    }
  })).content[0].text);
  assert.equal(directL4DryRun.dryRun, true);

  const invalidDryRun = await client.callTool({
    name: "memhub_distill",
    arguments: {
      kind: "l3",
      scope: "project",
      project: "alpha",
      content: "This must not validate against invented evidence.",
      evidence_refs: ["l2:not-a-real-memory"],
      dry_run: true
    }
  });
  assert.equal(invalidDryRun.isError, true);
  assert.match(invalidDryRun.content[0].text, /MEMHUB_EVIDENCE_REF_INVALID/);

  const otherAccountEvidenceId = `other-account-l2-${conversationId}`;
  memoryById.set(otherAccountEvidenceId, {
    id: otherAccountEvidenceId,
    memoryLayer: "L2",
    status: "activated",
    title: "Other account timeline",
    summary: "Must never be accepted as current-account evidence.",
    body: "Must never be accepted as current-account evidence.",
    tags: ["artifact:l2", "project:alpha"],
    namespace: { tenantId: "acct-other", userId: "acct_other_user", projectId: "alpha" },
    version: 1
  });
  const otherAccountRevision = await recordCompletedDistillationRevision({
    stateRoot,
    accountId: "acct-other",
    target: "l2",
    projectId: "alpha",
    conversationId: "other-account-conversation",
    evidence: [{
      ref: "l1:other-account-turn",
      kind: "turn",
      layer: "L1",
      timestamp: new Date().toISOString(),
      project_id: "alpha",
      conversation_id: "other-account-conversation",
      user_text: "other account user",
      assistant_text: "other account assistant"
    }],
    resultId: otherAccountEvidenceId,
    content: "Must never be accepted as current-account evidence.",
    committedAt: new Date().toISOString()
  });
  const crossAccountEvidence = await client.callTool({
    name: "memhub_distill",
    arguments: {
      kind: "l3",
      scope: "project",
      project: "alpha",
      content: "This must not validate against another account's L2.",
      evidence_refs: [`l2:${otherAccountEvidenceId}:${otherAccountRevision.job_id}`],
      dry_run: true
    }
  });
  assert.equal(crossAccountEvidence.isError, true);
  assert.match(crossAccountEvidence.content[0].text, /MEMHUB_EVIDENCE_REF_INVALID/);

  const missingSkillIdentity = await client.callTool({
    name: "memhub_distill",
    arguments: {
      kind: "skill", scope: "project", project: "alpha",
      title: "ALPHA unstable skill", content: "Reusable procedure", version: "1.0.0", dry_run: true
    }
  });
  assert.equal(missingSkillIdentity.isError, true);
  assert.match(missingSkillIdentity.content[0].text, /artifact_id is required for Skill distillation/);
  const invalidSkillVersion = await client.callTool({
    name: "memhub_distill",
    arguments: {
      kind: "skill", scope: "project", project: "alpha",
      title: "ALPHA unstable skill", content: "Reusable procedure", artifact_id: "alpha-unstable",
      version: "1.0-retracted", dry_run: true
    }
  });
  assert.equal(invalidSkillVersion.isError, true);
  assert.match(invalidSkillVersion.content[0].text, /numeric dotted/);

  const reconnectArtifactId = `alpha-reconnect-${conversationId}`;
  await client.callTool({
    name: "memhub_distill",
    arguments: {
      kind: "skill",
      scope: "project",
      project: "alpha",
      title: "ALPHA reconnect workflow",
      content: "Use this when ALPHA reconnect fails. Inspect state, repair the MCP route, then verify reconnection.",
      source_harness: "codex",
      artifact_id: reconnectArtifactId,
      version: "1.0.0",
      evidence_refs: ["l1:test-turn"],
      source_conversations: [conversationId],
      confidence: 0.9
    }
  });
  const skillWrite = [...requests].reverse().find((entry) => entry.url === "/api/v1/memory/add");
  assert.equal(skillWrite.body.layer, "Skill");
  assert.equal(skillWrite.body.namespace.projectId, "alpha");
  assert.equal(skillWrite.body.namespace.tenantId, "acct-test");
  assert.equal(skillWrite.body.sourceAgentId, "codex");
  assert.equal(skillWrite.body.sourceSkillId, reconnectArtifactId);
  assert.equal(skillWrite.body.sourceSkillVersion, "1.0.0");
  assert.ok(skillWrite.body.tags.includes("artifact:skill"));
  assert.ok(skillWrite.body.tags.includes("project:alpha"));
  assert.ok(skillWrite.body.tags.includes("distill-contract:memhub-distill-v3"));
  assert.ok(skillWrite.body.tags.includes("evidence:l1:test-turn"));
  assert.ok(skillWrite.body.tags.includes(`source-conversation:${conversationId}`));
  assert.equal(typeof skillWrite.body.requestId, "string");

  const skillRecord = [...memoryById.values()].find((item) => item.memoryLayer === "Skill" &&
    item.title === "ALPHA reconnect workflow" &&
    item.metadata?.properties?.internal_info?.source_skill_id === reconnectArtifactId);
  assert.ok(skillRecord);
  const loadedSkill = JSON.parse((await client.callTool({
    name: "memhub_skill",
    arguments: { action: "load", skill_id: skillRecord.id, executor: "codex" }
  })).content[0].text);
  assert.equal(loadedSkill.skill_id, skillRecord.id);
  assert.equal(typeof loadedSkill.execution_id, "string");
  assert.match(loadedSkill.content, /repair the MCP route/);
  assert.equal(loadedSkill.metadata.loadRequired, true);
  assert.equal(loadedSkill.metadata.scope, "project:alpha");

  const invalidSkillRecord = await client.callTool({
    name: "memhub_skill", arguments: { action: "record", skill_id: skillRecord.id, stage: "success" }
  });
  assert.equal(invalidSkillRecord.isError, true);
  assert.match(invalidSkillRecord.content[0].text, /execution_id/);

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

  const revisionContent = `# ALPHA reconnect workflow\n\n## When to use\nWhen ALPHA reconnect fails.\n\n## Procedure\nRead the current project state, repair the bridge, and verify reconnection with a real MCP round trip. Never infer success from a local build alone.`;
  const plan = JSON.parse((await client.callTool({
    name: "memhub_skill",
    arguments: {
      action: "plan", operation: "revise", skill_id: skillRecord.id,
      version: "2.0.0", content: revisionContent, title: "ALPHA reconnect workflow",
      tags: ["reconnect", "reusable"], note: "replace stale reconnect checks"
    }
  })).content[0].text);
  assert.equal(plan.status, "awaiting_user_authorization");
  assert.ok(Date.parse(plan.expires_at) - Date.now() > 23 * 60 * 60_000);
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
  assert.equal(revisedWrite.body.namespace.projectId, "alpha");
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

async function exerciseGoldenDistillationChain(client, stateRoot, conversationId, alphaL1EventId) {
  const harnessA = `golden-a-${conversationId}`;
  const harnessB = `golden-b-${conversationId}`;
  const harnessGlobal = `golden-global-${conversationId}`;
  const parseTool = (result) => JSON.parse(result.content[0].text);

  const captures = await listCaptureEvents(stateRoot, "acct-test");
  const alphaCapture = captures.find((item) => item.event_id === alphaL1EventId);
  assert.ok(alphaCapture);
  const alphaQueued = await enqueueDistillationJob({
    stateRoot,
    accountId: "acct-test",
    projectId: "alpha",
    captures: [alphaCapture],
    reason: "manual"
  });
  assert.equal(alphaQueued.created, true);
  const alphaNext = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: { action: "next", kind: "l2", scope: "project", project: "alpha", source_harness: harnessA, lease_token_supported: true }
  }));
  assert.equal(alphaNext.job.job_id, alphaQueued.job.job_id);
  assert.ok(alphaNext.job.lease_token);
  const missingToken = await client.callTool({
    name: "memhub_distill",
    arguments: { action: "next", job_id: alphaNext.job.job_id, source_harness: harnessA }
  });
  assert.equal(missingToken.isError, true);
  assert.match(missingToken.content[0].text, /lease token is missing or stale/i);
  const renewed = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: { action: "renew", job_id: alphaNext.job.job_id, source_harness: harnessA, lease_token: alphaNext.job.lease_token, lease_seconds: 600 }
  }));
  assert.equal(renewed.lease_token, alphaNext.job.lease_token);
  const wrongOwner = await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: alphaNext.job.job_id,
      content: "This write must be rejected before reaching Memory Core.",
      source_harness: "wrong-harness"
    }
  });
  assert.equal(wrongOwner.isError, true);
  assert.match(wrongOwner.content[0].text, /leased by another harness/i);
  const alphaL2V1 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: alphaNext.job.job_id,
      content: "ALPHA timeline v1: the project binding was validated before memory changes.",
      project_description: "ALPHA is an AI development environment focused on project-scoped orchestration and safe routing of work between harnesses.",
      source_harness: harnessA,
      lease_token: alphaNext.job.lease_token
    }
  }));
  assert.equal(alphaL2V1.kind, "l2");
  assert.equal(alphaL2V1.next_layer_job.job.target, "l3");
  const derivedDryRun = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "reconcile_derived",
      job_id: alphaNext.job.job_id,
      project: "alpha"
    }
  }));
  assert.equal(derivedDryRun.dry_run, true, "reconcile_derived must default to read-only");
  assert.equal(derivedDryRun.already_queued, true);
  assert.equal(derivedDryRun.derived_job_id, alphaL2V1.next_layer_job.job.job_id);
  const foreignRepair = await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "reconcile_derived",
      job_id: alphaNext.job.job_id,
      project: "nonexistent-project",
      dry_run: false
    }
  });
  assert.equal(foreignRepair.isError, true, "foreign or unknown projects cannot repair another project's queue");
  const missingRepairProject = await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "reconcile_derived",
      job_id: alphaNext.job.job_id,
      dry_run: false
    }
  });
  assert.equal(missingRepairProject.isError, true, "repair requires an explicit project");
  const alphaAfterDistilledDescription = parseTool(await client.callTool({
    name: "memmy_project_list",
    arguments: { query: "alpha" }
  })).projects.find((project) => project.project === "alpha");
  assert.ok(alphaAfterDistilledDescription);
  assert.match(alphaAfterDistilledDescription.description, /^ALPHA project used by MCP integration tests \((?:re)?verified\)\.$/);
  assert.equal(alphaAfterDistilledDescription.descriptionSource, "manual");
  assert.match(alphaAfterDistilledDescription.distilledDescription, /AI development environment focused on project-scoped orchestration/);
  const alphaL2Id = alphaL2V1.memory.id;
  const alphaL2WriteV1 = [...requests].reverse().find((entry) =>
    entry.url === "/api/v1/memory/add" && entry.body?.layer === "L2" && entry.body?.namespace?.projectId === "alpha"
  );
  assert.ok(alphaL2WriteV1);

  const alphaL3Next = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: { action: "next", kind: "l3", scope: "project", project: "alpha", source_harness: harnessA }
  }));
  const alphaL3V1 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: alphaL3Next.job.job_id,
      content: "Within ALPHA, validate current state before changing deployment or routing configuration.",
      source_harness: harnessA
    }
  }));
  assert.equal(alphaL3V1.kind, "l3");
  const alphaL3Id = alphaL3V1.memory.id;

  const betaProject = `beta-${conversationId}`;
  const betaExists = parseTool(await client.callTool({
    name: "memmy_project_list",
    arguments: { query: betaProject, include_inactive: true }
  })).projects.some((project) => project.project === betaProject);
  if (!betaExists) {
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
    assert.ok(Date.parse(createBetaPlan.expires_at) - Date.now() > 23 * 60 * 60_000);
    assert.equal(parseTool(await client.callTool({
      name: "memmy_project_manage",
      arguments: { action: "execute", authorization_id: createBetaPlan.authorization_id }
    })).ok, true);
  }

  const betaConversation = `${conversationId}-beta`;
  const betaOpen = parseTool(await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "open",
      conversation_id: betaConversation,
      continuity_id: betaConversation,
      turn_id: `source-${betaConversation}`,
      project: betaProject,
      user_text: "Keep the second project evidence isolated from ALPHA."
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
  const l4RepairDryRun = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "reconcile_l4",
      job_id: betaL3Next.job.job_id
    }
  }));
  assert.equal(l4RepairDryRun.dry_run, true, "reconcile_l4 must default to read-only");
  assert.equal(l4RepairDryRun.already_queued, true);
  assert.equal(l4RepairDryRun.derived_job_id, betaL3.next_layer_job.job.job_id);
  assert.equal(l4RepairDryRun.current_projects.length, 2);
  assert.equal(l4RepairDryRun.core_replayed, false);

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

  const alphaOpenV2 = parseTool(await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "open",
      conversation_id: conversationId,
      continuity_id: conversationId,
      turn_id: `source-${conversationId}-v2`,
      user_text: "Update ALPHA with a second durable decision."
    }
  }));
  await client.callTool({
    name: "memmy_turn",
    arguments: {
      action: "commit",
      event_id: alphaOpenV2.turn.event_id,
      conversation_id: conversationId,
      continuity_id: conversationId,
      turn_id: `source-${conversationId}-v2`,
      assistant_text: "The second decision is now part of ALPHA current truth."
    }
  });
  const alphaCaptureV2 = (await listCaptureEvents(stateRoot, "acct-test")).find((item) => item.event_id === alphaOpenV2.turn.event_id);
  assert.ok(alphaCaptureV2);
  const alphaQueuedV2 = await enqueueDistillationJob({
    stateRoot,
    accountId: "acct-test",
    projectId: "alpha",
    conversationId,
    captures: [alphaCaptureV2],
    reason: "manual"
  });
  const alphaL2NextV2 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: { action: "next", kind: "l2", scope: "project", project: "alpha", source_harness: harnessA }
  }));
  assert.equal(alphaL2NextV2.job.job_id, alphaQueuedV2.job.job_id);
  const alphaL2V2 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: alphaL2NextV2.job.job_id,
      content: "ALPHA timeline v2: preserve the original validation decision and append the second durable decision as current truth.",
      project_description: "ALPHA coordinates project-aware AI development work while preserving explicit workspace ownership, routing boundaries, and durable current state.",
      source_harness: harnessA
    }
  }));
  assert.equal(alphaL2V2.memory.id, alphaL2Id);
  const alphaL2Writes = requests.filter((entry) =>
    entry.url === "/api/v1/memory/add" && entry.body?.layer === "L2" && entry.body?.namespace?.projectId === "alpha"
  );
  const alphaL2WriteV2 = alphaL2Writes.at(-1);
  assert.notEqual(alphaL2WriteV1.body.requestId, alphaL2WriteV2.body.requestId);

  const alphaL3NextV2 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: { action: "next", kind: "l3", scope: "project", project: "alpha", source_harness: harnessA }
  }));
  const alphaL3V2 = parseTool(await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "submit",
      job_id: alphaL3NextV2.job.job_id,
      content: "Within ALPHA, validate current state first and preserve durable decisions as the project evolves.",
      source_harness: harnessA
    }
  }));
  assert.equal(alphaL3V2.memory.id, alphaL3Id);
  assert.equal(alphaL3V2.next_layer_job.job.target, "l4");
  const staleL4Repair = await client.callTool({
    name: "memhub_distill",
    arguments: {
      action: "reconcile_l4",
      job_id: alphaL3Next.job.job_id,
      dry_run: false
    }
  });
  assert.equal(staleL4Repair.isError, true,
    "an older project L3 cannot authorize the current account L4 evidence set");
  assert.match(staleL4Repair.content[0].text, /not the current latest result/i);

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

  return {
    alphaL2Id,
    alphaL2Ref: alphaL2V2.result_evidence_ref,
    alphaL3Id,
    alphaL3Ref: alphaL3V2.result_evidence_ref,
    betaL3Id,
    betaL3Ref: betaL3.result_evidence_ref,
    l4Id: l4V2.memory.id,
    l4Ref: l4V2.result_evidence_ref
  };
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
