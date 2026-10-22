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

test('API model alone selects the family, header, and COT tail across repeated switches', async () => {
    const harness = createHarness('pg-gemini-4-argon-抗截断');
    await harness.flushTimeouts();
    const input = harness.bindings.find(([, selector]) => selector === '#custom_model_id, #model_custom_select').at(-1);
    const cases = [
        ['pg-gemini-4-argon-抗截断', 'model-f', true, false],
        ['gemini-3.7-flash', 'model-f', false, true],
        ['gemini-3.8-pro', 'model-p', false, false],
        ['gmnpro', 'model-p', false, false],
        ['gmn-3.8', 'model-f', false, false],
        ['zai-org/GLM-4.7', 'model-glm', false, false],
        ['claude-sonnet-4-5', 'model-claude', false, false],
        ['anthropic/opus-4.5', 'model-claude', false, false],
        ['gemin-4-argon', 'model-f', true, false],
        ['google/gemini-3.8-flash', 'model-f', false, true],
    ];
    for (const [model, selectedId, argon, parameters] of cases) {
        harness.setModel(model); input(); await harness.flushTimeouts();
        for (const id of ['model-f', 'model-p', 'model-glm', 'model-claude']) {
            assert.equal(harness.prompt(id).enabled, id === selectedId, model + ': ' + id);
        }
        assert.equal(harness.prompt('cot-f').enabled, selectedId === 'model-f', model);
        assert.equal(harness.prompt('cot-normal').enabled, selectedId !== 'model-f', model);
        assert.equal(harness.prompt('head-2').enabled, argon, model);
        assert.equal(harness.prompt('head-1').enabled, !argon, model);
        assert.equal(Boolean(harness.excludeBody), parameters, model);
    }
    // Manual prompt changes cannot become an alternative model source.
    harness.prompt('model-glm').enabled = true;
    harness.emitClick('.prompt-manager-toggle-action'); await harness.flushTimeouts();
    assert.equal(harness.prompt('model-glm').enabled, false);
    assert.equal(harness.prompt('model-f').enabled, true);

    // Unknown API names preserve the existing family and tail.
    harness.setModel('unknown-model'); input(); await harness.flushTimeouts();
    assert.equal(harness.prompt('model-f').enabled, true);
    assert.equal(harness.prompt('cot-f').enabled, true);
    assert.equal(harness.prompt('head-1').enabled, true);
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
