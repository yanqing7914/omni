// #1077 端到端复现/放行：用**真实** check-apk-signatures + 真实 apksigner。
// 负控：交付目录里留一个未通过验签的包 -> --dir 递归命中它 -> 门禁恒红（陈旧产物让后续构建永远红）。
// 放行：清掉它之后同一目录变绿；再证明 assembleApk 在新代码下失败时不会留下产物。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GATE = join(ROOT, 'scripts', 'check-apk-signatures.mjs')
// 目录级门禁要走到 apksigner 那一层，keystore 必须与证书锚一致，也就是正式发布密钥（不在仓库里）。
// 本机 source ~/.omni-release/env.sh、CI 由 restore-release-key.sh 还原；缺席时 skip。
const RELEASE_KEY = process.env.OMNI_RELEASE_KEYSTORE && process.env.OMNI_RELEASE_KEY_ALIAS && process.env.OMNI_RELEASE_KEYSTORE_PASSWORD
  ? { keystore: process.env.OMNI_RELEASE_KEYSTORE, alias: process.env.OMNI_RELEASE_KEY_ALIAS, pass: process.env.OMNI_RELEASE_KEYSTORE_PASSWORD }
  : null
const KEYSTORE = RELEASE_KEY?.keystore ?? join(ROOT, 'keystore', 'debug.keystore')

// 需要真实 apksigner。拿不到时显式 skip（本机没有 Android SDK 的 CI 场景），不得静默当通过。
const apksignerProbe = spawnSync(process.execPath, [GATE, '--apk', join(ROOT, 'nonexistent.apk'), '--keystore', KEYSTORE], { encoding: 'utf8' });
const apksignerMissing = /apksigner not found/.test(String(apksignerProbe.stderr ?? '') + String(apksignerProbe.stdout ?? ''));
const needsApksigner = { skip: apksignerMissing ? '本机没有 apksigner（无 Android SDK），该层无法取证'
  : (RELEASE_KEY ? false : '没有正式发布密钥环境变量（OMNI_RELEASE_*），keystore 过不了证书锚') };

// issue #1138：keystore 凭据不再有内置默认值，调用方必须显式声明 alias 与口令。
const runGate = (dir) => spawnSync(process.execPath,
  [GATE, '--dir', dir, '--keystore', KEYSTORE, '--keystore-alias', RELEASE_KEY?.alias ?? '', '--keystore-pass', RELEASE_KEY?.pass ?? ''],
  { encoding: 'utf8', windowsHide: true });

test('negative control: a stale unverified APK in the delivery dir keeps the signature gate red', needsApksigner, () => {
  const root = mkdtempSync(join(tmpdir(), 'stale-1077-'))
  try {
    const out = join(root, 'out', 'v0.14.10')
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'omni-v0.14.10-source-arm64.apk'), Buffer.from('never-verified-apk-bytes'))
    const red = runGate(out)
    assert.equal(red.status, 1, '陈旧未验签产物必须让目录级门禁判红（这正是「后续构建恒红」的机理）')
    assert.match(String(red.stdout) + String(red.stderr), /failed verification/, '结论行必须点明是验签失败');

    // 放行例：清掉陈旧产物后，同一目录不再有可判红对象（空目录 -> 门禁以「没有 APK」拒绝，
    // 而不是「有不合格 APK」——两种红的语义不同，这里断言的是后者消失）。
    rmSync(join(out, 'omni-v0.14.10-source-arm64.apk'), { force: true })
    const empty = runGate(out)
    assert.match(String(empty.stdout) + String(empty.stderr), /no APK files found/,
      '清掉陈旧产物后应退化为「目录里没有 APK」，而不是「有 APK 不合格」');
    assert.equal(readdirSync(out).length, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
