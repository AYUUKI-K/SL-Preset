// SL preset updater. Generated from src/*.mjs and src/runtime.js.
(async () => {
"use strict";
const CONFIG = {"presetId":"nue.sl.preset","repository":"AYUUKI-K/SL-Preset","branch":"main"};
const META_KEY = 'nue_sl_update';
const UPDATER_ID = '9c79fdb7-86b1-4aec-9d6e-75992c4e8301';
const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => canonical(a) === canonical(b);

// Read through the host's public context, without importing ST modules into the
// helper iframe (which would instantiate a second, empty module state).
function activePresetSnapshot(saved, settings) {
    if (!settings?.prompts || !settings?.prompt_order || !settings?.extensions) throw Error('无法读取酒馆当前预设，请升级酒馆后再试。');
    const aliases = {
        temperature: 'temp_openai', frequency_penalty: 'freq_pen_openai', presence_penalty: 'pres_pen_openai',
        top_p: 'top_p_openai', top_k: 'top_k_openai', top_a: 'top_a_openai', min_p: 'min_p_openai', repetition_penalty: 'repetition_penalty_openai',
    };
    const result = clone(saved);
    for (const key of new Set([...Object.keys(saved), 'prompts', 'prompt_order', 'extensions'])) {
        const settingKey = aliases[key] ?? key;
        if (Object.hasOwn(settings, settingKey)) result[key] = clone(settings[settingKey]);
    }
    return result;
}

function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    return JSON.stringify(value) ?? 'undefined';
}

async function digest(value) {
    const bytes = new TextEncoder().encode(canonical(value));
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
}

function flattenScripts(trees) {
    return trees.flatMap(node => [node, ...(node.type === 'folder' ? flattenScripts(node.scripts ?? []) : [])]);
}

function unique(items, key, label) {
    const ids = new Set();
    for (const item of items) {
        if (!item || typeof item[key] !== 'string' || !item[key] || ids.has(item[key])) throw Error(`${label}存在空 ID 或重复 ID。`);
        ids.add(item[key]);
    }
    return ids;
}

function validatePreset(preset, expectedId) {
    if (!preset || !Array.isArray(preset.prompts) || !Array.isArray(preset.prompt_order)) throw Error('不是有效的聊天补全预设。');
    const ids = unique(preset.prompts, 'identifier', '提示词');
    if (new Set(preset.prompt_order.map(x => x.character_id)).size !== preset.prompt_order.length) throw Error('排序配置存在重复角色 ID。');
    for (const order of preset.prompt_order) {
        if (!Number.isSafeInteger(order.character_id) || !Array.isArray(order.order)) throw Error('预设排序格式不正确。');
        unique(order.order, 'identifier', '提示词排序');
        if (order.order.some(item => !ids.has(item.identifier))) throw Error('排序引用了不存在的提示词。');
    }
    unique(preset.extensions?.regex_scripts ?? [], 'id', '正则');
    unique(flattenScripts(preset.extensions?.tavern_helper?.scripts ?? []), 'id', '脚本');
    if (expectedId && preset.extensions?.[META_KEY]?.presetId !== expectedId) throw Error('更新包不属于这套预设。');
}

async function makeBaseline(preset) {
    const records = async (items, key, excluded) => Object.fromEntries(await Promise.all(items.map(async item => [item[key], Object.fromEntries(await Promise.all(Object.entries(item).filter(([k]) => !excluded.includes(k)).map(async ([k, v]) => [k, await digest(v)])))])));
    return {
        prompts: await records(preset.prompts, 'identifier', ['enabled']),
        regexes: await records(preset.extensions?.regex_scripts ?? [], 'id', ['disabled']),
        scripts: await records(flattenScripts(preset.extensions?.tavern_helper?.scripts ?? []), 'id', ['scripts', 'enabled', 'data', 'button']),
    };
}

async function mergeFields(local, remote, base, protectedFields, keepEdits, conflicts) {
    const result = clone(remote);
    for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
        if (protectedFields.includes(key)) {
            if (Object.hasOwn(local, key)) result[key] = clone(local[key]);
            continue;
        }
        if (keepEdits && base && (base[key] ? await digest(local[key]) !== base[key] : Object.hasOwn(local, key))) {
            if (!same(local[key], remote[key])) conflicts.push(`${local.name ?? local.scriptName ?? local.id ?? local.identifier} · ${key}`);
            if (Object.hasOwn(local, key)) result[key] = clone(local[key]); else delete result[key];
        }
    }
    return result;
}

