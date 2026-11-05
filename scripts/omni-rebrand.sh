#!/usr/bin/env bash
# Omni 品牌替换：把复制来的代码统一改成 Omni 的身份。
# 用法（在任意目录执行）：
#   bash omni/scripts/omni-rebrand.sh                   只出报告，不改文件
#   bash omni/scripts/omni-rebrand.sh --check-snapshot  报告 + 扫描借用快照里的旧包名（较慢）
#   bash omni/scripts/omni-rebrand.sh --apply           执行替换
# 环境变量 OMNI_OWNER 指定 GitHub 账号，默认 yanqing7914。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
grep -q 'rootProject.name = "omni"' settings.gradle.kts || { echo "不在 omni 仓库根目录，退出"; exit 1; }

OWNER="${OMNI_OWNER:-yanqing7914}"
APPLY=0
CHECK_SNAP=0
for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --check-snapshot) CHECK_SNAP=1 ;;
    *) echo "未知参数：$a"; exit 2 ;;
  esac
done

OLD_PKG='com.dsharnessmobile.shell'

# 不改：许可证（MIT 要求保留原署名）、vendored 第三方源码（有摘要门禁）、本脚本
EXCLUDE_RE='^\./(LICENSE$|LICENSES/|THIRD_PARTY_NOTICES\.md$|vendor/|plugins/dsh-linux-bootstrap/|scripts/omni-rebrand\.sh$|scripts/omni-patch-snapshot\.py$)'

text_files() {
  { grep -rIlE "$1" . --exclude-dir=.git --exclude-dir=node_modules 2>/dev/null || true; } | { grep -vE "$EXCLUDE_RE" || true; }
}

report() {
  echo "== 统计（$1）"
  for p in 'com\.dsharnessmobile\.shell' 'com/dsharnessmobile/shell' 'dsharnessmobile' 'kelai141' 'dsh-mobile-apk' 'dsh-mobile([^-]|$)' 'DeepCode'; do
    printf '  %-28s %s 个文件\n' "$p" "$(text_files "$p" | wc -l | tr -d ' ')"
  done
  echo "  排除目录里仍含旧身份的文件（需人工判断）："
  { grep -rIlE 'kelai141|dsharnessmobile' vendor plugins/dsh-linux-bootstrap 2>/dev/null || true; } | sed 's/^/    /'
}

move_pkg_dirs() {
  find app/src -type d -path '*/com/dsharnessmobile/shell' 2>/dev/null | while IFS= read -r d; do
    base="${d%/com/dsharnessmobile/shell}"
    dest="$base/com/omnifarious/omniagent"
    mkdir -p "$(dirname "$dest")"
    mv "$d" "$dest"
    rmdir "$base/com/dsharnessmobile" 2>/dev/null || true
    echo "  移动 $d -> $dest"
  done
}

replace_all() {
  local count=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    OWNER="$OWNER" perl -pi -e '
      s/com\.dsharnessmobile\.shell/com.omnifarious.omniagent/g;
      s#com/dsharnessmobile/shell#com/omnifarious/omniagent#g;
      s#com%2Fdsharnessmobile%2Fshell#com%2Fomnifarious%2Fomniagent#g;
      s#kelai141\.github\.io/dsh-mobile-apk#$ENV{OWNER}.github.io/omni#g;
      s#kelai141/dsh-mobile-apk#$ENV{OWNER}/omni#g;
      s#kelai141/dsh-mobile(?![\w-])#$ENV{OWNER}/omni#g;
      s/dsh-mobile-apk/omni/g;
      s/DeepCode/Omni/g;
      s/dsharnessmobile/omnifarious/g;
    ' "$f"
    count=$((count + 1))
  done < <(text_files 'dsharnessmobile|kelai141|dsh-mobile|DeepCode')
  echo "  改写 $count 个文件"
}

