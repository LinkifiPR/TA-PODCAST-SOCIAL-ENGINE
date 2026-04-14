#!/usr/bin/env python3
"""
Run transcript-driven agents in parallel and write consolidated outputs.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"


@dataclass(frozen=True)
class AgentSpec:
    agent_id: str
    name: str
    enabled: bool
    model: str
    prompt_path: pathlib.Path


@dataclass
class AgentResult:
    agent: AgentSpec
    output_text: str
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run one or more prompt agents against a transcript/topic."
    )
    parser.add_argument(
        "--manifest",
        default="agents/manifest.json",
        help="Path to agents manifest JSON.",
    )
    parser.add_argument(
        "--transcript-file",
        help="Absolute or relative path to transcript text file.",
    )
    parser.add_argument(
        "--topic",
        help="Short topic brief when transcript is not available.",
    )
    parser.add_argument(
        "--video-url",
        default="[VIDEO_URL]",
        help="Video URL inserted into prompt context.",
    )
    parser.add_argument(
        "--request",
        default="Generate all sections unless explicitly told otherwise.",
        help="Extra run instruction (for example: titles only).",
    )
    parser.add_argument(
        "--agents",
        help="Comma-separated agent ids to run. Defaults to all enabled agents.",
    )
    parser.add_argument(
        "--output-root",
        default="runs",
        help="Directory where run folders are created.",
    )
    parser.add_argument(
        "--max-workers",
        type=int,
        default=4,
        help="Maximum number of parallel workers.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Skip API calls and write compiled prompt previews only.",
    )
    return parser.parse_args()


def load_manifest(manifest_path: pathlib.Path) -> list[AgentSpec]:
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or "agents" not in data:
        raise ValueError("Manifest must contain an 'agents' array.")

    repo_root = manifest_path.parent.parent
    specs: list[AgentSpec] = []
    for raw in data["agents"]:
        prompt_path = pathlib.Path(raw["prompt_path"])
        if not prompt_path.is_absolute():
            primary = manifest_path.parent / prompt_path
            fallback = repo_root / prompt_path
            prompt_path = primary if primary.exists() else fallback

        specs.append(
            AgentSpec(
                agent_id=raw["id"],
                name=raw.get("name", raw["id"]),
                enabled=bool(raw.get("enabled", True)),
                model=raw.get("model", os.getenv("OPENAI_MODEL", "gpt-5.4")),
                prompt_path=prompt_path,
            )
        )
    return specs


def resolve_agents(all_agents: list[AgentSpec], selection: str | None) -> list[AgentSpec]:
    enabled = [a for a in all_agents if a.enabled]
    if not selection:
        return enabled

    wanted = {item.strip() for item in selection.split(",") if item.strip()}
    chosen = [a for a in enabled if a.agent_id in wanted]
    missing = wanted - {a.agent_id for a in chosen}
    if missing:
        raise ValueError(f"Unknown or disabled agent id(s): {', '.join(sorted(missing))}")
    return chosen


def read_source(transcript_file: str | None, topic: str | None) -> str:
    if transcript_file:
        path = pathlib.Path(transcript_file).expanduser().resolve()
        return path.read_text(encoding="utf-8")
    if topic:
        return topic.strip()
    raise ValueError("Provide either --transcript-file or --topic.")


def build_user_prompt(source_text: str, video_url: str, request: str) -> str:
    return (
        "Use the input below as the source of truth.\n"
        "Ground every claim in it. Do not invent stats or findings.\n\n"
        f"VIDEO_URL: {video_url}\n"
        "If the output template includes [VIDEO_URL], replace it with VIDEO_URL.\n\n"
        "RUN REQUEST:\n"
        f"{request}\n\n"
        "SOURCE INPUT:\n"
        f"{source_text}\n"
    )


def extract_output_text(payload: dict[str, Any]) -> str:
    if isinstance(payload.get("output_text"), str) and payload["output_text"].strip():
        return payload["output_text"]

    chunks: list[str] = []
    for item in payload.get("output", []):
        if item.get("type") != "message":
            continue
        for content in item.get("content", []):
            ctype = content.get("type")
            if ctype in {"output_text", "text"}:
                text = content.get("text", "")
                if text:
                    chunks.append(text)

    return "\n".join(chunks).strip()


def call_openai(model: str, system_prompt: str, user_prompt: str) -> str:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set.")

    body = {
        "model": model,
        "input": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    req = urllib.request.Request(
        OPENAI_RESPONSES_URL,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            raw = resp.read().decode("utf-8")
            payload = json.loads(raw)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI HTTP error {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"OpenAI connection error: {exc.reason}") from exc

    output = extract_output_text(payload)
    if not output:
        raise RuntimeError("OpenAI response contained no text output.")
    return output


def run_agent(agent: AgentSpec, user_prompt: str, dry_run: bool) -> AgentResult:
    try:
        system_prompt = agent.prompt_path.read_text(encoding="utf-8")
    except OSError as exc:
        return AgentResult(agent=agent, output_text="", error=f"Prompt load failed: {exc}")

    if dry_run:
        preview = (
            f"# DRY RUN: {agent.agent_id}\n\n"
            f"## System Prompt\n\n{system_prompt}\n\n"
            f"## User Prompt\n\n{user_prompt}\n"
        )
        return AgentResult(agent=agent, output_text=preview)

    try:
        output = call_openai(agent.model, system_prompt, user_prompt)
        return AgentResult(agent=agent, output_text=output)
    except Exception as exc:  # noqa: BLE001
        return AgentResult(agent=agent, output_text="", error=str(exc))


def write_outputs(
    output_dir: pathlib.Path, source: str, results: list[AgentResult], video_url: str
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)

    for result in results:
        target = output_dir / f"{result.agent.agent_id}.md"
        if result.ok:
            target.write_text(result.output_text, encoding="utf-8")
        else:
            target.write_text(
                f"# ERROR: {result.agent.agent_id}\n\n{result.error}\n", encoding="utf-8"
            )

    combined_lines = [
        "# Agent Output Bundle",
        "",
        f"Run Time (UTC): {dt.datetime.utcnow().isoformat(timespec='seconds')}Z",
        f"Video URL: {video_url}",
        "",
        "## Source",
        "",
        source,
        "",
    ]

    for result in results:
        combined_lines.append(f"## {result.agent.agent_id}")
        combined_lines.append("")
        if result.ok:
            combined_lines.append(result.output_text)
        else:
            combined_lines.append(f"ERROR: {result.error}")
        combined_lines.append("")

    (output_dir / "combined.md").write_text("\n".join(combined_lines), encoding="utf-8")

    summary = {
        "run_time_utc": dt.datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "video_url": video_url,
        "outputs_dir": str(output_dir.resolve()),
        "results": [
            {
                "agent_id": r.agent.agent_id,
                "name": r.agent.name,
                "model": r.agent.model,
                "ok": r.ok,
                "error": r.error,
                "output_file": f"{r.agent.agent_id}.md",
            }
            for r in results
        ],
    }
    (output_dir / "run_summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def main() -> int:
    args = parse_args()

    manifest_path = pathlib.Path(args.manifest).expanduser().resolve()
    if not manifest_path.exists():
        print(f"Manifest not found: {manifest_path}", file=sys.stderr)
        return 1

    try:
        all_agents = load_manifest(manifest_path)
        agents = resolve_agents(all_agents, args.agents)
        source_text = read_source(args.transcript_file, args.topic)
    except Exception as exc:  # noqa: BLE001
        print(f"Input error: {exc}", file=sys.stderr)
        return 1

    if not agents:
        print("No enabled agents to run.", file=sys.stderr)
        return 1

    user_prompt = build_user_prompt(source_text, args.video_url, args.request)
    timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    output_dir = pathlib.Path(args.output_root) / timestamp

    workers = max(1, min(args.max_workers, len(agents)))
    results: list[AgentResult] = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        future_map = {
            pool.submit(run_agent, agent, user_prompt, args.dry_run): agent for agent in agents
        }
        for future in concurrent.futures.as_completed(future_map):
            result = future.result()
            status = "ok" if result.ok else "error"
            print(f"[{status}] {result.agent.agent_id}")
            results.append(result)

    results.sort(key=lambda r: r.agent.agent_id)
    write_outputs(output_dir, source_text, results, args.video_url)

    print(f"\nRun complete. Output directory: {output_dir.resolve()}")
    failed = [r for r in results if not r.ok]
    if failed:
        print(f"Failed agents: {', '.join(r.agent.agent_id for r in failed)}")
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