function appendAnchored(result, locals, key, include = () => true) {
    const known = new Set(result.map(x => x[key]));
    let anchor;
    for (const item of locals) {
        if (known.has(item[key])) { anchor = item[key]; continue; }
        if (!include(item)) continue;
        const i = result.findIndex(x => x[key] === anchor);
        result.splice(i < 0 ? result.length : i + 1, 0, clone(item));
        known.add(item[key]);
        anchor = item[key];
    }
    return result;
}

async function mergeRecords(locals, remotes, base, key, protectedFields, keepEdits, conflicts) {
    const localMap = new Map(locals.map(x => [x[key], x]));
    const remoteIds = new Set(remotes.map(x => x[key]));
    const result = [];
    for (const remote of remotes) {
        const local = localMap.get(remote[key]);
        // A locally deleted managed item stays deleted. The updater itself is required.
        if (!local && base[remote[key]] && remote[key] !== UPDATER_ID) continue;
        result.push(local ? await mergeFields(local, remote, base[remote[key]], protectedFields, keepEdits && remote[key] !== UPDATER_ID, conflicts) : clone(remote));
    }
    const remaining = [];
    for (const local of locals.filter(x => !remoteIds.has(x[key]))) {
        const old = base[local[key]];
        const edited = old && (await Promise.all(Object.keys(old).map(async k => await digest(local[k]) !== old[k]))).some(Boolean);
        if (!old || (keepEdits && edited)) remaining.push(local);
    }
    return appendAnchored(result, locals, key, x => remaining.includes(x));
}

