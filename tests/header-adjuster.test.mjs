import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const preset = JSON.parse(await readFile(new URL('../source/preset.json', import.meta.url), 'utf8'));
const script = preset.extensions.tavern_helper.scripts
    .find(item => item.type === 'folder' && item.name === 'SL')
    .scripts.find(item => item.id === '5785b764-ccc0-49e7-8f72-ada52a4ba84b').content;

function createHarness(model, sharedHost = {}) {
    const document = sharedHost.document ?? { defaultView: sharedHost };
    sharedHost.document = document;
    const lifecycle = new Map();
    const window = { document: {}, parent: sharedHost, addEventListener(name, fn) { lifecycle.set(name, fn); } };
    const events = [];
    const timers = [];
    const intervals = [];
    const updateCalls = [];
    let modelInput = model;
    const modelReads = [];
    let excludeBody = '';
    let savedSettings = 0;
    const prompts = [
        { id: 'head-1', name: '📚Top statement1', enabled: false },
        { id: 'head-2', name: '📚Top statement2', enabled: false },
        { id: 'model-f', name: '🟡✧GEMINI-F/GEMINI-4A', enabled: true },
        { id: 'model-p', name: '🟡✧GEMINI-P', enabled: false },
        { id: 'model-glm', name: '🟡✧GLM', enabled: false },
        { id: 'model-claude', name: '🟡✧CLAUDE', enabled: false },
        { id: 'cot-f', name: '📌☆Skip COT-F', enabled: false },
        { id: 'cot-normal', name: '📌☆Skip COT', enabled: true },
    ];
    const active = {
        prompts,
        prompts_unused: [], settings: {}, extensions: {},
    };
    const bindings = [];
    const jq = selector => {
        if (typeof selector === 'function') { selector(); return { length: 0 }; }
        if (selector === document) return { on: (...args) => { bindings.push(args); }, off() {} };
        const isModel = selector === '#custom_model_id';
        const isExclude = selector === '#custom_exclude_body';
        return {
            length: isModel || isExclude ? 1 : 0,
            val(value) {
                if (selector === '#custom_model_id') {
                    if (arguments.length) modelInput = value;
                    modelReads.push(modelInput);
                    return modelInput;
                }
                if (selector === '#custom_exclude_body') {
                    if (arguments.length) excludeBody = value;
                    return excludeBody;
                }
                return '';
            },
            prop() { return false; },
            trigger() { return this; },
            each() { return this; },
            on() { return this; },
        };
    };
    const SillyTavern = {
        mainApi: 'openai',
        chatCompletionSettings: { chat_completion_source: 'custom', custom_model: model },
        getChatCompletionModel: () => modelInput,
        saveSettingsDebounced: async () => { savedSettings++; },
    };
    const context = {
        window, document: window.document, $: jq, SillyTavern,
        console: { info() {}, warn() {}, error(...args) { throw new Error(args.join(' ')); } },
        toastr: { success() {} },
        tavern_events: { CHATCOMPLETION_SOURCE_CHANGED: 'source', CHATCOMPLETION_MODEL_CHANGED: 'model', SETTINGS_UPDATED: 'settings', PRESET_CHANGED: 'preset' },
        eventOn(name, handler) { events.push({ name, handler }); },
        getPreset() { return structuredClone(active); },
        getLoadedPresetName() { return 'SL'; },
        async updatePresetWith(name, updater) {
            updateCalls.push(name);
            Object.assign(active, updater(structuredClone(active)));
            return active;
        },
        setTimeout(callback, delay) { const item = { callback, delay, id: timers.length + 1 }; timers.push(item); return item.id; },
        clearTimeout(id) { const index = timers.findIndex(item => item.id === id); if (index >= 0) timers.splice(index, 1); },
        setInterval(callback, delay) { intervals.push({ callback, delay }); return intervals.length; },
        clearInterval() {},
    };
    context.$ = jq;
    vm.runInNewContext(script, context);
    const flushTimeouts = async () => {
        let guard = 0;
        while (true) {
            await new Promise(resolve => setImmediate(resolve));
            if (!timers.length) return;
            if (++guard > 30) throw new Error('timer loop did not settle');
            const item = timers.shift();
            await item.callback();
        }
    };
    const emitClick = selector => {
        const binding = bindings.find(([, delegated]) => delegated === selector);
        assert.ok(binding, `missing delegated handler for ${selector}`);
        binding.at(-1)({ target: {} });
    };
    const prompt = id => active.prompts.find(item => item.id === id);
    return {
        sharedHost, lifecycle, active, prompt, bindings, updateCalls, flushTimeouts, emitClick, setModel(value) {
            modelInput = value;
            SillyTavern.chatCompletionSettings.custom_model = value;
        },
        get excludeBody() { return excludeBody; },
        get modelInput() { return modelInput; },
        get savedSettings() { return savedSettings; },
        modelReads,
        intervals,
    };
}

