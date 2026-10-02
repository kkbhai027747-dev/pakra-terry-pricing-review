"""Losslessly crop a verified Jihuanshe card-viewer screenshot; no network/device access."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

from PIL import Image, ImageStat


class CropError(ValueError):
    pass


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def bounds(node):
    value = node.get("bounds", "")
    match = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", value) if isinstance(value, str) else None
    return tuple(map(int, match.groups())) if match else None


def intersects(a, b):
    return a and b and max(a[0], b[0]) < min(a[2], b[2]) and max(a[1], b[1]) < min(a[3], b[3])


def read_nodes(data, suffix):
    if len(data) > 5_000_000:
        raise CropError("UI_EVIDENCE_TOO_LARGE")
    text = data.decode("utf-8-sig")
    if suffix.lower() == ".xml":
        if "<!DOCTYPE" in text or "<!ENTITY" in text:
            raise CropError("UNSUPPORTED_XML_DECLARATION")
        root = ET.fromstring(text)
        if root.tag != "hierarchy" or root.get("rotation") != "0":
            raise CropError("UNSUPPORTED_UI_HIERARCHY")
        nodes = [dict(node.attrib) for node in root.iter("node")]
    else:
        nodes = json.loads(text)
    if not isinstance(nodes, list) or not nodes or len(nodes) > 3000 or not all(isinstance(n, dict) for n in nodes):
        raise CropError("INVALID_UI_NODES")
    return nodes


def card_bounds(nodes, context, size):
    labels = {"zh-Hans": "简中", "ja": "日文", "en": "英文"}
    if not isinstance(context, dict):
        raise CropError("INCOMPLETE_CARD_CONTEXT")
    language = context.get("language")
    required = [context.get(key) for key in ("cardName", "cardNumber", "packName", "setId", "setCode")]
    if language not in labels or any(not isinstance(v, str) or not v.strip() for v in required):
        raise CropError("INCOMPLETE_CARD_CONTEXT")
    share_url = context.get("shareUrl", "")
    if not isinstance(share_url, str) or not re.fullmatch(r"https://api\.jihuanshe\.com/pro/cards/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", share_url):
        raise CropError("INVALID_CARD_SHARE_URL")
    if size != (720, 1280):
        raise CropError("UNVERIFIED_SCREEN_SIZE: expected 720x1280")
    app = [n for n in nodes if n.get("package") == "com.jihuanshe.pro"]
    texts = {n.get("text", "") for n in app}
    if any(str(n.get("password", "false")).lower() == "true" for n in nodes):
        raise CropError("PRIVATE_INPUT_SCREEN")
    public_inputs = required[:2] + ([context["originalName"]] if context.get("originalName") else [])
    if any(n.get("class") == "android.widget.EditText" and n.get("text") not in public_inputs for n in app):
        raise CropError("UNEXPECTED_INPUT_FIELD")
    if not {context["cardName"], context["cardNumber"], context["packName"], labels[language]}.issubset(texts):
        raise CropError("CARD_IDENTITY_MISMATCH")
    candidates = set()
    for node in app:
        box = bounds(node)
        if node.get("class") != "android.widget.ImageView" or not box:
            continue
        left, top, right, bottom = box
        width, height = right - left, bottom - top
        if (width >= 200 and height >= 280 and 0.66 <= width / height <= 0.76
                and 0 <= left < right <= size[0] and 140 <= top <= 400 and bottom <= 900):
            candidates.add(box)
    if len(candidates) != 1:
        raise CropError("AMBIGUOUS_CARD_IMAGE: expected one full portrait card")
    box = candidates.pop()
    if any(n.get("text") and intersects(bounds(n), box) for n in app):
        raise CropError("CARD_IMAGE_OBSCURED: open the card viewer before capture")
    if not any(n.get("class") == "android.widget.Button" and n.get("content-desc") == "关闭" for n in app):
        raise CropError("CARD_VIEWER_REQUIRED")
    identity = [n for n in app if n.get("text") in required[:3] + [labels[language]]]
    if any(not bounds(n) or bounds(n)[1] < box[3] for n in identity):
        raise CropError("UNVERIFIED_VIEWER_LAYOUT")
    return box


def crop_card(image_path, ui_path, context_path, output_dir):
    """Return image.json metadata; create a new output directory with card.png only after validation."""
    image_path, ui_path, context_path = (Path(p).resolve() for p in (image_path, ui_path, context_path))
    output_dir = Path(output_dir).resolve()
    if output_dir.exists():
        raise CropError("OUTPUT_ALREADY_EXISTS")
    image_data, ui_data, context_data = image_path.read_bytes(), ui_path.read_bytes(), context_path.read_bytes()
    context = json.loads(context_data.decode("utf-8-sig"))
    nodes = read_nodes(ui_data, ui_path.suffix)
    with Image.open(io.BytesIO(image_data)) as source:
        if source.format != "PNG" or source.mode not in ("RGB", "RGBA"):
            raise CropError("EXPECTED_RGB_SCREENSHOT_PNG")
        box = card_bounds(nodes, context, source.size)
        crop = source.crop(box)
        if max(ImageStat.Stat(crop.convert("RGB")).stddev) < 12:
            raise CropError("BLANK_OR_UNLOADED_IMAGE")
        encoded = io.BytesIO()
        crop.save(encoded, format="PNG")
        image_bytes = encoded.getvalue()
        with Image.open(io.BytesIO(image_bytes)) as saved:
            if saved.mode != crop.mode or saved.size != crop.size or saved.tobytes() != crop.tobytes():
                raise CropError("PIXEL_VERIFICATION_FAILED")
        metadata = {
            "sourceKind": "app_screenshot_crop",
            "originalImage": False,
            "pixelsUnchanged": True,
            "path": str(output_dir / "card.png"),
            "sha256": sha256(image_bytes),
            "bytes": len(image_bytes),
            "width": crop.width,
            "height": crop.height,
            "crop": {"left": box[0], "top": box[1], "right": box[2], "bottom": box[3]},
            "source": {"pngPath": str(image_path), "pngSha256": sha256(image_data),
                       "width": source.width, "height": source.height,
                       "uiPath": str(ui_path), "uiSha256": sha256(ui_data),
                       "contextPath": str(context_path), "contextSha256": sha256(context_data)},
            "card": {key: context[key] for key in ("language", "setId", "setCode", "packName", "cardName", "cardNumber", "shareUrl")},
        }
    output_dir.mkdir(parents=True, exist_ok=False)
    (output_dir / "card.png").write_bytes(image_bytes)
    (output_dir / "image.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="Original 720x1280 screenshot PNG")
    parser.add_argument("--ui", required=True, help="Matching UIAutomator XML or flat nodes JSON")
    parser.add_argument("--context", required=True, help="Verified card context JSON")
    parser.add_argument("--out-dir", required=True, help="New output directory; existing output is never replaced")
    args = parser.parse_args()
    try:
        metadata = crop_card(args.image, args.ui, args.context, args.out_dir)
    except (CropError, OSError, ValueError, ET.ParseError) as error:
        print(json.dumps({"status": "error", "message": str(error)}, ensure_ascii=True), file=sys.stderr)
        return 1
    print(json.dumps({"status": "ok", "metadataPath": str(Path(args.out_dir).resolve() / "image.json"),
                      "width": metadata["width"], "height": metadata["height"], "sourceKind": metadata["sourceKind"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