async function mergePreset(local, remote, options = {}) {
    const { keepEdits = true, syncSettings = false } = options;
    const oldMeta = local.extensions?.[META_KEY];
    if (!oldMeta?.baseline) throw Error('本地预设缺少更新基线，请先导入带更新功能的版本。');
    validatePreset(remote, oldMeta.presetId);
    const conflicts = [], base = oldMeta.baseline;
    const result = clone(syncSettings ? remote : local);
    result.prompts = await mergeRecords(local.prompts, remote.prompts, base.prompts, 'identifier', ['enabled'], keepEdits, conflicts);
    const ids = new Set(result.prompts.map(x => x.identifier));
    const localOrders = new Map(local.prompt_order.map(x => [x.character_id, x]));
    result.prompt_order = remote.prompt_order.map(order => {
        const previous = localOrders.get(order.character_id)?.order ?? [];
        const switches = new Map(previous.map(x => [x.identifier, x.enabled]));
        const mergedOrder = order.order.filter(x => ids.has(x.identifier)).map(x => ({ ...x, enabled: switches.has(x.identifier) ? switches.get(x.identifier) : x.enabled }));
        const incoming = new Set(order.order.map(x => x.identifier));
        return { ...clone(order), order: appendAnchored(mergedOrder, previous, 'identifier', x => ids.has(x.identifier) && !incoming.has(x.identifier)) };
    });
    for (const order of local.prompt_order) if (!result.prompt_order.some(x => x.character_id === order.character_id)) result.prompt_order.push(clone(order));
    result.extensions = { ...clone(local.extensions), [META_KEY]: clone(remote.extensions[META_KEY]) };
    result.extensions.regex_scripts = await mergeRecords(local.extensions.regex_scripts ?? [], remote.extensions.regex_scripts ?? [], base.regexes, 'id', ['disabled'], keepEdits, conflicts);
    const locals = local.extensions.tavern_helper?.scripts ?? [];
    const remotes = remote.extensions.tavern_helper?.scripts ?? [];
    // Match by ID across folders so moving a script does not lose its state.
    const flat = await mergeRecords(flattenScripts(locals), flattenScripts(remotes), base.scripts, 'id', ['enabled', 'data', 'button', 'scripts'], keepEdits, conflicts);
    const flatMap = new Map(flat.map(x => [x.id, x]));
    const placed = new Set();
    function place(tree) {
        const item = flatMap.get(tree.id);
        if (!item) {
            // An author-removed folder may still contain user-created scripts.
            if (tree.type === 'folder') {
                const children = (tree.scripts ?? []).map(place).filter(Boolean);
                if (children.length) return { ...clone(tree), scripts: children };
            }
            return null;
        }
        if (placed.has(item.id)) return null;
        placed.add(item.id);
        const node = clone(item);
        if (node.type === 'folder') node.scripts = (tree.scripts ?? []).map(place).filter(Boolean);
        return node;
    }
    const trees = remotes.map(place).filter(Boolean);
    for (const node of locals) {
        if (node.type === 'folder' && placed.has(node.id)) {
            const folder = trees.find(x => x.id === node.id);
            if (folder) folder.scripts.push(...node.scripts.map(place).filter(Boolean));
        } else { const added = place(node); if (added) trees.push(added); }
    }
    result.extensions.tavern_helper = {
        ...clone(remote.extensions.tavern_helper ?? {}), ...clone(local.extensions.tavern_helper ?? {}), scripts: trees,
        variables: { ...clone(remote.extensions.tavern_helper?.variables ?? {}), ...clone(local.extensions.tavern_helper?.variables ?? {}) },
    };
    // Author grouping is updated; personal collapse/enable state and custom entries survive.
    const remoteToolkit = remote.extensions.baibaiToolkit;
    if (remoteToolkit) {
        const toolkit = result.extensions.baibaiToolkit ??= {};
        for (const key of ['presetPromptGroups', 'regexGroups']) {
            if (!remoteToolkit[key]) continue;
            const old = toolkit[key] ?? {}, fresh = clone(remoteToolkit[key]);
            fresh.groups = (fresh.groups ?? []).map(g => ({ ...g, ...Object.fromEntries(Object.entries((old.groups ?? []).find(x => x.id === g.id) ?? {}).filter(([k]) => ['collapsed', 'enabled'].includes(k))) }));
            fresh.groups.push(...(old.groups ?? []).filter(g => !fresh.groups.some(x => x.id === g.id)));
            for (const mapKey of ['prompts', 'scripts']) if (fresh[mapKey]) fresh[mapKey] = { ...old[mapKey], ...fresh[mapKey] };
            toolkit[key] = { ...old, ...fresh };
        }
    }
    validatePreset(result, oldMeta.presetId);
    return { preset: result, conflicts };
}

function validateManifest(manifest, presetId) {
    if (manifest?.schema !== 1 || manifest.presetId !== presetId || !Number.isSafeInteger(manifest.revision) || manifest.revision < 1 || typeof manifest.version !== 'string' || typeof manifest.displayName !== 'string' || !manifest.displayName.trim() || /[\\/\x00-\x1f]/.test(manifest.displayName) || !/^[a-f0-9]{64}$/.test(manifest.sha256) || typeof manifest.file !== 'string' || !/^dist\/[a-zA-Z0-9._/-]+\.json$/.test(manifest.file) || manifest.file.includes('..')) throw Error('更新清单格式不正确。');
    return manifest;
}

