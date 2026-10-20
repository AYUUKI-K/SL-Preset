// Isolated local host for manual browser QA. Never loads the original preset's
// three scripts, talks to a real ST instance, or calls a model API.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { META_KEY, clone, makeBaseline } from '../src/core.mjs';

const root = new URL('../', import.meta.url);
const current = JSON.parse(await readFile(new URL('dist/preset.json', root), 'utf8'));
const next = clone(current), meta = next.extensions[META_KEY];
meta.revision++; meta.version = '5.3.2'; meta.displayName = '[MoM]✩‧₊SL 5.3.2 @NUE · 自动更新';
next.prompts[0].name = '浏览器测试 · 新版条目';
next.prompts[0].content = 'Browser fixture update: no real model calls.';
next.extensions.regex_scripts[0].scriptName = '浏览器测试 · 新版正则';
meta.baseline = await makeBaseline(next);
const text = JSON.stringify(next);
const manifest = { schema: 1, presetId: meta.presetId, version: meta.version, revision: meta.revision, displayName: meta.displayName, file: 'dist/preset.json', sha256: createHash('sha256').update(text).digest('hex'), changelog: ['测试新版名称、提示词与正则同步。', '本地模拟宿主，不运行原配套脚本。'] };
const files = new Map([[current.extensions[META_KEY].displayName, current]]);
const calls = [];
let mode = 'normal';
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SL 更新 · 本地模拟宿主</title>
<style>body{font:16px/1.6 system-ui;margin:24px;color:#eee;background:#24242a;--SmartThemeBodyColor:#eee;--SmartThemeBlurTintColor:#24242a;--SmartThemeBorderColor:#7b7c86;--SmartThemeQuoteColor:#b3c8df}body.light{color:#25272d;background:#f5f3f0;--SmartThemeBodyColor:#25272d;--SmartThemeBlurTintColor:#f5f3f0;--SmartThemeBorderColor:#85858b;--SmartThemeQuoteColor:#b3c8df}main{max-width:650px;margin:auto}select{font:inherit;width:100%;min-height:44px;margin:12px 0}button{font:inherit;padding:10px;margin:4px}iframe{display:none}</style>
<main><h1>SL 预设更新 · 本地模拟宿主</h1><p>默认自动更新，不插入更新按钮或面板。模拟生成时等待空闲，不调用真实模型。</p><label for="settings_preset_openai">预设</label><select id="settings_preset_openai"></select><button id="theme">切换深浅主题</button><button id="generate">模拟生成中 / 空闲</button><p id="result" role="status">当前：模拟 ${current.extensions[META_KEY].version}</p></main>
<script type="module">
const initial=await (await fetch('/initial')).json();
const {getPresetManager}=await import('/scripts/preset-manager.js');
const name=initial.extensions.${META_KEY}.displayName;
window.__fixture={presets:[initial],names:{[name]:0},selected:name,active:structuredClone(initial)};
window.__fixture.active.prompts[2].content='用户未保存的本地修改';
window.__fixture.active.prompt_order[0].order[0].enabled=false;
window.__fixture.active.extensions.regex_scripts[0].disabled=true;
const select=document.querySelector('select');select.add(new Option(name,'0',true,true));
function restart(){document.querySelector('iframe')?.remove();const frame=document.createElement('iframe');frame.src='/frame';document.body.append(frame)}
window.__fixture.restart=restart;window.SillyTavern={getContext:()=>({mainApi:'openai',getPresetManager,chatCompletionSettings:window.__fixture.active,getRequestHeaders:()=>({'Content-Type':'application/json'})})};
document.querySelector('#theme').onclick=()=>document.body.classList.toggle('light');
document.querySelector('#generate').onclick=()=>{document.body.dataset.generating=document.body.dataset.generating==='true'?'false':'true';document.querySelector('#generate').textContent=document.body.dataset.generating==='true'?'模拟生成中':'模拟空闲'};
select.addEventListener('change',()=>{const f=window.__fixture;f.selected=select.selectedOptions[0].textContent;f.active=structuredClone(f.presets[Number(select.value)]);restart()});restart();
</script>`;
const presetModule = `const w=window; export function getPresetManager(){const f=w.__fixture;return {
getSelectedPresetName:()=>f.selected,
getCompletionPresetByName:name=>f.presets[f.names[name]],
getPresetList:()=>({presets:f.presets,preset_names:f.names}),
getAllPresets:()=>Object.keys(f.names),
async savePreset(name,preset){const r=await w.fetch('/api/presets/save',{method:'POST',body:JSON.stringify({name,preset})});if(!r.ok)throw Error('模拟服务器保存失败');},
updateList(name,preset){let i=f.names[name];if(i===undefined){i=f.presets.length;f.presets.push(preset);f.names[name]=i;w.document.querySelector('select').add(new Option(name,String(i)));}else f.presets[i]=preset;this.selectPreset(String(i))},
async selectPreset(value){const select=w.document.querySelector('select');select.value=value;f.selected=select.selectedOptions[0].textContent;f.active=structuredClone(f.presets[Number(value)]);w.document.querySelector('#result').textContent='当前：'+f.selected+'；本地正文：'+f.active.prompts[2].content+'；正则停用：'+f.active.extensions.regex_scripts[0].disabled;setTimeout(f.restart,0);}
}};`;
const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const send = (body, type = 'application/json') => { res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' }); res.end(body); };
    if (path === '/') return send(html, 'text/html');
    if (path === '/mobile' || path === '/landscape') return send(`<!doctype html><meta charset="utf-8"><title>SL 更新 · 窄屏模拟</title><style>body{margin:0;background:#16161a;display:grid;place-items:center;min-height:100vh}iframe{width:${path === '/mobile' ? 375 : 667}px;height:${path === '/mobile' ? 780 : 375}px;border:0}</style><iframe src="/" title="375px 手机模拟"></iframe>`, 'text/html');
    if (path === '/initial') return send(JSON.stringify(current));
    if (path === '/state') return send(JSON.stringify({ names: [...files.keys()], calls, presets: Object.fromEntries(files) }));
    if (path === '/frame') return send(`<script>const original=window.parent.fetch.bind(window.parent);window.parent.fetch=(url,options)=>{const u=new URL(url,location.origin);if(u.hostname==='raw.githubusercontent.com')return original(u.pathname.endsWith('/update.json')?'/remote/manifest':'/remote/preset',options);return original(url,options);};</script><script type="module" src="/dist/updater.js"></script>`, 'text/html');
    if (path === '/remote/manifest') return send(JSON.stringify(manifest));
    if (path === '/remote/preset') return send(text);
    if (path === '/scripts/preset-manager.js') return send(presetModule, 'application/javascript');
    if (path === '/scripts/openai.js') return send('export function getChatCompletionPreset(){return structuredClone(window.parent.__fixture.active);}', 'application/javascript');
    if (path === '/script.js') return send('export const is_send_press=false;export function getRequestHeaders(){return {"Content-Type":"application/json"};}', 'application/javascript');
    if (path === '/dist/updater.js') return send(await readFile(new URL('dist/updater.js', root), 'utf8'), 'application/javascript');
    if (path.startsWith('/mode/')) { mode = path.slice(6); return send(JSON.stringify({ mode })); }
    if (req.method === 'POST' && path.startsWith('/api/presets/')) {
        let raw = ''; for await (const data of req) raw += data;
        const body = JSON.parse(raw); calls.push({ action: path.split('/').pop(), name: body.name });
        if (mode === 'fail-save' && path.endsWith('save')) { res.writeHead(503); return res.end('simulated'); }
        if (path.endsWith('save')) files.set(body.name, body.preset);
        if (path.endsWith('delete')) files.delete(body.name);
        return send(JSON.stringify({ name: body.name }));
    }
    res.writeHead(404); res.end();
});
server.listen(8797, '127.0.0.1', () => console.log('SL isolated browser host: http://127.0.0.1:8797'));
