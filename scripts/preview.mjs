import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
// 实际 UI 类 + 最小模拟宿主。全部业务 I/O 被替换为内存夹具，绝不读取真实安装。
const dir = await import("node:fs/promises").then((fs) =>
  fs.mkdtemp(path.join(os.tmpdir(), "ielts-preview-")),
);
const entry = `import {DashboardView} from '${path.resolve("src/features/dashboard-view.ts").replaceAll("\\", "/")}';import {HelperSettings} from '${path.resolve("src/ui/settings-tab.ts").replaceAll("\\", "/")}';
const files=[{path:'0-IELTS/02-Areas/Reading/Reviews/阅读复盘.md',name:'阅读复盘.md',text:'---\\ndate: '+new Date().toISOString().slice(0,10)+'\\nscore: 9/13\\nquestion_types: [TFNG, Matching]\\n---\\n#error/synonym #error/logic #error/rush'},{path:'0-IELTS/02-Areas/Listening/Reviews/听力复盘.md',name:'听力复盘.md',text:'---\\ndate: '+new Date().toISOString().slice(0,10)+'\\nscore: 8/10\\npassage: P1\\n---\\n#spelling #missed #paraphrase'}];
const app={vault:{getMarkdownFiles:()=>files,cachedRead:async f=>f.text},workspace:{openLinkText:async p=>{document.querySelector('#notice').textContent='已跳转：'+p;}}};
const profile={vaultRoot:'/临时/Vault',studyRoot:'/临时/Vault/0-IELTS',appRoot:'/临时/app',dataDir:'/临时/data',pythonPath:'/临时/python',port:18766,openBrowserOnStart:false,autoUpgradePlugin:false,updateSource:{mode:'local'}};
const helper={studyPrefix:()=>"0-IELTS",profile,config:{vaultRoot:profile.vaultRoot},manifest:{version:'2.0.0'},service:{version:async()=>({version:'4.0.0'}),stop:async()=>{}},api:async()=>({answer:[{week_start:'2026-11-09',accuracy:75},{week_start:'2026-11-16',accuracy:88}],original:[{week_start:'2026-11-09',accuracy:65},{week_start:'2026-11-16',accuracy:80}]}),run:async fn=>{try{await fn();}catch(e){document.querySelector('#notice').textContent=e.message;}},save:async()=>{},needService(){return this.service;},openStudy:async()=>{document.querySelector('#notice').textContent='模拟打开学习页';},checkUpdates:async()=>{},installOnline:async()=>{},installLocal:async()=>{},rollback:async()=>{},upgradePlugin:async()=>{},detectPython:async()=>({path:'/临时/python'})};
const view=new DashboardView({app,contentEl:document.querySelector('#dashboard')},helper);await view.onOpen();new HelperSettings(app,helper).display();window.fixture={view};
if(location.search.includes('dark'))for(const [k,v]of Object.entries({'--text-normal':'#dedbd4','--text-muted':'#aba79f','--background-primary':'#232522','--background-secondary':'#2c2e2b','--background-modifier-border':'#484b44','--interactive-accent':'#87b9a9'}))document.documentElement.style.setProperty(k,v);
if(location.search.includes('dark'))await view.refresh();
if(location.search.includes('settings'))document.querySelector('#dashboard').remove();
if(location.search.includes('narrow')){document.querySelector('#dashboard').remove();const settings=document.querySelector('#settings');settings.classList.add('ielts-helper-modal');const modal=document.createElement('div');modal.id='narrow-modal';Object.assign(modal.style,{width:'547px',maxWidth:'100%',padding:'20px',boxSizing:'border-box',margin:'12px auto'});settings.replaceWith(modal);modal.append(settings);for(const input of settings.querySelectorAll('input[type="text"],input:not([type])'))input.value='C:/临时初始化验收/含长路径的学习安装目录/another-very-long-directory/runtime-config.json';settings.querySelector('.setting-item-info p').textContent='C:/临时初始化验收/不带空格的超长学习目录/abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz/runtime-config.json';await new Promise(r=>setTimeout(r,100));const bounds=modal.getBoundingClientRect();const overflow=[...settings.querySelectorAll('*')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>bounds.right+1||r.left<bounds.left-1);}).map(e=>e.tagName+'.'+e.className);document.body.dataset.layout=JSON.stringify({clientWidth:modal.clientWidth,scrollWidth:modal.scrollWidth,overflow});}
if(location.search.includes('test')){try{document.querySelector('#dashboard button:nth-child(2)').click();await new Promise(r=>setTimeout(r,100));if(!document.querySelector('.ielts-helper-stats').textContent.includes('13'))throw Error('阅读筛选失败');const canvas=document.querySelector('canvas');const rect=canvas.getBoundingClientRect();canvas.dispatchEvent(new MouseEvent('click',{clientX:rect.left+140/620*rect.width,clientY:rect.top+140/280*rect.height}));if(!document.querySelector('#notice').textContent.includes('阅读复盘'))throw Error('Canvas 笔记跳转失败');const select=document.querySelector('#settings select');select.value='vps';select.dispatchEvent(new Event('change'));if(!document.querySelector('#settings').textContent.includes('VPS HTTPS 地址'))throw Error('更新源切换失败');document.body.dataset.test='通过：阅读筛选、Canvas 笔记跳转、VPS 控件切换';}catch(e){document.body.dataset.test='失败：'+e.message;}}
`;
await build({
  stdin: {
    contents: entry,
    resolveDir: process.cwd(),
    sourcefile: "preview.ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: path.join(dir, "preview.js"),
  plugins: [
    {
      name: "内存宿主",
      setup(b) {
        b.onResolve({ filter: /^obsidian$/ }, () => ({
          path: path.resolve("tests/preview-host.ts"),
        }));
        b.onResolve({ filter: /updater$/ }, () => ({
          path: "updater",
          namespace: "mock",
        }));
        b.onResolve({ filter: /machine-config$/ }, () => ({
          path: "config",
          namespace: "mock",
        }));
        b.onResolve({ filter: /resource-status$/ }, () => ({
          path: "resources",
          namespace: "mock",
        }));
        b.onResolve({ filter: /^node:/ }, (args) => ({
          path: args.path,
          namespace: "mock",
        }));
        b.onResolve({ filter: /^electron$/ }, () => ({
          path: "electron",
          namespace: "mock",
        }));
        b.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({
          contents:
            args.path === "resources"
              ? 'export async function resourceStatus(){return ["content.db","vocabulary.db","dictation.db","learning-progress.db"].map(name=>({name,present:true}))}'
              : args.path === "updater"
                ? 'export async function readInstalled(){return {version:"4.0.0",resourcesVersion:"1.2.3",previousVersion:"3.9.0"}};export async function getGcmToken(){return undefined};export async function getManifest(){return {plugin:{version:"2.1.0"},helper:{version:"4.0.0"},resources:{version:"1.2.3"}}};export const compareVersions=()=>0;'
                : args.path === "config"
                  ? 'export async function importLegacy(){throw Error("视觉夹具不读本机文件")};export function assertIsolatedPath(){}'
                  : args.path === "node:path"
                    ? 'export default {join:(...x)=>x.join("/")}'
                    : 'export const promises={access:async()=>{throw Error("视觉夹具不读本机文件")}}',
          loader: "js",
        }));
      },
    },
  ],
});
const css = await readFile("styles.css", "utf8");
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>IELTS Helper 隔离 UI 夹具</title><style>:root{--text-normal:#242424;--text-muted:#686868;--background-primary:#faf9f7;--background-secondary:#f1f0ed;--background-modifier-border:#d8d6d2;--interactive-accent:#34695f;--text-accent:#34695f;--text-success:#3d7751;--text-warning:#916819;--text-error:#aa4c41;--radius-m:8px}body{margin:0;font:15px system-ui;background:var(--background-primary);color:var(--text-normal)}button,input,select{font:inherit;border:1px solid var(--background-modifier-border);border-radius:5px;padding:6px 10px;color:inherit;background:var(--background-primary)}button{cursor:pointer}.setting-item{display:flex;gap:20px;justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--background-modifier-border)}.setting-item-info p{margin:5px 0;color:var(--text-muted);font-size:13px}.setting-item-control{display:flex;gap:8px;align-items:center}#settings{padding:24px}#notice{position:sticky;top:0;padding:10px;background:var(--background-secondary)}${css}</style><div id="notice">隔离视觉夹具 · 模拟宿主，非 Obsidian 实机</div><section id="dashboard"></section><section id="settings"></section><script type="module" src="/preview.js"></script></html>`;
await writeFile(path.join(dir, "index.html"), html);
const server = createServer(async (req, res) => {
  try {
    const file = req.url === "/preview.js" ? "preview.js" : "index.html";
    res.setHeader(
      "Content-Type",
      file.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8",
    );
    res.end(await readFile(path.join(dir, file)));
  } catch {
    res.statusCode = 500;
    res.end();
  }
});
server.listen(18769, "127.0.0.1", () =>
  console.log(
    "[" +
      new Date().toISOString() +
      "] 隔离 UI 夹具 http://127.0.0.1:18769 · " +
      dir,
  ),
);