async function verifyPayload(text, manifest) {
    const bytes = new TextEncoder().encode(text);
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
    if (hash !== manifest.sha256) throw Error('更新文件校验失败，可能是缓存尚未同步，请稍后再试。');
    const preset = JSON.parse(text);
    validatePreset(preset, manifest.presetId);
    const meta = preset.extensions[META_KEY];
    if (meta.revision !== manifest.revision || meta.version !== manifest.version || meta.displayName !== manifest.displayName) throw Error('更新清单与预设版本不一致。');
    if (!flattenScripts(preset.extensions.tavern_helper?.scripts ?? []).some(s => s.id === UPDATER_ID && s.enabled && typeof s.content === 'string')) throw Error('更新包缺少可用的更新脚本。');
    const baseline = await makeBaseline(preset);
    if (!same(meta.baseline, baseline)) throw Error('更新包的基线数据不匹配。');
    return preset;
}


// The host adapter keeps writes and the final UI reload separate. Reloading a
// preset can destroy the updater iframe, so it must always be the last step.
async function installUpdate(host, remote, manifest, options) {
    const snapshot = host.snapshot();
    if (snapshot.active.extensions?.[META_KEY]?.presetId !== manifest.presetId) throw Error('请先切换到这套 SL 预设。');
    const revision = snapshot.active.extensions[META_KEY].revision;
    if (manifest.revision <= revision) throw Error('当前版本已经是最新版本。');
    if (!host.isIdle()) throw Error('酒馆正在生成，请等本轮结束后更新。');
    const nextName = options.rename ? manifest.displayName : snapshot.name;
    if (nextName !== snapshot.name && host.names().includes(nextName)) throw Error('新版名称已被另一份预设占用，请先改名或关闭“同步预设名称”。');
    const { preset, conflicts } = await mergePreset(snapshot.active, remote, options);
    const assertUnchanged = () => {
        if (!host.isIdle() || !same(host.snapshot(), snapshot)) throw Error('预设或生成状态已变化，本次未写入，请重新检查更新。');
    };
    assertUnchanged();
    // Backups must be durable before the first network write; quota failures abort.
    host.backup({ schema: 1, createdAt: new Date().toISOString(), ...clone(snapshot), nextName });
    assertUnchanged();
    await host.save(nextName, preset);
    // A switch/edit while the request was in flight must never reload an old
    // snapshot over the user's new selection. The server write is still real.
    if (!host.isIdle() || !same(host.snapshot(), snapshot)) {
        return { deferred: true, name: nextName, conflicts, message: '新版已保存；期间预设或生成状态变化，当前界面未切换。请刷新后选择新版，原版已备份。' };
    }
    let oldRetained = false;
    if (nextName !== snapshot.name) {
        try { await host.remove(snapshot.name); } catch { oldRetained = true; }
    }
    // Removing the old server file can also take time; re-check before UI changes.
    if (!host.isIdle() || !same(host.snapshot(), snapshot)) {
        return { deferred: true, name: nextName, conflicts, oldRetained, message: '新版已保存，请刷新后选择新版；当前操作未被打断。' };
    }
    host.activate(snapshot.name, nextName, preset, oldRetained);
    return { name: nextName, conflicts, oldRetained, deferred: false };
}

