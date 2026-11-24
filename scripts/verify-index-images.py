#!/usr/bin/env python3
"""Verify unique screenshots referenced by one UI index can actually be decoded.

Usage: python3 scripts/verify-index-images.py <ui-index.json> <projectDir> <out.json> [workers]
Outputs only aggregate counts and bounded samples; no image bytes.
"""
import concurrent.futures
import json
import os
import sys
import time
from collections import Counter
from pathlib import Path

from PIL import Image, ImageFile

ImageFile.LOAD_TRUNCATED_IMAGES = False
Image.MAX_IMAGE_PIXELS = 120_000_000


def check(rel, root):
    path = Path(root) / rel
    try:
        size = path.stat().st_size
    except OSError:
        return {"file": rel, "status": "missing", "reason": "not found"}
    if size <= 0:
        return {"file": rel, "status": "empty", "reason": "0 bytes"}
    try:
        with Image.open(path) as image:
            image.load()
            width, height = image.size
            mode = image.mode
        return {"file": rel, "status": "ok", "width": width, "height": height, "mode": mode,
                "bytes": size, "format": image.format if hasattr(image, "format") else ""}
    except Exception as error:  # noqa: BLE001 - report the real decoder error
        return {"file": rel, "status": "invalid", "bytes": size, "reason": str(error)[:240]}


def main():
    index_file, root, out_file = sys.argv[1], sys.argv[2], sys.argv[3]
    workers = int(sys.argv[4]) if len(sys.argv) > 4 else 4
    with open(index_file, encoding="utf-8") as handle:
        index = json.load(handle)
    shots = sorted({item.get("shot") for item in index.get("objects", []) if item.get("shot")})
    shots += sorted({item.get("shot") for item in index.get("boards", []) if item.get("shot")})
    shots = sorted(set(shots))
    started = time.time()
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for count, result in enumerate(pool.map(lambda rel: check(rel, root), shots), 1):
            results.append(result)
            if count % 1000 == 0:
                print(f"checked {count}/{len(shots)}", file=sys.stderr, flush=True)
    counts = Counter(item["status"] for item in results)
    sizes = Counter((item.get("width"), item.get("height")) for item in results if item["status"] == "ok")
    report = {
        "index": index_file,
        "projectDir": root,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "unique": len(shots),
        "counts": dict(counts),
        "elapsedSeconds": round(time.time() - started, 1),
        "dimensionsTop": [{"width": key[0], "height": key[1], "count": value} for key, value in sizes.most_common(12)],
        "failures": [item for item in results if item["status"] != "ok"][:200],
        "results": results,
    }
    Path(out_file).parent.mkdir(parents=True, exist_ok=True)
    with open(out_file, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=1)
    print(json.dumps({key: report[key] for key in ("unique", "counts", "elapsedSeconds", "dimensionsTop")}, ensure_ascii=False))


if __name__ == "__main__":
    main()