"""为同一构建准备本地试用 ZIP 或带校验清单的 Release 附件，不上传。"""
import argparse
import hashlib
import json
import os
import tempfile
import zipfile
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--release", action="store_true", help="输出三个独立附件与 checksums.txt")
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
version = json.loads((root / "manifest.json").read_text(encoding="utf-8"))["version"]
names = ("main.js", "manifest.json", "styles.css")
if args.release:
    directory = root / "dist" / "release" / f"v{version}"
    directory.mkdir(parents=True, exist_ok=True)
    rows = []
    for name in names:
        data = (root / name).read_bytes()
        (directory / name).write_bytes(data)
        rows.append(f"{hashlib.sha256(data).hexdigest()}  {name}\n")
    (directory / "checksums.txt").write_bytes("".join(rows).encode("ascii"))
    print(directory)
    raise SystemExit(0)

out = root / "dist" / f"ielts-helper-obsidian-{version}-local.zip"
out.parent.mkdir(exist_ok=True)
with tempfile.NamedTemporaryFile(dir=out.parent, delete=False) as f:
    stage = Path(f.name)
try:
    with zipfile.ZipFile(stage, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in names:
            archive.write(root / name, f"ielts-helper/{name}")
    os.replace(stage, out)
finally:
    stage.unlink(missing_ok=True)
print(out)
