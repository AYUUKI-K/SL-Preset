import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { META_KEY, UPDATER_ID, makeBaseline, validatePreset, verifyPayload, packageScriptTrees, scriptReport } from '../src/core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = async file => (await readFile(resolve(root, file), 'utf8')).replace(/\r\n/g, '\n');
const release = JSON.parse(await read('release.json'));
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(release.repository) || !/^[A-Za-z0-9_.-]+$/.test(release.branch)) throw Error('仓库或分支格式不正确');
if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(release.version) || !Number.isSafeInteger(release.revision) || release.revision < 1) throw Error('版本格式不正确');
if (typeof release.displayName !== 'string' || /[\\/\x00-\x1f]/.test(release.displayName)) throw Error('显示名称包含非法字符');
if (!release.displayName.includes(release.version)) throw Error('酒馆显示名称必须包含当前版本号，避免更新后仍显示旧名称');
const source = JSON.parse((await read('source/preset.json')).replace(/^\uFEFF/, ''));
validatePreset(source);
// Never publish proxy credentials or custom service addresses in an update package.
const sensitive = /^(api_key|apiKey|password|secret|token|reverse_proxy|proxy_password|custom_url|custom_api_key)$/i;
function inspect(value, path = '') {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
        if (sensitive.test(key) && item) throw Error(`发布源含连接或密钥字段，请先移除：${path}.${key}`);
        inspect(item, path + '.' + key);
    }
}
inspect(source);
const clean = text => text.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const config = { presetId: release.presetId, repository: release.repository, branch: release.branch };
const runtime = ['// SL preset updater. Generated from src/*.mjs and src/automatic-runtime.js.', '(async () => {', '"use strict";', `const CONFIG = ${JSON.stringify(config)};`, clean(await read('src/core.mjs')), clean(await read('src/transaction.mjs')), await read('src/automatic-runtime.js'), '})().catch(error => console.error("[SL 更新]", error));', ''].join('\n');
const preset = structuredClone(source);
preset.extensions ??= {};
preset.extensions.tavern_helper ??= { scripts: [], variables: {} };
function removeUpdater(trees) { return trees.filter(s => s.id !== UPDATER_ID).map(s => s.type === 'folder' ? { ...s, scripts: removeUpdater(s.scripts ?? []) } : s); }
preset.extensions.tavern_helper.scripts = removeUpdater(preset.extensions.tavern_helper.scripts ?? []);
const packagedScripts = packageScriptTrees(preset.extensions.tavern_helper.scripts);
preset.extensions.tavern_helper.scripts = packagedScripts.scripts;
for (const script of packagedScripts.scripts) {
    if (script.type !== 'script') throw Error(`无效的配套脚本类型：${script.name}`);
    if (typeof script.content !== 'string' || !script.content.trim()) throw Error(`配套脚本正文为空：${script.name}`);
    if (typeof script.enabled !== 'boolean') throw Error(`配套脚本缺少启用状态：${script.name}`);
}
const requiredScriptIds = release.requiredScriptIds ?? packagedScripts.scripts.map(x => x.id);
if (!Array.isArray(requiredScriptIds) || requiredScriptIds.some(id => typeof id !== 'string' || !packagedScripts.scripts.some(x => x.id === id))) throw Error('发布源缺少必需配套脚本，请在工作台“配套脚本”页补齐后再发布。');
preset.extensions.tavern_helper.scripts.push({
    type: 'script', id: UPDATER_ID, enabled: true, name: 'SL · 预设在线更新', content: runtime,
    info: '喵喵电波-SL预设-STARLIGHT-脚本4',
    button: { enabled: false, buttons: [] }, data: {}, export_with: { data: false, button: false },
});
preset.extensions[META_KEY] = { ...config, version: release.version, revision: release.revision, displayName: release.displayName,
    requiredScriptIds, scriptLayout: packagedScripts.layout };
preset.extensions[META_KEY].baseline = await makeBaseline(preset);
const text = JSON.stringify(preset, null, 2) + '\n';
const manifest = {
    schema: 1, presetId: release.presetId, version: release.version, revision: release.revision,
    displayName: release.displayName, file: 'dist/preset.json',
    sha256: createHash('sha256').update(text).digest('hex'), changelog: release.changelog,
};
if (process.env.CI === 'true') {
    let previous;
    try { previous = JSON.parse(await read('update.json')); } catch { /* First release. */ }
    if (previous && previous.sha256 !== manifest.sha256 && release.revision <= previous.revision) throw Error('发布内容已变化，请先把 release.json 的 revision 加 1。');
}
await verifyPayload(text, manifest);
for (const dir of ['dist', 'downloads']) await mkdir(resolve(root, dir), { recursive: true });
await writeFile(resolve(root, 'dist/updater.js'), runtime);
await writeFile(resolve(root, 'dist/preset.json'), text);
await writeFile(resolve(root, `downloads/${release.displayName}.json`), text);
await writeFile(resolve(root, 'update.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built ${release.displayName}: ${preset.prompts.length} prompts, ${preset.extensions.regex_scripts.length} regexes. Revision ${release.revision}.`);
for (const script of scriptReport(preset)) console.log(`${script.updater ? '[更新器]' : '[配套脚本]'} ${script.name} · ${script.enabled ? '已启用' : '已停用'}`);