const win = window.parent, doc = win.document;
const slot = '__NUE_SL_PRESET_UPDATER__';
const storageKey = `nue.sl.updater.${CONFIG.presetId}`;
const backupKey = storageKey + '.backup';
const rootUrl = `https://raw.githubusercontent.com/${CONFIG.repository}/${CONFIG.branch}/`;
const context = () => win.SillyTavern?.getContext?.() ?? {};
const manager = context().getPresetManager?.('openai');
if (!manager || typeof manager.getCompletionPresetByName !== 'function') throw Error('当前酒馆缺少原始预设接口，请升级酒馆后再试。');
const selected = manager.getSelectedPresetName();
if (manager.getCompletionPresetByName(selected)?.extensions?.[META_KEY]?.presetId !== CONFIG.presetId) return;
win[slot]?.dispose();
let disposed = false, busy = false, pending = null, lastCheck = 0, controller, generating = false;
let status = '尚未检查更新。', detail = '';
const defaults = { autoCheck: true, autoApply: false, rename: true, keepEdits: true, syncSettings: false };
let options = { ...defaults };
try {
    const saved = JSON.parse(win.localStorage.getItem(storageKey) ?? '{}');
    for (const key of Object.keys(defaults)) if (typeof saved[key] === 'boolean') options[key] = saved[key];
} catch { /* Keep the panel usable when old options are malformed. */ }
const ctx = context();
const generationEvents = [];
for (const [key, value] of [['GENERATION_STARTED', true], ['GENERATION_ENDED', false], ['GENERATION_STOPPED', false]]) {
    const event = (ctx.eventTypes ?? ctx.event_types)?.[key];
    if (event && ctx.eventSource?.on) {
        const handler = () => { generating = value; };
        ctx.eventSource.on(event, handler); generationEvents.push([event, handler]);
    }
}
function isIdle() {
    const ctx = context();
    const stop = doc.querySelector('#mes_stop');
    const stopVisible = stop && win.getComputedStyle(stop).display !== 'none' && stop.getClientRects().length > 0;
    return ctx.mainApi === 'openai' && !(generating || stopVisible || doc.body.dataset.generating === 'true'
        || (ctx.streamingProcessor && !ctx.streamingProcessor.isFinished)
        || doc.querySelector('dialog[open]:not(#nue-sl-update-panel)'));
}
function snapshot() {
    const name = manager.getSelectedPresetName();
    const saved = manager.getCompletionPresetByName(name);
    if (!saved) throw Error('无法读取当前预设。');
    return { name, saved: clone(saved), active: activePresetSnapshot(saved, context().chatCompletionSettings) };
}
function metadata() { return snapshot().active.extensions?.[META_KEY]; }
function ownsSelection() { try { return metadata()?.presetId === CONFIG.presetId; } catch { return false; } }
function readBackup() {
    const raw = win.localStorage.getItem(backupKey);
    if (!raw) return null;
    const backup = JSON.parse(raw);
    if (backup.schema !== 1 || backup.active?.extensions?.[META_KEY]?.presetId !== CONFIG.presetId) throw Error('备份格式不正确。');
    return backup;
}
const host = {
    snapshot, isIdle, names: () => manager.getAllPresets(),
    backup(value) { win.localStorage.setItem(backupKey, JSON.stringify(value)); },
    save: (name, value) => manager.savePreset(name, value, { skipUpdate: true }),
    async remove(name) {
        const response = await win.fetch('/api/presets/delete', {
            method: 'POST', credentials: 'same-origin', headers: context().getRequestHeaders(),
            body: JSON.stringify({ apiId: 'openai', name }),
        });
        if (!response.ok) throw Error('旧名称暂未清理。');
    },
    activate(oldName, newName, value, retainOld) {
        const { presets, preset_names } = manager.getPresetList();
        win.__NUE_SL_REFRESH_REQUIRED__ = true;
        const oldIndex = preset_names[oldName];
        if (newName !== oldName && retainOld) {
            manager.updateList(newName, clone(value));
            return;
        }
        presets[oldIndex] = clone(value);
        if (newName !== oldName) {
            delete preset_names[oldName];
            preset_names[newName] = oldIndex;
            const option = Array.from(doc.querySelector('#settings_preset_openai').options).find(x => x.value === String(oldIndex));
            if (option) option.textContent = newName;
        }
        // No work requiring this iframe is allowed after reloading its preset.
        void manager.selectPreset(String(oldIndex));
    },
};

