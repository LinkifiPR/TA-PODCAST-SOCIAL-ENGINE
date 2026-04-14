# TA Podcast Social Engine

This repo turns long-form transcript workflows into reusable, independently runnable AI agents.

## What is set up now

- A registry for agents: `agents/manifest.json`
- Your first agent prompt:
  - `skills/yt-intro-title-description/prompt.md`
- A workflow runner:
  - `scripts/run_agents.py`

The runner lets you provide one transcript (or topic brief), execute agents in parallel, and collect:

- One output file per agent
- A combined output bundle
- A machine-readable run summary

## Quick start

1. Export your API key:

```bash
export OPENAI_API_KEY="your_api_key_here"
```

2. Run all enabled agents on a transcript:

```bash
python3 scripts/run_agents.py \
  --transcript-file /absolute/path/to/transcript.txt \
  --video-url "https://youtube.com/watch?v=YOUR_VIDEO_ID"
```

3. Outputs are written to:

```text
runs/YYYYMMDD-HHMMSS/
```

With files like:

- `yt-intro-title-description.md`
- `combined.md`
- `run_summary.json`

## Add another skill agent

1. Create a new prompt file under `skills/<agent-id>/prompt.md`
2. Add an entry in `agents/manifest.json`
3. Run the same command again

No runner changes are required unless you want custom behavior per agent.

## Command options

```bash
python3 scripts/run_agents.py --help
```

Key options:

- `--transcript-file` path to transcript text
- `--topic` short brief if no transcript exists yet
- `--video-url` URL inserted into the prompt context (`[VIDEO_URL]` default)
- `--request` extra instruction (example: `"Generate only section 2 titles"`)
- `--agents` comma-separated agent ids to run (default: all enabled)
- `--max-workers` parallel worker count (default: 4)
- `--dry-run` skip API calls and write compiled prompt previews
