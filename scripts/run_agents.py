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
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"


@dataclass(frozen=True)
class AgentSpec:
    agent_id: str
    name: str
    enabled: bool
    model: str
    prompt_path: pathlib.Path
    executor: str = "text"


@dataclass(frozen=True)
class RunContext:
    source_text: str
    video_url: str
    request: str
    dry_run: bool
    output_dir: pathlib.Path
    headshots_dir: pathlib.Path
    headshot_override: str | None


@dataclass
class AgentResult:
    agent: AgentSpec
    output_text: str
    artifacts: list[str] = field(default_factory=list)
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
        "--env-file",
        default=".env",
        help="Optional env file loaded before execution.",
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
        "--headshots-dir",
        default="headshots",
        help="Directory containing reusable headshots for thumbnail agents. Defaults to bundled repo headshots.",
    )
    parser.add_argument(
        "--headshot",
        help="Optional headshot filename or absolute path to force for thumbnail agents.",
    )
    parser.add_argument(
        "--auto-push",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Auto-commit and push generated run outputs (default: enabled).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Skip API calls and write compiled prompt previews only.",
    )
    return parser.parse_args()


def load_env_file(env_file: str) -> None:
    env_path = pathlib.Path(env_file).expanduser()
    if not env_path.is_absolute():
        env_path = pathlib.Path.cwd() / env_path
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()

        if value.startswith('"') and value.endswith('"') and len(value) >= 2:
            value = value[1:-1]
        elif value.startswith("'") and value.endswith("'") and len(value) >= 2:
            value = value[1:-1]

        if key and key not in os.environ:
            os.environ[key] = value


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
                executor=raw.get("executor", "text"),
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
        raise RuntimeError(
            "OPENAI_API_KEY is not set. Save it once with "
            "`bash scripts/save_api_keys.sh --openai-key <key> --scope both`."
        )

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
        with urllib.request.urlopen(req, timeout=240) as resp:
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