// Native dialog supplies keyboard focus containment and Escape dismissal.
const dialog = doc.createElement('dialog');
dialog.id = 'nue-sl-update-panel';
dialog.setAttribute('aria-labelledby', 'nue-sl-update-title');
dialog.innerHTML = `
<style>
#nue-sl-update-panel{box-sizing:border-box;width:min(540px,calc(100vw - 24px));max-height:calc(100dvh - 32px);padding:20px;overflow:auto;color:var(--SmartThemeBodyColor,#eee);background:var(--SmartThemeBlurTintColor,#252529);border:1px solid var(--SmartThemeBorderColor,#888);border-radius:12px;font:inherit;text-align:left;overflow-wrap:anywhere}
#nue-sl-update-panel::backdrop{background:#0008}
#nue-sl-update-panel h2{font-size:1.15em;margin:0 0 8px}#nue-sl-update-panel p{margin:8px 0;line-height:1.6}#nue-sl-update-panel label{display:flex;align-items:center;gap:10px;min-height:44px;line-height:1.5;cursor:pointer}#nue-sl-update-panel input{flex:0 0 auto}
#nue-sl-update-panel button,#nue-sl-update-entry{font:inherit;min-height:44px;padding:8px 12px;white-space:normal;cursor:pointer;color:inherit;border:1px solid var(--SmartThemeBorderColor,#888);border-radius:8px;background:transparent}
#nue-sl-update-panel button:disabled{opacity:.5;cursor:default}#nue-sl-update-panel :focus-visible,#nue-sl-update-entry:focus-visible{outline:2px solid currentColor;outline-offset:3px}#nue-sl-update-panel .sl-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}#nue-sl-update-panel .sl-status{border-block:1px solid var(--SmartThemeBorderColor,#888);padding:12px 0;margin:12px 0}#nue-sl-update-panel [data-action=apply]{background:var(--SmartThemeQuoteColor,#879eab);color:#101114}#nue-sl-update-panel .sl-note{font-size:.9em;line-height:1.6}#nue-sl-update-panel [data-detail]{white-space:pre-wrap}
</style>
<h2 id="nue-sl-update-title">SL 预设更新</h2>
<p data-current></p>
<div class="sl-status" role="status" aria-live="polite" aria-atomic="true"><p data-status></p><p data-detail></p></div>
<label><input type="checkbox" data-option="autoCheck">自动检查更新</label>
<label><input type="checkbox" data-option="autoApply">发现新版后自动应用</label>
<p class="sl-note">自动应用会等酒馆空闲时执行，更新前保存一份本机备份。新脚本随预设更新后运行。</p>
<label><input type="checkbox" data-option="rename">同步作者发布的预设名称</label>
<label><input type="checkbox" data-option="keepEdits">保留本地修改的提示词、脚本和正则</label>
<label><input type="checkbox" data-option="syncSettings">同步作者的采样参数</label>
<p class="sl-note">条目开关、自定义条目和脚本数据会保留。关闭“保留本地修改”后，作者管理的内容以新版为准。备份保存在当前浏览器，可下载到本地。</p>
<div class="sl-actions"><button type="button" data-action="check">检查更新</button><button type="button" data-action="apply">应用更新</button><button type="button" data-action="reload" hidden>刷新酒馆生效</button><button type="button" data-action="backup">下载上次备份</button><button type="button" data-action="restore">恢复上次备份</button><button type="button" data-action="close">关闭</button></div>`;
doc.body.append(dialog);
const entry = doc.createElement('button');
entry.type = 'button'; entry.id = 'nue-sl-update-entry'; entry.textContent = 'SL 更新';
entry.title = '检查这套预设、脚本和正则的更新';
const select = doc.querySelector('#settings_preset_openai');
if (select) select.insertAdjacentElement('afterend', entry);
else { dialog.remove(); throw Error('找不到酒馆预设选择框。'); }
function render() {
    if (disposed) return;
    let meta;
    try { meta = metadata(); } catch { /* Display the existing error. */ }
    entry.hidden = meta?.presetId !== CONFIG.presetId;
    entry.textContent = pending ? 'SL 有更新' : win.__NUE_SL_REFRESH_REQUIRED__ ? 'SL 更新 · 待刷新' : 'SL 更新';
    dialog.querySelector('[data-action=reload]').hidden = !win.__NUE_SL_REFRESH_REQUIRED__;
    dialog.querySelector('[data-current]').textContent = meta ? `当前 v${meta.version} · ${manager.getSelectedPresetName()}${win.__NUE_SL_REFRESH_REQUIRED__ ? '（请刷新酒馆使全部配套脚本生效）' : ''}` : '请先选择 SL 预设';
    dialog.querySelector('[data-status]').textContent = status;
    dialog.querySelector('[data-detail]').textContent = detail;
    for (const input of dialog.querySelectorAll('[data-option]')) { input.checked = options[input.dataset.option]; input.disabled = busy; }
    for (const button of dialog.querySelectorAll('[data-action]')) button.disabled = busy && button.dataset.action !== 'close';
    dialog.querySelector('[data-action=apply]').disabled = busy || !pending;
    const hasBackup = !!win.localStorage.getItem(backupKey);
    for (const action of ['backup', 'restore']) dialog.querySelector(`[data-action=${action}]`).disabled = busy || !hasBackup;
}
function show() { render(); if (!dialog.open) dialog.showModal(); }
function say(message, info = '') { status = message; detail = info; render(); }
function errorMessage(error) { return error?.name === 'AbortError' ? '连接超时，请稍后重试。' : String(error?.message ?? error); }
async function request(path) {
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 20000);
    try {
        const url = new URL(path, rootUrl);
        url.searchParams.set('_sl', String(Date.now()));
        const response = await win.fetch(url.href, { cache: 'no-store', credentials: 'omit', signal: controller.signal });
        if (!response.ok) throw Error(`获取更新失败（${response.status}）。请确认可以访问 GitHub Raw。`);
        const body = await response.text();
        if (body.length > 12_000_000) throw Error('更新文件异常大。');
        return body;
    } finally { clearTimeout(timeout); controller = null; }
}
async function exclusive(work) {
    if (win.navigator.locks) return win.navigator.locks.request(`sl-update-${CONFIG.presetId}`, { ifAvailable: true }, lock => {
        if (!lock) throw Error('另一个酒馆页面正在更新这套预设。');
        return work();
    });
    return work();
}
async function run(label, work) {
    if (busy || disposed) return;
    busy = true; say(label);
    try { await work(); }
    catch (error) { if (!disposed) say(errorMessage(error)); }
    finally { busy = false; render(); }
}
async function check() {
    return run('正在检查更新…', async () => {
        if (!ownsSelection()) throw Error('请先选择这套 SL 预设。');
        const manifest = validateManifest(JSON.parse(await request('update.json')), CONFIG.presetId);
        lastCheck = Date.now();
        if (!ownsSelection() || disposed) return;
        const current = metadata();
        if (manifest.revision <= current.revision) { pending = null; say(`当前 v${current.version} 已是最新版本。`); return; }
        pending = manifest;
        say(`发现新版 v${manifest.version}`, (Array.isArray(manifest.changelog) ? manifest.changelog.filter(x => typeof x === 'string') : []).join('\n'));
    });
}
async function apply() {
    if (!pending) return;
    return run('正在下载并校验新版…', () => exclusive(async () => {
        const manifest = clone(pending);
        const remote = await verifyPayload(await request(manifest.file), manifest);
        if (disposed) return;
        const conflictInfo = [];
        const wrappedHost = { ...host, activate(...args) {
            const conflicts = conflictInfo[0] ?? [];
            win.sessionStorage.setItem(storageKey + '.notice', JSON.stringify({ version: manifest.version, conflicts: conflicts.length }));
            pending = null;
            host.activate(...args);
        } };
        // Merge warnings are also available in the last backup and the next panel.
        const merged = await mergePreset(snapshot().active, remote, options);
        conflictInfo.push(merged.conflicts);
        say('校验通过，正在备份并保存…');
        const result = await installUpdate(wrappedHost, remote, manifest, options);
        if (result.deferred) { pending = null; say(result.message); return; }
        if (!disposed) say(`已更新至 v${manifest.version}。`, `${result.conflicts.length ? `保留了 ${result.conflicts.length} 处本地修改。` : ''}${result.oldRetained ? '旧名称未清理，可在扩展面板刷新后检查。' : ''}`);
    }));
}
function downloadBackup() {
    try {
        const backup = readBackup();
        if (!backup) throw Error('暂无更新备份。');
        const file = new win.Blob([JSON.stringify(backup.active, null, 2)], { type: 'application/json' });
        const url = win.URL.createObjectURL(file), link = doc.createElement('a');
        link.href = url; link.download = `${backup.name} · 更新前备份.json`; link.click();
        setTimeout(() => win.URL.revokeObjectURL(url), 1000);
    } catch (error) { say(errorMessage(error)); }
}
async function restore() {
    if (!win.confirm('恢复上次更新前的预设？当前版本会保存为新的备份。')) return;
    return run('正在恢复备份…', () => exclusive(async () => {
        if (!isIdle() || !ownsSelection()) throw Error('请先选择 SL 预设，并等待酒馆空闲。');
        const backup = readBackup(), current = snapshot();
        if (!backup) throw Error('暂无可恢复的备份。');
        const target = backup.name;
        if (target !== current.name && host.names().includes(target)) throw Error('备份名称已被另一份预设占用，请先给那份预设改名。');
        validatePreset(backup.active, CONFIG.presetId);
        host.backup({ schema: 1, createdAt: new Date().toISOString(), ...current, nextName: target });
        await host.save(target, backup.active);
        if (!isIdle() || !same(snapshot(), current)) { say('备份已保存，请刷新后选择恢复的版本。'); return; }
        let retained = false;
        if (target !== current.name) { try { await host.remove(current.name); } catch { retained = true; } }
        if (!isIdle() || !same(snapshot(), current)) { say('备份已保存，请刷新后选择恢复的版本。'); return; }
        // Prevent the restored revision from immediately re-installing the update.
        options.autoApply = false;
        win.localStorage.setItem(storageKey, JSON.stringify(options));
        host.activate(current.name, target, backup.active, retained);
    }));
}
entry.addEventListener('click', show);
dialog.addEventListener('change', event => {
    const key = event.target.dataset.option;
    if (!(key in defaults)) return;
    const previous = options[key]; options[key] = event.target.checked;
    try { win.localStorage.setItem(storageKey, JSON.stringify(options)); }
    catch { options[key] = previous; say('设置无法保存，请检查浏览器存储空间。'); }
    render();
});
dialog.addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'close') dialog.close();
    if (action === 'check') void check();
    if (action === 'apply') void apply();
    if (action === 'backup') downloadBackup();
    if (action === 'restore') void restore();
    if (action === 'reload') {
        if (!isIdle()) say('请等待本轮生成结束后刷新。');
        else win.location.reload();
    }
});
const tick = async () => {
    if (disposed || busy || !ownsSelection()) return;
    if (options.autoCheck && Date.now() - lastCheck > 30 * 60 * 1000) { lastCheck = Date.now(); await check(); }
    if (!disposed && options.autoApply && pending && isIdle() && !dialog.open) await apply();
};
const startupTimer = setTimeout(tick, 8000);
const interval = setInterval(tick, 30000);
function dispose() {
    if (disposed) return;
    disposed = true; controller?.abort(); clearTimeout(startupTimer); clearInterval(interval);
    for (const [event, handler] of generationEvents) ctx.eventSource?.removeListener?.(event, handler);
    dialog.remove(); entry.remove();
    if (win[slot]?.dispose === dispose) delete win[slot];
}
win[slot] = { open: show, dispose };
window.addEventListener('pagehide', dispose, { once: true });
try {
    const notice = JSON.parse(win.sessionStorage.getItem(storageKey + '.notice') ?? 'null');
    if (notice) {
        win.sessionStorage.removeItem(storageKey + '.notice');
        status = `已保存 v${notice.version}，请刷新酒馆使全部配套脚本生效。`;
        detail = notice.conflicts ? `保留了 ${notice.conflicts} 处本地修改。` : '更新前备份已保存，可下载或恢复。';
        win.toastr?.success?.(status);
    }
} catch { /* A notice must not prevent initialization. */ }
render();

})().catch(error => console.error("[SL 更新]", error));
