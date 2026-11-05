#!/usr/bin/env python3
"""把运行时快照里写死的旧包名换成 Omni 的包名。

快照是 Termux 树，构建期把 /data/data/<包名>/files/usr 这类前缀烧进了脚本、
ELF 二进制和符号链接目标。新旧包名必须等长：二进制里的字符串没法变长。

用法（流式，不落中间文件）：
  xz -dc snapshot.tar.xz | python3 omni-patch-snapshot.py | xz -T0 -6 > out.tar.xz
统计输出到 stderr。
"""
import sys
import tarfile

OLD = b"com." + b"dsharnessmobile" + b".shell"
NEW = b"com.omnifarious.omniagent"
OLD_PATH = b"com/" + b"dsharnessmobile" + b"/shell"
NEW_PATH = b"com/omnifarious/omniagent"
# manage 插件里有 `ime list -s | grep -c <裸名>`；换成等长且能匹配新 IME id 的片段
OLD_BARE = b"dsharness" + b"mobile"
NEW_BARE = b"omnifarious.omn"
assert len(OLD) == len(NEW) and len(OLD_PATH) == len(NEW_PATH) and len(OLD_BARE) == len(NEW_BARE), "新旧包名必须等长"


def swap(data: bytes) -> tuple[bytes, int]:
    n = data.count(OLD) + data.count(OLD_PATH)
    if n:
        data = data.replace(OLD, NEW).replace(OLD_PATH, NEW_PATH)
    bare = data.count(OLD_BARE)
    if bare:
        data = data.replace(OLD_BARE, NEW_BARE)
    return data, n + bare


def swap_str(s: str) -> tuple[str, int]:
    b, n = swap(s.encode("utf-8", "surrogateescape"))
    return b.decode("utf-8", "surrogateescape"), n


def main() -> None:
    src = tarfile.open(fileobj=sys.stdin.buffer, mode="r|")
    dst = tarfile.open(fileobj=sys.stdout.buffer, mode="w|", format=tarfile.PAX_FORMAT)
    members = files = links = names = hits = 0
    for m in src:
        members += 1
        m.name, n = swap_str(m.name)
        if n:
            names += 1
            hits += n
        if m.issym() or m.islnk():
            m.linkname, n = swap_str(m.linkname)
            if n:
                links += 1
                hits += n
        for key in list(m.pax_headers):
            m.pax_headers[key], n = swap_str(m.pax_headers[key])
            hits += n
        if m.isfile():
            data = src.extractfile(m).read()
            data, n = swap(data)
            if n:
                files += 1
                hits += n
            m.size = len(data)
            import io
            dst.addfile(m, io.BytesIO(data))
        else:
            dst.addfile(m)
    dst.close()
    src.close()
    print(
        f"members={members} patched_files={files} patched_links={links} "
        f"patched_names={names} replacements={hits}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