def parse_json_object(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        parts = cleaned.split("```")
        if len(parts) >= 3:
            cleaned = parts[1]
            if cleaned.startswith("json"):
                cleaned = cleaned[4:].strip()

    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("No JSON object found in model output.")

    candidate = cleaned[start : end + 1]
    return json.loads(candidate)


def list_headshots(headshots_dir: pathlib.Path) -> list[str]:
    if not headshots_dir.exists() or not headshots_dir.is_dir():
        return []

    allowed = {".png", ".jpg", ".jpeg", ".webp"}
    names = [
        path.name
        for path in sorted(headshots_dir.iterdir())
        if path.is_file() and path.suffix.lower() in allowed
    ]
    return names


def choose_headshot_by_format(format_name: str, available: list[str]) -> str | None:
    lower = format_name.lower()
    preferred_order: list[str]

    if "dramatic" in lower:
        preferred_order = ["complete-shock.png", "shocked.png", "surprised.png"]
    elif "don't do this" in lower or "accusation" in lower:
        preferred_order = ["pointing.png", "disappointed.png"]
    elif "problem" in lower:
        preferred_order = ["disappointed.png", "complete-shock.png", "shocked.png"]
    elif "conversation" in lower:
        preferred_order = ["confident.png"]
    elif "motion" in lower or "affects" in lower:
        preferred_order = ["pointing.png", "surprised.png"]
    elif "conflict" in lower:
        preferred_order = ["confident.png", "pointing.png"]
    elif "review" in lower:
        preferred_order = ["surprised.png", "complete-shock.png", "shocked.png"]
    elif "title head" in lower:
        preferred_order = ["confident.png", "pointing.png"]
    else:
        preferred_order = [
            "confident.png",
            "pointing.png",
            "surprised.png",
            "shocked.png",
            "complete-shock.png",
        ]

    available_lower_map = {name.lower(): name for name in available}
    for filename in preferred_order:
        if filename in available_lower_map:
            return available_lower_map[filename]
    return available[0] if available else None


def resolve_headshot_override(
    override: str | None, headshots_dir: pathlib.Path
) -> tuple[pathlib.Path | None, str | None]:
    if not override:
        return None, None

    candidate = pathlib.Path(override).expanduser()
    if candidate.is_absolute():
        if candidate.exists() and candidate.is_file():
            return candidate, None
        return None, f"Forced headshot not found: {candidate}"

    in_dir = headshots_dir / override
    if in_dir.exists() and in_dir.is_file():
        return in_dir, None

    # Allow omitting extension.
    for ext in (".png", ".jpg", ".jpeg", ".webp"):
        with_ext = headshots_dir / f"{override}{ext}"
        if with_ext.exists() and with_ext.is_file():
            return with_ext, None

    return None, f"Forced headshot not found in headshots dir: {override}"


def run_text_agent(agent: AgentSpec, context: RunContext) -> AgentResult:
    try:
        system_prompt = agent.prompt_path.read_text(encoding="utf-8")
    except OSError as exc:
        return AgentResult(agent=agent, output_text="", error=f"Prompt load failed: {exc}")

    user_prompt = build_user_prompt(context.source_text, context.video_url, context.request)

    if context.dry_run:
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


def run_thumbnail_agent(agent: AgentSpec, context: RunContext) -> AgentResult:
    try:
        base_prompt = agent.prompt_path.read_text(encoding="utf-8")
    except OSError as exc:
        return AgentResult(agent=agent, output_text="", error=f"Prompt load failed: {exc}")

    headshots = list_headshots(context.headshots_dir)
    forced_path, forced_error = resolve_headshot_override(
        context.headshot_override, context.headshots_dir
    )
    if forced_error:
        return AgentResult(agent=agent, output_text="", error=forced_error)

    planner_requirement = (
        "\n\nAUTOMATION MODE REQUIREMENTS:\n"
        "- Do not ask the user questions.\n"
        "- Choose one thumbnail format automatically from the 15 listed options.\n"
        "- If the selected format benefits from a headshot and one is available, choose one.\n"
        "- Return ONLY valid JSON with this exact schema:\n"
        '{"format_name":"...","format_reason":"...","include_headshot":true,'
        '"recommended_headshot":"filename-or-null","headshot_reason":"...",'
        '"text_overlay":"up to 4 words or empty string",'
        '"image_prompt":"detailed final generation prompt"}\n'
        "- Ensure image_prompt is production-ready and ends with: "
        "'1280x720 YouTube thumbnail, ultra sharp, high contrast, cinematic, "
        "minimal composition, no borders, professional art direction'.\n"
        f"- Available headshots: {', '.join(headshots) if headshots else 'none available'}\n"
        f"- Forced headshot override: {forced_path.name if forced_path else 'none'}\n"
        "- If no headshot should be used, set include_headshot to false and recommended_headshot to null.\n"
    )

    planner_user_prompt = (
        build_user_prompt(context.source_text, context.video_url, context.request) + planner_requirement
    )

    if context.dry_run:
        preview = (
            f"# DRY RUN: {agent.agent_id}\n\n"
            f"## System Prompt\n\n{base_prompt}\n\n"
            f"## Planner User Prompt\n\n{planner_user_prompt}\n"
        )
        return AgentResult(agent=agent, output_text=preview)

    try:
        plan_text = call_openai(agent.model, base_prompt, planner_user_prompt)
        plan = parse_json_object(plan_text)
    except Exception as exc:  # noqa: BLE001
        return AgentResult(
            agent=agent,
            output_text="",
            error=f"Thumbnail planning failed: {exc}",
        )

    format_name = str(plan.get("format_name", "")).strip() or "Unknown"
    format_reason = str(plan.get("format_reason", "")).strip() or "No reason provided."
    image_prompt = str(plan.get("image_prompt", "")).strip()
    text_overlay = str(plan.get("text_overlay", "")).strip()
    headshot_reason = str(plan.get("headshot_reason", "")).strip()

    include_headshot_raw = plan.get("include_headshot", False)
    include_headshot = (
        include_headshot_raw
        if isinstance(include_headshot_raw, bool)
        else str(include_headshot_raw).strip().lower() in {"1", "true", "yes"}
    )

    if not image_prompt:
        return AgentResult(agent=agent, output_text="", error="Planner returned empty image_prompt.")

    lower_prompt = image_prompt.lower()
    if "1280x720" not in lower_prompt:
        image_prompt = (
            image_prompt.rstrip().rstrip(".")
            + ", 1280x720 YouTube thumbnail, ultra sharp, high contrast, cinematic, "
            "minimal composition, no borders, professional art direction"
        )

    selected_headshot_path: pathlib.Path | None = None
    selected_headshot_name: str | None = None

    if forced_path:
        selected_headshot_path = forced_path
        selected_headshot_name = forced_path.name
        include_headshot = True
    elif include_headshot:
        recommended = str(plan.get("recommended_headshot") or "").strip()
        if recommended and recommended in headshots:
            selected_headshot_name = recommended
        else:
            selected_headshot_name = choose_headshot_by_format(format_name, headshots)
        if selected_headshot_name:
            selected_headshot_path = context.headshots_dir / selected_headshot_name
        else:
            include_headshot = False

    generator_script = agent.prompt_path.parent / "scripts" / "generate_thumbnail.py"
    if not generator_script.exists():
        return AgentResult(
            agent=agent,
            output_text="",
            error=f"Generator script not found: {generator_script}",
        )

    image_output = context.output_dir / f"{agent.agent_id}.png"

    cmd = [
        sys.executable,
        str(generator_script),
        "--prompt",
        image_prompt,
        "--output",
        str(image_output),
    ]
    if selected_headshot_path is not None:
        cmd.extend(["--guest-image", str(selected_headshot_path)])

    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        stderr = proc.stderr.strip() or "Unknown generation error"
        stdout = proc.stdout.strip()
        details = stderr if not stdout else f"{stderr}\n{stdout}"
        return AgentResult(
            agent=agent,
            output_text="",
            error=f"Thumbnail generation failed: {details}",
        )

    if not image_output.exists():
        return AgentResult(
            agent=agent,
            output_text="",
            error=f"Thumbnail generation reported success but file is missing: {image_output}",
        )

    summary_lines = [
        "# Thumbnail Output",
        "",
        f"- Format: {format_name}",
        f"- Format Rationale: {format_reason}",
        f"- Headshot Used: {selected_headshot_name if selected_headshot_name else 'No'}",
        f"- Headshot Rationale: {headshot_reason if headshot_reason else 'N/A'}",
        f"- Text Overlay: {text_overlay if text_overlay else 'No text overlay'}",
        f"- Image File: {image_output.resolve()}",
        "",
        "## Final Prompt",
        "",
        "```text",
        image_prompt,
        "```",
    ]

    return AgentResult(
        agent=agent,
        output_text="\n".join(summary_lines),
        artifacts=[str(image_output.resolve())],
    )


def run_agent(agent: AgentSpec, context: RunContext) -> AgentResult:
    if agent.executor == "thumbnail":
        return run_thumbnail_agent(agent, context)
    return run_text_agent(agent, context)


def write_outputs(
    output_dir: pathlib.Path,
    source: str,
    results: list[AgentResult],
    video_url: str,
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
            if result.artifacts:
                combined_lines.append("")
                combined_lines.append("Artifacts:")
                for artifact in result.artifacts:
                    combined_lines.append(f"- {artifact}")
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
                "executor": r.agent.executor,
                "model": r.agent.model,
                "ok": r.ok,
                "error": r.error,
                "output_file": f"{r.agent.agent_id}.md",
                "artifacts": r.artifacts,
            }
            for r in results
        ],
    }
    (output_dir / "run_summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def git_auto_push(
    repo_root: pathlib.Path, output_dir: pathlib.Path, agent_ids: list[str]
) -> tuple[bool, str]:
    def run_git(cmd: list[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            cmd,
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=False,
        )

    check_repo = run_git(["git", "rev-parse", "--is-inside-work-tree"])
    if check_repo.returncode != 0:
        return False, "Auto-push failed: current folder is not a git repository."

    add = run_git(["git", "add", "-f", str(output_dir.resolve())])
    if add.returncode != 0:
        return False, f"Auto-push failed during git add: {add.stderr.strip()}"

    staged_check = run_git(["git", "diff", "--cached", "--quiet"])
    if staged_check.returncode == 0:
        return True, "Auto-push skipped: no staged output changes."

    if staged_check.returncode not in {0, 1}:
        return False, f"Auto-push failed while checking staged diff: {staged_check.stderr.strip()}"

    stamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    message = f"Auto-run outputs {stamp} [{', '.join(sorted(agent_ids))}]"

    commit = run_git(["git", "commit", "-m", message])
    if commit.returncode != 0:
        return False, f"Auto-push failed during commit: {commit.stderr.strip()}"

    push = run_git(["git", "push"])
    if push.returncode != 0:
        return False, f"Auto-push failed during push: {push.stderr.strip()}"

    head = run_git(["git", "rev-parse", "--short", "HEAD"])
    commit_sha = head.stdout.strip() if head.returncode == 0 else "unknown"
    return True, f"Auto-push complete: commit {commit_sha} pushed."


def main() -> int:
    args = parse_args()
    load_env_file(args.env_file)

    manifest_path = pathlib.Path(args.manifest).expanduser().resolve()
    if not manifest_path.exists():
        print(f"Manifest not found: {manifest_path}", file=sys.stderr)
        return 1

    repo_root = manifest_path.parent.parent.resolve()

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

    timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    output_dir = (pathlib.Path(args.output_root) / timestamp).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    headshots_dir = pathlib.Path(args.headshots_dir).expanduser()
    if not headshots_dir.is_absolute():
        headshots_dir = (repo_root / headshots_dir).resolve()
    else:
        headshots_dir = headshots_dir.resolve()

    context = RunContext(
        source_text=source_text,
        video_url=args.video_url,
        request=args.request,
        dry_run=args.dry_run,
        output_dir=output_dir,
        headshots_dir=headshots_dir,
        headshot_override=args.headshot,
    )

    workers = max(1, min(args.max_workers, len(agents)))
    results: list[AgentResult] = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        future_map = {pool.submit(run_agent, agent, context): agent for agent in agents}
        for future in concurrent.futures.as_completed(future_map):
            result = future.result()
            status = "ok" if result.ok else "error"
            print(f"[{status}] {result.agent.agent_id}")
            results.append(result)

    results.sort(key=lambda r: r.agent.agent_id)
    write_outputs(output_dir, source_text, results, args.video_url)

    print(f"\nRun complete. Output directory: {output_dir}")

    if args.auto_push and not args.dry_run:
        ok, message = git_auto_push(repo_root, output_dir, [a.agent_id for a in agents])
        print(message)
        if not ok:
            return 3

    failed = [r for r in results if not r.ok]
    if failed:
        print(f"Failed agents: {', '.join(r.agent.agent_id for r in failed)}")
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
