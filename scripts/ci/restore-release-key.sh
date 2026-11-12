#!/usr/bin/env bash
# 在 CI 里从 GitHub Secrets 还原 Omni 正式发布密钥，并把路径/口令/别名写进后续步骤的环境变量。
#
# 需要的 secrets（仓库 Settings → Secrets and variables → Actions），由 job 级 env 注入同名变量：
#   OMNI_RELEASE_KEYSTORE_BASE64   PKCS12 keystore 的 base64
#   OMNI_RELEASE_KEYSTORE_PASSWORD keystore 与私钥口令（同一个）
#   OMNI_RELEASE_KEY_ALIAS         私钥别名
#
# 缺任一个即失败：没有正式密钥签出的包过不了证书锚，不如一开始就停下。
# 密钥写到 $RUNNER_TEMP（job 结束即回收），不进工作区，避免被打包或上传。
set -euo pipefail

# 本机跑（如 run-local-source-chain.mjs）时已 source ~/.omni-release/env.sh：密钥文件就在本地，
# 不需要从 base64 还原，也没有 $GITHUB_ENV 可写，只核对指纹。
if [ -z "${GITHUB_ENV:-}" ] && [ -n "${OMNI_RELEASE_KEYSTORE:-}" ] && [ -f "${OMNI_RELEASE_KEYSTORE}" ]; then
  keystore="$OMNI_RELEASE_KEYSTORE"
  for name in OMNI_RELEASE_KEYSTORE_PASSWORD OMNI_RELEASE_KEY_ALIAS; do
    [ -n "${!name:-}" ] || { echo "缺少环境变量 ${name}（先 source ~/.omni-release/env.sh）"; exit 1; }
  done
else
  keystore=""
fi

if [ -z "$keystore" ]; then
for name in OMNI_RELEASE_KEYSTORE_BASE64 OMNI_RELEASE_KEYSTORE_PASSWORD OMNI_RELEASE_KEY_ALIAS; do
  if [ -z "${!name:-}" ]; then
    echo "::error::缺少 secret ${name}，无法用正式密钥签名（见 CONTRIBUTING.md「发版」）"
    exit 1
  fi
done

dir="${RUNNER_TEMP:?RUNNER_TEMP 未设置}/omni-release-key"
mkdir -p "$dir"
chmod 700 "$dir"
keystore="$dir/omni-release.p12"
printf '%s' "$OMNI_RELEASE_KEYSTORE_BASE64" | base64 -d > "$keystore"
chmod 600 "$keystore"

# 口令写进日志会被 GitHub 自动打码，这里额外显式 mask 一次。
echo "::add-mask::${OMNI_RELEASE_KEYSTORE_PASSWORD}"
fi

# 还原后立即确认 keystore 能打开、证书指纹等于仓库里的期望锚。
expected=$(node scripts/check-apk-signatures.mjs --print-expected-cert)
actual=$(keytool -exportcert -keystore "$keystore" -storetype PKCS12 \
  -storepass "$OMNI_RELEASE_KEYSTORE_PASSWORD" -alias "$OMNI_RELEASE_KEY_ALIAS" 2>/dev/null \
  | { command -v sha256sum >/dev/null && sha256sum || shasum -a 256; } | cut -d' ' -f1)
if [ "$actual" != "$expected" ]; then
  echo "::error::还原出的发布密钥证书指纹 ${actual:-<读取失败>} 与期望锚 ${expected} 不一致"
  exit 1
fi
echo "发布密钥已还原，证书指纹与期望锚一致：${expected}"

# 只导出 keystore 路径。口令与别名由 job 级 env 直接从 secrets 注入，不复制进 $GITHUB_ENV。
if [ -n "${GITHUB_ENV:-}" ]; then
  echo "OMNI_RELEASE_KEYSTORE=$keystore" >> "$GITHUB_ENV"
fi
