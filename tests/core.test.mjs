import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { META_KEY, UPDATER_ID, clone, makeBaseline, mergePreset, validatePreset, validateManifest, verifyPayload, flattenScripts, activePresetSnapshot } from '../src/core.mjs';

const built = JSON.parse(await readFile(new URL('../dist/preset.json', import.meta.url), 'utf8'));
const original = JSON.parse((await readFile(new URL('../source/preset.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
const manifest = JSON.parse(await readFile(new URL('../update.json', import.meta.url), 'utf8'));
test('真实宿主字段别名正确映射，当前未保存编辑及未知原始字段保留', () => {
    const saved = clone(built), settings = clone(built);
    settings.temp_openai = 0.19; settings.freq_pen_openai = 0.25;
    settings.prompts[0].content = '当前未保存正文';
    settings.preset_settings_openai = '这不是预设参数';
    settings.custom_url = '不应混入发布内容的连接设置';
    saved.future_field = { foo: 'bar' };
    const result = activePresetSnapshot(saved, settings);
    assert.equal(result.temperature, 0.19);
    assert.equal(result.frequency_penalty, 0.25);
    assert.equal(result.prompts[0].content, '当前未保存正文');
    assert.deepEqual(result.future_field, { foo: 'bar' });
    assert.equal(result.custom_url, undefined);
    assert.equal(result.preset_settings_openai, undefined);
});
async function remote() {
    const value = clone(built);
    value.extensions[META_KEY].revision++;
    value.extensions[META_KEY].version = '5.3.1';
    value.extensions[META_KEY].displayName = 'SL 5.3.1 测试';
    value.prompts[0].content = 'new-author-content';
    value.prompts[0].name = '作者更新后的名称';
    value.extensions.regex_scripts[0].scriptName = '新版正则名称';
    value.extensions.regex_scripts[0].replaceString = '<b>新版美化</b>';
    value.extensions.tavern_helper.scripts[0].scripts[0].content = 'new-script-code';
    value.extensions.tavern_helper.scripts[0].name = '新版脚本分组';
    value.extensions[META_KEY].baseline = await makeBaseline(value);
    return value;
}

test('包装后逐项保留原预设的提示词、参数、分组、正则和三个脚本', () => {
    const roundtrip = clone(built);
    delete roundtrip.extensions[META_KEY];
    roundtrip.extensions.tavern_helper.scripts = roundtrip.extensions.tavern_helper.scripts.filter(x => x.id !== UPDATER_ID);
    assert.deepEqual(roundtrip, original);
    assert.equal(built.prompts.length, original.prompts.length);
    assert.equal(built.extensions.regex_scripts.length, original.extensions.regex_scripts.length);
    assert.equal(flattenScripts(built.extensions.tavern_helper.scripts).filter(x => x.type === 'script').length, flattenScripts(original.extensions.tavern_helper.scripts).filter(x => x.type === 'script').length + 1);
});

test('完整包摘要和版本校验通过；损坏、跨预设、缺失更新器和基线篡改被拒绝', async () => {
    const text = await readFile(new URL('../dist/preset.json', import.meta.url), 'utf8');
    assert.deepEqual(await verifyPayload(text, manifest), built);
    await assert.rejects(verifyPayload(text + ' ', manifest), /校验失败/);
    assert.throws(() => validateManifest({ ...manifest, presetId: 'another' }, manifest.presetId), /格式/);
    assert.throws(() => validateManifest({ ...manifest, file: 'dist/../../x.json' }, manifest.presetId), /格式/);
    const bad = clone(built); bad.extensions[META_KEY].presetId = 'another';
    await assert.rejects(mergePreset(built, bad), /不属于/);
});

test('无本地修改时更新正文和各类名称；保留开关、脚本数据、未知扩展及采样参数', async () => {
    const local = clone(built), incoming = await remote();
    local.temperature = 0.32;
    local.prompt_order[0].order[0].enabled = false;
    local.extensions.regex_scripts[0].disabled = true;
    local.extensions.tavern_helper.scripts[0].scripts[0].data = { userSetting: 42 };
    local.extensions.tavern_helper.variables.custom = 'keep';
    local.extensions.someOtherPlugin = { x: 5 };
    const { preset, conflicts } = await mergePreset(local, incoming);
    assert.equal(preset.prompts[0].content, incoming.prompts[0].content);
    assert.equal(preset.prompts[0].name, '作者更新后的名称');
    assert.equal(preset.extensions.regex_scripts[0].scriptName, '新版正则名称');
    assert.equal(preset.extensions.regex_scripts[0].disabled, true);
    assert.equal(preset.prompt_order[0].order[0].enabled, false);
    assert.equal(preset.extensions.tavern_helper.scripts[0].scripts[0].content, 'new-script-code');
    assert.deepEqual(preset.extensions.tavern_helper.scripts[0].scripts[0].data, { userSetting: 42 });
    assert.equal(preset.extensions.tavern_helper.scripts[0].name, '新版脚本分组');
    assert.equal(preset.extensions.tavern_helper.variables.custom, 'keep');
    assert.deepEqual(preset.extensions.someOtherPlugin, { x: 5 });
    assert.equal(preset.temperature, 0.32);
    assert.equal(conflicts.length, 0);
    const synced = await mergePreset(local, incoming, { syncSettings: true });
    assert.equal(synced.preset.temperature, incoming.temperature);
});

test('字段级合并保留用户改写的正文，但仍更新作者名称；可选择覆盖修改', async () => {
    const local = clone(built), incoming = await remote();
    local.prompts[0].content = '我的提示词';
    local.extensions.regex_scripts[0].replaceString = '我的美化';
    local.extensions.tavern_helper.scripts[0].scripts[0].content = '我的脚本';
    const merged = await mergePreset(local, incoming);
    assert.equal(merged.preset.prompts[0].content, '我的提示词');
    assert.equal(merged.preset.prompts[0].name, '作者更新后的名称');
    assert.equal(merged.preset.extensions.regex_scripts[0].replaceString, '我的美化');
    assert.equal(merged.preset.extensions.tavern_helper.scripts[0].scripts[0].content, '我的脚本');
    assert.equal(merged.conflicts.length, 3);
    const forced = await mergePreset(local, incoming, { keepEdits: false });
    assert.equal(forced.preset.prompts[0].content, incoming.prompts[0].content);
    assert.equal(forced.preset.extensions.regex_scripts[0].replaceString, incoming.extensions.regex_scripts[0].replaceString);
});

test('新增作者条目与自定义条目均保留，自定义条目相对锚点不丢失', async () => {
    const local = clone(built), incoming = await remote();
    const custom = { ...clone(local.prompts[0]), identifier: 'user-only', name: '我的补充', content: 'custom' };
    local.prompts.push(custom);
    const anchor = local.prompt_order[0].order[1].identifier;
    local.prompt_order[0].order.splice(2, 0, { identifier: custom.identifier, enabled: false });
    incoming.prompts.push({ ...custom, identifier: 'author-added', content: 'new' });
    incoming.prompt_order[0].order.push({ identifier: 'author-added', enabled: true });
    incoming.extensions[META_KEY].baseline = await makeBaseline(incoming);
    const { preset } = await mergePreset(local, incoming);
    const order = preset.prompt_order[0].order;
    assert.equal(order[order.findIndex(x => x.identifier === anchor) + 1].identifier, 'user-only');
    assert.equal(order.find(x => x.identifier === 'user-only').enabled, false);
    assert.ok(order.some(x => x.identifier === 'author-added'));
    assert.deepEqual(preset.prompts.find(x => x.identifier === 'user-only'), custom);
});

test('用户已删除的管理条目不复活；作者删除的未改条目移除，已改条目保留', async () => {
    const local = clone(built), incoming = await remote();
    const id = local.prompts[0].identifier;
    local.prompts = local.prompts.filter(x => x.identifier !== id);
    local.prompt_order[0].order = local.prompt_order[0].order.filter(x => x.identifier !== id);
    const deleted = await mergePreset(local, incoming);
    assert.ok(!deleted.preset.prompts.some(x => x.identifier === id));
    const authoredId = incoming.prompts[1].identifier;
    incoming.prompts = incoming.prompts.filter(x => x.identifier !== authoredId);
    incoming.prompt_order[0].order = incoming.prompt_order[0].order.filter(x => x.identifier !== authoredId);
    incoming.extensions[META_KEY].baseline = await makeBaseline(incoming);
    const unedited = await mergePreset(built, incoming);
    assert.ok(!unedited.preset.prompts.some(x => x.identifier === authoredId));
    const edited = clone(built); edited.prompts[1].content = '用户保留的版本';
    const kept = await mergePreset(edited, incoming);
    assert.equal(kept.preset.prompts.find(x => x.identifier === authoredId).content, '用户保留的版本');
});

test('脚本移动分组保留本地数据，删除作者分组不丢用户新增脚本', async () => {
    const local = clone(built), incoming = await remote();
    const script = local.extensions.tavern_helper.scripts[0].scripts[0];
    script.data = { hello: 'world' };
    const moved = incoming.extensions.tavern_helper.scripts[0].scripts.shift();
    incoming.extensions.tavern_helper.scripts.push(moved);
    incoming.extensions[META_KEY].baseline = await makeBaseline(incoming);
    const merged = await mergePreset(local, incoming);
    assert.deepEqual(merged.preset.extensions.tavern_helper.scripts.find(x => x.id === script.id).data, { hello: 'world' });
    local.extensions.tavern_helper.scripts[0].scripts.push({ ...clone(script), id: 'user-script', name: '用户脚本' });
    incoming.extensions.tavern_helper.scripts = incoming.extensions.tavern_helper.scripts.filter(x => x.type !== 'folder');
    incoming.extensions[META_KEY].baseline = await makeBaseline(incoming);
    const removed = await mergePreset(local, incoming);
    assert.ok(flattenScripts(removed.preset.extensions.tavern_helper.scripts).some(x => x.id === 'user-script'));
});

test('更新器源码始终升级，自身不受保留本地修改开关阻挡', async () => {
    const local = clone(built), incoming = await remote();
    local.extensions.tavern_helper.scripts.find(x => x.id === UPDATER_ID).content = 'old-local-runtime';
    const { preset } = await mergePreset(local, incoming);
    assert.equal(preset.extensions.tavern_helper.scripts.find(x => x.id === UPDATER_ID).content, incoming.extensions.tavern_helper.scripts.find(x => x.id === UPDATER_ID).content);
});

test('连续两次更新仍能识别第一轮后保留的本地正文', async () => {
    const local = clone(built), incoming = await remote();
    local.prompts[0].content = '用户长期自定义';
    const first = await mergePreset(local, incoming);
    incoming.prompts[0].content = '下一版作者正文'; incoming.extensions[META_KEY].revision++;
    incoming.extensions[META_KEY].baseline = await makeBaseline(incoming);
    const second = await mergePreset(first.preset, incoming);
    assert.equal(second.preset.prompts[0].content, '用户长期自定义');
});

test('无效排序与重复 ID 被拒绝', () => {
    const duplicate = clone(built); duplicate.prompts.push(clone(duplicate.prompts[0]));
    assert.throws(() => validatePreset(duplicate), /重复/);
    const missing = clone(built); missing.prompt_order[0].order.push({ identifier: 'not-real', enabled: true });
    assert.throws(() => validatePreset(missing), /不存在/);
});
