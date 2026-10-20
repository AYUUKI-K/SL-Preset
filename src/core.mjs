export const META_KEY = 'nue_sl_update';
export const UPDATER_ID = '9c79fdb7-86b1-4aec-9d6e-75992c4e8301';
export const clone = value => JSON.parse(JSON.stringify(value));
export const same = (a, b) => canonical(a) === canonical(b);

// Read through the host's public context, without importing ST modules into the
// helper iframe (which would instantiate a second, empty module state).
export function activePresetSnapshot(saved, settings) {
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

export async function digest(value) {
    const bytes = new TextEncoder().encode(canonical(value));
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
}

export function flattenScripts(trees) {
    return trees.flatMap(node => [node, ...(node.type === 'folder' ? flattenScripts(node.scripts ?? []) : [])]);
}

// Independent script entries also work in helper versions that cannot import folders.
// Keep the author layout separately so the local editor can recover its groups.
export function packageScriptTrees(trees) {
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
export function restoreScriptLayout(preset) {
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
export function missingRequiredScripts(preset) {
    const present = new Set(flattenScripts(preset.extensions?.tavern_helper?.scripts ?? []).filter(x => x.type === 'script').map(x => x.id));
    return (preset.extensions?.[META_KEY]?.requiredScriptIds ?? []).filter(id => !present.has(id));
}
export function scriptReport(preset) {
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

export function validatePreset(preset, expectedId) {
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

export async function makeBaseline(preset) {
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

export async function mergePreset(local, remote, options = {}) {
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

export function validateManifest(manifest, presetId) {
    if (manifest?.schema !== 1 || manifest.presetId !== presetId || !Number.isSafeInteger(manifest.revision) || manifest.revision < 1 || typeof manifest.version !== 'string' || typeof manifest.displayName !== 'string' || !manifest.displayName.trim() || /[\\/\x00-\x1f]/.test(manifest.displayName) || !/^[a-f0-9]{64}$/.test(manifest.sha256) || typeof manifest.file !== 'string' || !/^dist\/[a-zA-Z0-9._/-]+\.json$/.test(manifest.file) || manifest.file.includes('..')) throw Error('更新清单格式不正确。');
    return manifest;
}

export async function verifyPayload(text, manifest) {
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
