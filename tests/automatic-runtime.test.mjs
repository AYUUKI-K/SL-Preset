import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { clone, META_KEY, makeBaseline } from '../src/core.mjs';

const bundle = await readFile(new URL('../dist/updater.js', import.meta.url), 'utf8');
const fixture = JSON.parse(await readFile(new URL('../dist/preset.json', import.meta.url), 'utf8'));
async function setup({ latest = false, fail = false, legacyDisabled = false } = {}) {
    const next = clone(fixture), meta = next.extensions[META_KEY];
    if (!latest) { meta.revision++; meta.version = '5.3.2'; meta.displayName = 'SL 自动更新模拟版'; next.prompts[0].content = '新版正文'; }
    meta.baseline = await makeBaseline(next);
    const payload = JSON.stringify(next);
    const manifest = { schema: 1, presetId: meta.presetId, version: meta.version, revision: meta.revision, displayName: meta.displayName, file: 'dist/preset.json', sha256: createHash('sha256').update(payload).digest('hex') };
    const key = 'nue.sl.updater.nue.sl.preset';
    const storage = new Map(legacyDisabled ? [[key, JSON.stringify({ autoCheck: false, autoApply: false })]] : []);
    const timers = new Map(), intervals = new Map(), events = new Map(), calls = [], warnings = [], toasts = [], removed = [];
    let now = 2_000_000_000_000, timerId = 0, modal = false;
    const state = { selected: fixture.extensions[META_KEY].displayName, active: clone(fixture), presets: [clone(fixture)] };
    state.active.prompts[2].content = '用户未保存内容';
    const names = { [state.selected]: 0 }, options = [{ value: '0', textContent: state.selected }];
    const doc = {
        body: { dataset: {} },
        getElementById(id) { return { remove: () => removed.push(id) }; },
        createElement() { throw Error('自动模式不得新增页面控件'); },
        querySelector(selector) {
            if (selector === '#settings_preset_openai') return { options };
            if (selector === 'dialog[open]') return modal ? {} : null;
            return null;
        },
    };
    const manager = {
        getSelectedPresetName: () => state.selected,
        getCompletionPresetByName: name => state.presets[names[name]],
        getPresetList: () => ({ presets: state.presets, preset_names: names }),
        getAllPresets: () => Object.keys(names),
        async savePreset(name, preset) { calls.push(['save', name, clone(preset)]); },
        selectPreset(value) { calls.push(['activate']); state.selected = options[Number(value)].textContent; state.active = clone(state.presets[Number(value)]); },
    };
    const win = {
        document: doc, navigator: {},
        localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { calls.push(['storage', key]); storage.set(key, value); } },
        SillyTavern: { getContext: () => ({
            mainApi: 'openai', chatCompletionSettings: state.active, getPresetManager: () => manager,
            getRequestHeaders: () => ({}), eventTypes: { GENERATION_STARTED: 'start', GENERATION_ENDED: 'end', GENERATION_STOPPED: 'stop' },
            eventSource: { on: (key, handler) => events.set(key, handler), removeListener: key => events.delete(key) },
        }) },
        toastr: { success: text => toasts.push(text), info: text => toasts.push(text) },
        async fetch(url) {
            calls.push(['fetch', String(url)]);
            if (String(url).startsWith('/api/presets/delete')) return { ok: true };
            if (fail) return { ok: false, status: 503 };
            return { ok: true, text: async () => String(url).includes('update.json') ? JSON.stringify(manifest) : payload };
        },
    };
    const iframe = { parent: win, addEventListener: () => {} };
    class ClockDate extends Date { static now() { return now; } }
    const sandbox = vm.createContext({ window: iframe, Date: ClockDate, URL, TextEncoder, Uint8Array, AbortController, crypto: globalThis.crypto,
        console: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
        setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, clearTimeout: id => timers.delete(id),
        setInterval: (fn, delay) => { const id = ++timerId; intervals.set(id, { fn, delay }); return id; }, clearInterval: id => intervals.delete(id),
    });
    await new vm.Script(bundle).runInContext(sandbox);
    const startup = [...timers.values()].find(x => x.delay === 8000)?.fn;
    const interval = [...intervals.values()].find(x => x.delay === 30000)?.fn;
    assert.equal(typeof startup, 'function'); assert.equal(typeof interval, 'function');
    return { startup, interval, state, calls, storage, warnings, toasts, removed, events, win, doc,
        advance: ms => { now += ms; }, modal: value => { modal = value; } };
}

test('无需按钮、默认自动更新并同步名称，旧版的两个关闭设置不阻挡', async () => {
    const f = await setup({ legacyDisabled: true });
    await f.startup();
    assert.deepEqual(f.removed, ['nue-sl-update-entry', 'nue-sl-update-panel']);
    assert.equal(f.warnings.length, 0);
    assert.equal(f.state.selected, 'SL 自动更新模拟版');
    assert.equal(f.state.active.prompts[0].content, '新版正文');
    assert.equal(f.state.active.prompts[2].content, '用户未保存内容');
    assert.equal(f.toasts.length, 1);
    assert.ok(f.win.__NUE_SL_PRESET_UPDATER__.getBackup());
    await f.interval();
    assert.equal(f.calls.filter(x => x[0] === 'save').length, 1);
});

test('生成中不检查或写入；结束后下一次空闲检查自动应用', async () => {
    const f = await setup();
    f.events.get('start')();
    await f.startup(); assert.equal(f.calls.length, 0);
    f.events.get('end')();
    await f.interval(); assert.equal(f.state.selected, 'SL 自动更新模拟版');
});

test('其他弹窗打开时等待，关闭后自动应用', async () => {
    const f = await setup(); f.modal(true);
    await f.startup(); assert.equal(f.calls.length, 0);
    f.modal(false); await f.interval();
    assert.equal(f.calls.filter(x => x[0] === 'save').length, 1);
});

test('最新版保持安静，不创建按钮，不保存或反复检查', async () => {
    const f = await setup({ latest: true }); await f.startup(); await f.interval();
    assert.equal(f.calls.filter(x => x[0] === 'fetch').length, 1);
    assert.equal(f.calls.filter(x => x[0] === 'save').length, 0);
    assert.equal(f.toasts.length, 0); assert.equal(f.warnings.length, 0);
});

test('网络失败后等待半小时重试，保留原预设且无失败弹窗', async () => {
    const f = await setup({ fail: true }); await f.startup(); await f.interval();
    assert.equal(f.calls.length, 1); assert.equal(f.warnings.length, 1);
    assert.equal(f.toasts.length, 0);
    f.advance(30 * 60 * 1000); await f.interval();
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls.filter(x => x[0] === 'save').length, 0);
});

test('卸载清除定时任务和事件，后续回调不再联网', async () => {
    const f = await setup(); f.win.__NUE_SL_PRESET_UPDATER__.dispose(); await f.interval();
    assert.equal(f.events.size, 0); assert.equal(f.calls.length, 0);
});
