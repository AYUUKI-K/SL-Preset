import { META_KEY, clone, same, mergePreset } from './core.mjs';

// The host adapter keeps writes and the final UI reload separate. Reloading a
// preset can destroy the updater iframe, so it must always be the last step.
export async function installUpdate(host, remote, manifest, options) {
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