regen_keystore() {
  local ks=keystore/debug.keystore
  # macOS 的 /usr/bin/keytool 只是占位，没装 JDK 时会失败，所以要真跑一次
  if ! keytool -help >/dev/null 2>&1; then
    echo "  没有 keytool（需要 JDK），跳过签名密钥更换"
    return
  fi
  local old
  old=$(keytool -list -v -keystore "$ks" -storepass android -alias androiddebugkey 2>/dev/null \
    | awk -F': ' '/SHA256:/{print $2; exit}' || true)
  # 先生成到临时目录，确认新 keystore 可读后再覆盖；任何一步失败都保留原文件。
  # （旧实现先 rm 再生成，keytool 一失败签名密钥就没了。）
  # 临时目录放在 keystore/ 同级，保证 mv 是同一文件系统内的原子改名。
  local tmpdir tmp
  tmpdir=$(mktemp -d "$(dirname "$ks")/.regen.XXXXXX") || { echo "  无法创建临时目录，原密钥未改动"; return 1; }
  tmp="$tmpdir/debug.keystore"   # keytool 不接受已存在的空文件，所以给一个不存在的路径
  if ! keytool -genkeypair -keystore "$tmp" -storepass android -keypass android -alias androiddebugkey \
      -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Omni, O=Omnifarious" >/dev/null 2>&1 \
    || ! keytool -list -keystore "$tmp" -storepass android -alias androiddebugkey >/dev/null 2>&1; then
    rm -rf "$tmpdir"
    echo "  生成新密钥失败，原 $ks 未改动"
    return 1
  fi
  if [ -f "$ks" ]; then
    local bak=".omni-build/debug.keystore.bak.$(date +%Y%m%d%H%M%S)"
    mkdir -p .omni-build && cp -p "$ks" "$bak" && echo "  旧密钥已备份到 $bak"
  fi
  mv -f "$tmp" "$ks"
  rm -rf "$tmpdir"
  echo "  已生成新的签名密钥（原作者的公开 debug 密钥已替换）"
  if [ -n "$old" ]; then
    local plain
    plain=$(echo "$old" | tr -d ':' | tr 'A-F' 'a-f')
    echo "  钉住旧证书指纹的文件（需要改成新指纹）："
    { grep -rIilE "$old|$plain" . --exclude-dir=.git 2>/dev/null || true; } | sed 's/^/    /'
  fi
}

check_snapshot() {
  local apk="../third_party/apk/dsh-mobile-apk-v0.14.10-arm64.apk"
  [ -f "$apk" ] || { echo "  找不到 $apk，跳过快照扫描"; return; }
  echo "== 扫描借用快照里的旧包名（解压约 700MB，需要一两分钟）"
  local unxz
  if command -v xz >/dev/null; then
    unxz='xz -dc'
  else
    unxz="python3 -c 'import lzma,sys,shutil; shutil.copyfileobj(lzma.open(sys.stdin.buffer), sys.stdout.buffer)'"
  fi
  local n
  n=$(unzip -p "$apk" assets/snapshot.tar.xz | eval "$unxz" | { LC_ALL=C grep -a -c "$OLD_PKG" || true; })
  echo "  含 $OLD_PKG 的行数：$n"
  echo "  大于 0 说明快照写死了包名：改包名后必须重建快照，借用的快照会起不来。"
}

if [ ! -d .git ] && [ "$APPLY" = 1 ]; then
  git init -q -b main
  echo "已 git init（新仓库，无原历史）"
fi

report "替换前"
if [ "$CHECK_SNAP" = 1 ]; then check_snapshot; fi

if [ "$APPLY" = 0 ]; then
  echo
  echo "以上只是报告，没有改动文件。确认后加 --apply 执行。"
  exit 0
fi

echo "== 执行"
move_pkg_dirs
replace_all
rm -rf qrcode && echo "  删除 qrcode/（群二维码、赞赏码）"
regen_keystore
echo
report "替换后"
echo
echo "完成。没有提交 git，先用 git status 检查改动。"
