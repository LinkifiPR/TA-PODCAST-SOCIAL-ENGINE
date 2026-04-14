# TA Podcast Social Engine

This repo turns transcript workflows into independent AI agents that run in parallel and ship outputs in one bundle.

## Included Agents

- `yt-intro-title-description` (text output)
- `yt-thumbnail-generator` (text plan + generated thumbnail image)

Agent registry: `agents/manifest.json`

## One-Time API Key Setup

Save keys once so you never re-enter them:

```bash
bash scripts/save_api_keys.sh \
  --openai-key "YOUR_OPENAI_KEY" \
  --openrouter-key "YOUR_OPENROUTER_KEY" \
  --scope both
```

What this does:

- Saves keys in project `.env`
- Saves exports to `~/.zshrc`

The runner auto-loads `.env` each run.

## Run The Workflow

Transcript input:

```bash
python3 scripts/run_agents.py \
  --transcript-file /absolute/path/to/transcript.txt \
  --video-url "https://youtube.com/watch?v=YOUR_VIDEO_ID"
```

Topic-only input:

```bash
python3 scripts/run_agents.py \
  --topic "How AI search is reshaping discoverability"
```

## Important Defaults

- Auto-push is ON by default (`--auto-push`)
- Disable with `--no-auto-push`
- Outputs are written to `runs/YYYYMMDD-HHMMSS/`
- Auto-push stages and commits the run folder, then pushes to current branch

## Thumbnail Agent Notes

- Uses `OPENROUTER_API_KEY`
- Generation script: `skills/yt-thumbnail-generator/scripts/generate_thumbnail.py`
- Default headshots dir: `/Users/chrispanteli/Documents/YT HEADSHOTS`
- Force a headshot with:

```bash
python3 scripts/run_agents.py \
  --transcript-file /absolute/path/to/transcript.txt \
  --headshot pointing.png
```

## Common Options

```bash
python3 scripts/run_agents.py --help
```

Useful flags:

- `--agents yt-intro-title-description,yt-thumbnail-generator`
- `--request "Generate only section 2 titles"`
- `--dry-run`
- `--max-workers 4`
- `--headshots-dir "/custom/headshot/path"`
- `--no-auto-push`
