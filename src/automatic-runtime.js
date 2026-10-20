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
const options = { rename: true, keepEdits: true, syncSettings: false };
try {
    const saved = JSON.parse(win.localStorage.getItem(storageKey) ?? '{}');
    // Old autoCheck/autoApply=false must not disable the new automatic behavior.
    for (const key of Object.keys(options)) if (typeof saved[key] === 'boolean') options[key] = saved[key];
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
            pending = manifest.revision > metadata().revision ? manifest : null;
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
