// SL preset updater. Generated from src/*.mjs and src/automatic-runtime.js.
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

// Independent script entries also work in helper versions that cannot import folders.
// Keep the author layout separately so the local editor can recover its groups.
function packageScriptTrees(trees) {
    const scripts = [], layout = [];
    for (const node of trees) {
        if (node.type === 'folder') {
            const folder = { ...clone(node), scripts: [] };
            for (const child of node.scripts ?? []) {
                if (child.type !== 'script') throw Error('脚本分组只能包含脚本，不能嵌套分组。');
                const enabled = node.enabled !== false && child.enabled === true;
                scripts.push({ ...clone(child), enabled });
                folder.scripts.push({ id: child.id, enabled: child.enabled, exportedEnabled: enabled });
            }
            layout.push(folder);
        } else { scripts.push(clone(node)); layout.push({ type: 'script', id: node.id }); }
    }
    return { scripts, layout };
}
function restoreScriptLayout(preset) {
    const result = clone(preset), layout = result.extensions?.[META_KEY]?.scriptLayout;
    if (!Array.isArray(layout)) return result;
    const trees = result.extensions?.tavern_helper?.scripts ?? [];
    const byId = new Map(flattenScripts(trees).filter(x => x.type === 'script').map(x => [x.id, x]));
    const placed = new Set(), restored = [];
    for (const node of layout) {
        if (node.type === 'folder') {
            const children = (node.scripts ?? []).flatMap(ref => {
                const script = byId.get(ref.id); if (!script || placed.has(ref.id)) return [];
                placed.add(ref.id);
                return [{ ...script, enabled: script.enabled === ref.exportedEnabled ? ref.enabled : script.enabled }];
            });
            restored.push({ ...node, scripts: children });
        } else if (byId.has(node.id) && !placed.has(node.id)) { restored.push(byId.get(node.id)); placed.add(node.id); }
    }
    restored.push(...[...byId.values()].filter(x => !placed.has(x.id)));
    result.extensions.tavern_helper.scripts = restored;
    return result;
}
function missingRequiredScripts(preset) {
    const present = new Set(flattenScripts(preset.extensions?.tavern_helper?.scripts ?? []).filter(x => x.type === 'script').map(x => x.id));
    return (preset.extensions?.[META_KEY]?.requiredScriptIds ?? []).filter(id => !present.has(id));
}
function scriptReport(preset) {
    return flattenScripts(preset.extensions?.tavern_helper?.scripts ?? []).filter(x => x.type === 'script').map(script => ({ id: script.id, name: script.name, enabled: script.enabled, updater: script.id === UPDATER_ID }));
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

async function mergeRecords(locals, remotes, base, key, protectedFields, keepEdits, conflicts, requiredIds = []) {
    const localMap = new Map(locals.map(x => [x[key], x]));
    const remoteIds = new Set(remotes.map(x => x[key]));
    const result = [];
    for (const remote of remotes) {
        const local = localMap.get(remote[key]);
        // A locally deleted managed item stays deleted. The updater itself is required.
        if (!local && base[remote[key]] && remote[key] !== UPDATER_ID && !requiredIds.includes(remote[key])) continue;
        // Required author scripts are the executable update payload. Always take
        // their published source so an old locally edited body cannot leave the
        // preset showing a new release number while still running stale code.
        const keepLocalFields = keepEdits && remote[key] !== UPDATER_ID && !requiredIds.includes(remote[key]);
        result.push(local ? await mergeFields(local, remote, base[remote[key]], protectedFields, keepLocalFields, conflicts) : clone(remote));
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
    const flat = await mergeRecords(flattenScripts(locals), flattenScripts(remotes), base.scripts, 'id', ['enabled', 'data', 'button', 'scripts'], keepEdits, conflicts, remote.extensions[META_KEY].requiredScriptIds ?? []);
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
    if (missingRequiredScripts(preset).length) throw Error('更新包缺少配套脚本。');
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
    const repairing = manifest.revision === revision && options.repairMissingScripts && missingRequiredScripts(snapshot.active).length > 0;
    if (manifest.revision < revision || (manifest.revision === revision && !repairing)) throw Error('当前版本已经是最新版本。');
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
// Remove the old release's controls when upgrading in the same page.
for (const id of ['nue-sl-update-entry', 'nue-sl-update-panel']) doc.getElementById(id)?.remove();
let disposed = false, busy = false, pending = null, lastCheck = 0, retryAfter = 0, controller, generating = false;
const checkInterval = 30 * 60 * 1000;
const options = { rename: true, keepEdits: true, syncSettings: false, repairMissingScripts: true };
try {
    const saved = JSON.parse(win.localStorage.getItem(storageKey) ?? '{}');
    // Old autoCheck/autoApply=false must not disable the new automatic behavior.
    for (const key of ['rename', 'keepEdits', 'syncSettings']) if (typeof saved[key] === 'boolean') options[key] = saved[key];
} catch { /* Use defaults if previous settings were malformed. */ }
const ctx = context(), generationEvents = [];
for (const [key, value] of [['GENERATION_STARTED', true], ['GENERATION_ENDED', false], ['GENERATION_STOPPED', false]]) {
    const event = (ctx.eventTypes ?? ctx.event_types)?.[key];
    if (event && ctx.eventSource?.on) {
        const handler = () => { generating = value; };
        ctx.eventSource.on(event, handler); generationEvents.push([event, handler]);
    }
}
function isIdle() {
    const current = context(), stop = doc.querySelector('#mes_stop');
    const stopVisible = stop && win.getComputedStyle(stop).display !== 'none' && stop.getClientRects().length > 0;
    return current.mainApi === 'openai' && !(generating || stopVisible || doc.body.dataset.generating === 'true'
        || (current.streamingProcessor && !current.streamingProcessor.isFinished) || doc.querySelector('dialog[open]'));
}
function snapshot() {
    const name = manager.getSelectedPresetName(), saved = manager.getCompletionPresetByName(name);
    if (!saved) throw Error('无法读取当前预设。');
    return { name, saved: clone(saved), active: activePresetSnapshot(saved, context().chatCompletionSettings) };
}
function metadata() { return snapshot().active.extensions?.[META_KEY]; }
function ownsSelection() { try { return metadata()?.presetId === CONFIG.presetId; } catch { return false; } }
function getBackup() {
    const value = JSON.parse(win.localStorage.getItem(backupKey) ?? 'null');
    if (value && (value.schema !== 1 || value.active?.extensions?.[META_KEY]?.presetId !== CONFIG.presetId)) throw Error('备份格式不正确。');
    return value;
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
        if (newName !== oldName && retainOld) { manager.updateList(newName, clone(value)); return; }
        presets[oldIndex] = clone(value);
        if (newName !== oldName) {
            delete preset_names[oldName]; preset_names[newName] = oldIndex;
            const option = Array.from(doc.querySelector('#settings_preset_openai').options).find(x => x.value === String(oldIndex));
            if (option) option.textContent = newName;
        }
        // Reloading this preset can destroy the updater iframe: always last.
        void manager.selectPreset(String(oldIndex));
    },
};
async function request(path) {
    const requestController = new AbortController(); controller = requestController;
    const timeout = setTimeout(() => requestController.abort(), 20000);
    try {
        const url = new URL(path, rootUrl); url.searchParams.set('_sl', String(Date.now()));
        const response = await win.fetch(url.href, { cache: 'no-store', credentials: 'omit', signal: requestController.signal });
        if (!response.ok) throw Error(`获取更新失败（${response.status}）。`);
        const body = await response.text();
        if (body.length > 12_000_000) throw Error('更新文件异常大。');
        return body;
    } finally { clearTimeout(timeout); if (controller === requestController) controller = null; }
}
async function exclusive(work) {
    if (win.navigator.locks) return win.navigator.locks.request(`sl-update-${CONFIG.presetId}`, { ifAvailable: true }, lock => {
        if (!lock) throw Error('另一个酒馆页面正在更新这套预设。');
        return work();
    });
    return work();
}
async function tick() {
    if (disposed || busy || !ownsSelection() || !isIdle() || Date.now() < retryAfter) return;
    busy = true;
    try {
        if (Date.now() - lastCheck >= checkInterval) {
            lastCheck = Date.now();
            const manifest = validateManifest(JSON.parse(await request('update.json')), CONFIG.presetId);
            if (disposed || !ownsSelection()) return;
            const current = snapshot().active;
            pending = manifest.revision > metadata().revision || (manifest.revision === metadata().revision && missingRequiredScripts(current).length) ? manifest : null;
        }
        if (!pending || disposed || !ownsSelection() || !isIdle()) return;
        await exclusive(async () => {
            const manifest = clone(pending);
            const remote = await verifyPayload(await request(manifest.file), manifest);
            if (disposed || !ownsSelection() || !isIdle()) return;
            const wrapped = { ...host, activate(...args) {
                pending = null;
                win.toastr?.success?.(`已自动更新至 v${manifest.version}，刷新酒馆后全部配套脚本生效。`, 'SL 自动更新');
                host.activate(...args);
            } };
            const result = await installUpdate(wrapped, remote, manifest, options);
            if (result.deferred) {
                pending = null;
                win.toastr?.info?.(result.message, 'SL 自动更新');
            }
        });
    } catch (error) {
        // No UI on unchanged state or transient network failure; bounded retry.
        retryAfter = Date.now() + checkInterval;
        if (!disposed) console.warn('[SL 自动更新] 本次未完成，稍后再试：', error?.message ?? error);
    } finally { busy = false; }
}
const startupTimer = setTimeout(tick, 8000);
const interval = setInterval(tick, 30000);
function dispose() {
    if (disposed) return;
    disposed = true; controller?.abort(); clearTimeout(startupTimer); clearInterval(interval);
    for (const [event, handler] of generationEvents) ctx.eventSource?.removeListener?.(event, handler);
    if (win[slot]?.dispose === dispose) delete win[slot];
}
// Diagnostic/backup access only; nothing is inserted into the page.
win[slot] = { dispose, getBackup };
window.addEventListener('pagehide', dispose, { once: true });

})().catch(error => console.error("[SL 更新]", error));