test('known 5.3 preset-toggle path and separate API header/Flash-parameter rules', async () => {
    const harness = createHarness('gemini-4-argon-抗截断');
    await harness.flushTimeouts();
    assert.equal(harness.prompt('head-1').enabled, false);
    assert.equal(harness.prompt('head-2').enabled, true);
    assert.equal(harness.prompt('cot-f').enabled, true);
    assert.equal(harness.prompt('cot-normal').enabled, false);
    assert.equal(harness.excludeBody, '');

    // Simulate Tavern's active preset state after the user chooses GEMINI-P.
    harness.prompt('model-p').enabled = true;
    harness.emitClick('.prompt-manager-toggle-action');
    await harness.flushTimeouts();
    assert.equal(harness.prompt('model-f').enabled, false);
    assert.equal(harness.prompt('model-p').enabled, true);
    assert.equal(harness.prompt('cot-f').enabled, false);
    assert.equal(harness.prompt('cot-normal').enabled, true);
    assert.equal(harness.prompt('head-2').enabled, true, 'API model should control the header independently');

    harness.setModel('gemini-3.7-flash');
    const inputBinding = harness.bindings.find(([, delegated]) => delegated === '#custom_model_id, #model_custom_select');
    assert.ok(inputBinding);
    assert.equal(harness.modelInput, 'gemini-3.7-flash');
    inputBinding.at(-1)();
    await harness.flushTimeouts();
    assert.equal(harness.prompt('head-1').enabled, true, JSON.stringify({ calls: harness.updateCalls, modelReads: harness.modelReads, head1: harness.prompt('head-1'), head2: harness.prompt('head-2') }));
    assert.equal(harness.prompt('head-2').enabled, false);
    assert.equal(harness.prompt('model-p').enabled, true);
    assert.equal(harness.prompt('cot-normal').enabled, true);
    assert.match(harness.excludeBody, /- top_p/);
    assert.equal(harness.savedSettings, 1);

    for (const id of ['model-glm', 'model-claude', 'model-f', 'model-p']) {
        harness.prompt(id).enabled = true;
        harness.emitClick('.prompt-manager-toggle-action');
        await harness.flushTimeouts();
        for (const candidate of ['model-f', 'model-p', 'model-glm', 'model-claude']) {
            assert.equal(harness.prompt(candidate).enabled, candidate === id);
        }
        assert.equal(harness.prompt('cot-f').enabled, id === 'model-f');
        assert.equal(harness.prompt('cot-normal').enabled, id !== 'model-f');
    }

    harness.setModel('pg-gemin-4-argon-抗截断');
    inputBinding.at(-1)();
    await harness.flushTimeouts();
    assert.equal(harness.prompt('head-2').enabled, true);
    assert.equal(harness.prompt('head-1').enabled, false);
    assert.equal(harness.excludeBody, '');
});

test('preset iframe reload starts with a fresh guard even if the previous release left a parent flag', async () => {
    const parent = { __sl_header_adjuster_v53_linkage_initialized__: true };
    const first = createHarness('gemini-4-argon', parent);
    await first.flushTimeouts();
    assert.equal(first.prompt('head-2').enabled, true);
    first.lifecycle.get('pagehide')();
    const reloaded = createHarness('gemini-3.8-flash', parent);
    await reloaded.flushTimeouts();
    assert.equal(reloaded.prompt('head-1').enabled, true);
    assert.equal(reloaded.prompt('cot-f').enabled, true);
    assert.match(reloaded.excludeBody, /- temperature/);
});
