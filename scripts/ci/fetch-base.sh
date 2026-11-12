#!/usr/bin/env bash
# 从固定的 base-v1 Release 下载构建底座，按 base/*.tar.xz 里记录的 sha256 与大小校验后放到原位。
#
# 为什么不用 Git LFS：底座对象只存在于上游仓库的 LFS，本仓库的 LFS 里没有（实测 batch 接口 404），
# 公开仓库的 LFS 流量也有额度。base/*.tar.xz 仍是 LFS pointer 文本，只用作「期望 oid + size」的
# 真源，下载完成后被真实归档覆盖。
#
# 用法：bash scripts/ci/fetch-base.sh <abi>      # abi = arm64 | x86_64
#   需要 GH_TOKEN（CI 用 github.token）。已落地且校验通过的文件不会重复下载（配合 actions/cache）。
set -euo pipefail

abi="${1:?用法: fetch-base.sh <arm64|x86_64>}"
tag="${OMNI_BASE_RELEASE_TAG:-base-v1}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY 未设置}"

sha256_of() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

# 期望值来自 git 里的 pointer（不来自工作区：工作区那份可能已被上一次下载覆盖或被缓存恢复）。
expect() { git show "HEAD:base/$1" | sed -n "s/^$2 //p" | sed 's/^sha256://'; }

for name in "base-usr-${abi}.tar.xz" "base-dsh.tar.xz"; do
  want_sha=$(expect "$name" oid)
  want_size=$(expect "$name" size)
  [ -n "$want_sha" ] && [ -n "$want_size" ] || { echo "::error::base/$name 不是 LFS pointer，读不出期望值"; exit 1; }
  path="base/$name"
  if [ -f "$path" ] && [ "$(wc -c < "$path" | tr -d ' ')" = "$want_size" ] && [ "$(sha256_of "$path")" = "$want_sha" ]; then
    echo "已就位（缓存）：${path}"
    continue
  fi
  tmp="$(mktemp -d)"
  gh release download "$tag" -R "$repo" -p "$name" -D "$tmp"
  got_size=$(wc -c < "$tmp/$name" | tr -d ' ')
  got_sha=$(sha256_of "$tmp/$name")
  if [ "$got_size" != "$want_size" ] || [ "$got_sha" != "$want_sha" ]; then
    echo "::error::${name} 校验失败：期望 size=${want_size} sha256=${want_sha}，实际 size=${got_size} sha256=${got_sha}"
    exit 1
  fi
  mv -f "$tmp/$name" "$path"
  rm -rf "$tmp"
  echo "已下载并校验：${path}（${got_size} 字节）"
done
