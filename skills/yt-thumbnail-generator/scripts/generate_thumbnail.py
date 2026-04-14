#!/usr/bin/env python3
"""Generate a YouTube thumbnail image using OpenRouter."""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import pathlib
import time
import urllib.error
import urllib.request

OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"
NANO_BANANA_PRO_MODEL = "google/gemini-3-pro-image-preview"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a thumbnail image via OpenRouter.")
    parser.add_argument("--prompt", required=True, help="Final image generation prompt.")
    parser.add_argument("--output", required=True, help="Output image path (png recommended).")
    parser.add_argument(
        "--guest-image",
        help="Optional path to a guest/headshot image to condition generation.",
    )
    parser.add_argument(
        "--api-key",
        help="OpenRouter API key (defaults to OPENROUTER_API_KEY env var).",
    )
    return parser.parse_args()


def to_data_url(path: pathlib.Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    raw = path.read_bytes()
    encoded = base64.b64encode(raw).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def build_payload(prompt: str, model: str, guest_image: pathlib.Path | None) -> dict:
    content: list[dict] = [{"type": "text", "text": prompt}]

    if guest_image is not None:
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": to_data_url(guest_image)},
            }
        )

    return {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "modalities": ["image", "text"],
        "stream": False,
    }


def post_openrouter(payload: dict, api_key: str) -> dict:
    req = urllib.request.Request(
        OPENROUTER_CHAT_URL,
        method="POST",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=240) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        if exc.code == 401:
            raise RuntimeError(
                "401 Invalid API key. Check https://openrouter.ai/keys\n" + body
            ) from exc
        if exc.code == 402:
            raise RuntimeError(
                "402 Insufficient credits. Check https://openrouter.ai/credits\n" + body
            ) from exc
        if exc.code == 429:
            raise RuntimeError("429 Rate limited\n" + body) from exc
        raise RuntimeError(f"HTTP {exc.code}: {body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Connection error: {exc.reason}") from exc


def extract_image_ref(payload: dict) -> str:
    choices = payload.get("choices") or []
    for choice in choices:
        message = choice.get("message") or {}

        for image_item in message.get("images") or []:
            if isinstance(image_item, dict):
                if isinstance(image_item.get("image_url"), dict):
                    url = image_item["image_url"].get("url")
                    if url:
                        return url
                if isinstance(image_item.get("imageUrl"), dict):
                    url = image_item["imageUrl"].get("url")
                    if url:
                        return url
                if isinstance(image_item.get("url"), str):
                    return image_item["url"]

        content = message.get("content")
        if isinstance(content, list):
            for part in content:
                if not isinstance(part, dict):
                    continue
                image_url = part.get("image_url")
                if isinstance(image_url, dict) and image_url.get("url"):
                    return image_url["url"]
                if isinstance(image_url, str):
                    return image_url
                if part.get("type") in {"image_url", "output_image"}:
                    if isinstance(part.get("url"), str):
                        return part["url"]

    data = payload.get("data") or []
    for item in data:
        if not isinstance(item, dict):
            continue
        if isinstance(item.get("url"), str):
            return item["url"]
        if isinstance(item.get("b64_json"), str):
            return "data:image/png;base64," + item["b64_json"]

    raise RuntimeError("No image URL found in OpenRouter response.")


def fetch_image_bytes(image_ref: str) -> bytes:
    if image_ref.startswith("data:image"):
        _, encoded = image_ref.split(",", 1)
        return base64.b64decode(encoded)

    req = urllib.request.Request(image_ref, method="GET")
    with urllib.request.urlopen(req, timeout=240) as resp:
        return resp.read()


def main() -> int:
    args = parse_args()
    api_key = args.api_key or os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError(
            "OPENROUTER_API_KEY is not set. Save it once with "
            "`bash scripts/save_api_keys.sh --openrouter-key <key> --scope both`."
        )

    guest_image_path: pathlib.Path | None = None
    if args.guest_image:
        guest_image_path = pathlib.Path(args.guest_image).expanduser().resolve()
        if not guest_image_path.exists() or not guest_image_path.is_file():
            raise RuntimeError(f"Guest image not found: {guest_image_path}")

    payload = build_payload(args.prompt, NANO_BANANA_PRO_MODEL, guest_image_path)

    try:
        response = post_openrouter(payload, api_key)
    except RuntimeError as err:
        if str(err).startswith("429 "):
            time.sleep(2)
            response = post_openrouter(payload, api_key)
        else:
            raise

    image_ref = extract_image_ref(response)
    image_bytes = fetch_image_bytes(image_ref)

    output_path = pathlib.Path(args.output).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(image_bytes)

    print(str(output_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
