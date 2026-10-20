import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { META_KEY, clone, makeBaseline } from '../src/core.mjs';
import { installUpdate } from '../src/transaction.mjs';

const fixture = JSON.parse(await readFile(new URL('../dist/preset.json', import.meta.url), 'utf8'));
async function setup() {
    const remote = clone(fixture);
    const meta = remote.extensions[META_KEY];
    meta.revision++; meta.version = '5.3.1'; meta.displayName = 'SL 5.3.1';
    remote.prompts[0].content = 'updated'; meta.baseline = await makeBaseline(remote);
    const state = { name: 'SL 5.3', active: clone(fixture), saved: clone(fixture) };
    state.active.prompts[2].content = '未点击保存的用户修改';
    const calls = [], files = new Map([['SL 5.3', clone(fixture)]]);
    let idle = true;
    const host = {
        snapshot: () => clone(state), isIdle: () => idle, names: () => [...files.keys()],
        backup: backup => calls.push(['backup', backup]),
        async save(name, value) { calls.push(['save', name]); files.set(name, clone(value)); },
        async remove(name) { calls.push(['remove', name]); files.delete(name); },
        activate(oldName, name, value, retained) { calls.push(['activate', name, retained]); state.name = name; state.active = clone(value); state.saved = clone(value); },
    };
    return { remote, manifest: meta, state, calls, files, host, setIdle: x => { idle = x; } };
}
const options = { rename: true, keepEdits: true, syncSettings: false };

test('完整更新先备份、确认保存，再删除旧名，最后刷新；备份含未保存改动', async () => {
    const f = await setup();
    const result = await installUpdate(f.host, f.remote, f.manifest, options);
    assert.deepEqual(f.calls.map(x => x[0]), ['backup', 'save', 'remove', 'activate']);
    assert.equal(f.calls[0][1].active.prompts[2].content, '未点击保存的用户修改');
    assert.equal(f.state.name, 'SL 5.3.1');
    assert.equal(f.files.has('SL 5.3'), false);
    assert.equal(result.deferred, false);
});

test('同名冲突、生成中、备份存储满和网络写入失败均不会删除旧预设', async () => {
    for (const scenario of ['collision', 'generating', 'quota', 'network']) {
        const f = await setup();
        if (scenario === 'collision') f.files.set('SL 5.3.1', {});
        if (scenario === 'generating') f.setIdle(false);
        if (scenario === 'quota') f.host.backup = () => { throw Error('quota'); };
        if (scenario === 'network') f.host.save = async () => { throw Error('network'); };
        await assert.rejects(installUpdate(f.host, f.remote, f.manifest, options));
        assert.equal(f.state.name, 'SL 5.3');
        assert.equal(f.files.has('SL 5.3'), true);
        assert.ok(!f.calls.some(x => x[0] === 'remove' || x[0] === 'activate'));
    }
});

test('下载合并期间切换预设会在写入前停止', async () => {
    const f = await setup(); let reads = 0;
    f.host.snapshot = () => { if (++reads === 2) f.state.name = 'other'; return clone(f.state); };
    await assert.rejects(installUpdate(f.host, f.remote, f.manifest, options), /变化/);
    assert.deepEqual(f.calls, []);
});

test('保存请求中途切档或开始生成，只报告已保存且不切换用户界面', async () => {
    for (const change of ['switch', 'generate', 'edit']) {
        const f = await setup(), save = f.host.save;
        f.host.save = async (...args) => {
            await save(...args);
            if (change === 'switch') f.state.name = 'other';
            if (change === 'generate') f.setIdle(false);
            if (change === 'edit') f.state.active.prompts[3].content = '请求期间的新修改';
        };
        const result = await installUpdate(f.host, f.remote, f.manifest, options);
        assert.equal(result.deferred, true);
        assert.deepEqual(f.calls.map(x => x[0]), ['backup', 'save']);
        assert.equal(f.files.has('SL 5.3.1'), true);
        assert.equal(f.files.has('SL 5.3'), true);
    }
});

test('删除旧名称失败时保留两份并报告，不冒充已清理', async () => {
    const f = await setup(); f.host.remove = async () => { throw Error('offline'); };
    const result = await installUpdate(f.host, f.remote, f.manifest, options);
    assert.equal(result.oldRetained, true);
    assert.equal(f.files.has('SL 5.3'), true);
    assert.equal(f.state.name, 'SL 5.3.1');
});

test('关闭同步名称后原地更新，不删旧名称；拒绝版本倒退', async () => {
    const f = await setup();
    await installUpdate(f.host, f.remote, f.manifest, { ...options, rename: false });
    assert.equal(f.state.name, 'SL 5.3');
    assert.ok(!f.calls.some(x => x[0] === 'remove'));
    await assert.rejects(installUpdate(f.host, f.remote, f.manifest, options), /最新/);
});
