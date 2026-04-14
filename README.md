# TA Podcast Social Engine

Transcript-in, multi-agent content engine for Total Authority.

## What You Have Now

- Netlify UI to paste transcript and run agents: `app/`
- Netlify serverless API orchestration: `netlify/functions/`
- Agent registry: `agents/manifest.json`
- Skill prompts:
  - `skills/yt-intro-title-description/prompt.md`
  - `skills/yt-thumbnail-generator/prompt.md`
  - `skills/social-post-generator/prompt.md`

## Deploy To Netlify

1. Push this repo to GitHub.
2. In Netlify, import the repo as a new site.
3. Build settings are already in `netlify.toml`:
   - Publish directory: `app`
   - Functions directory: `netlify/functions`
4. Set these Netlify environment variables:
   - `OPENAI_API_KEY`
   - `OPENROUTER_API_KEY`
   - Thumbnail model is fixed to `google/gemini-3-pro-image-preview` (Nano Banana Pro)
   - Optional (local/server environments with filesystem access): `HEADSHOTS_DIR`

After deploy, open the site URL and run the workflow from the UI.

## UI Workflow

1. Paste transcript (or topic) into the input.
2. Optionally add video URL and run instruction.
3. Optionally upload a headshot image for thumbnail generation.
4. Select agents.
5. If thumbnail agent is selected, answer the thumbnail questions:
   - Choose format
   - Choose whether to use a headshot
   - Optional overlay text
6. Click `Run Agents`.

You get:

- One result card per agent
- Full text outputs
- Generated thumbnail preview + download (when thumbnail agent runs)

## Add More Skill Agents

1. Add skill prompt file: `skills/<agent-id>/prompt.md`
2. Add entry to `agents/manifest.json`
3. For standard text agents, set:
   - `"executor": "text"`
4. For image thumbnail pipeline, set:
   - `"executor": "thumbnail"`

The UI auto-loads enabled agents from `/api/agents`.

## Local API Key Save (Optional)

If you also run local scripts, save keys once:

```bash
bash scripts/save_api_keys.sh \
  --openai-key "YOUR_OPENAI_KEY" \
  --openrouter-key "YOUR_OPENROUTER_KEY" \
  --scope both
```

## Legacy Local Runner (Optional)

The Python runner still works for local batch runs:

```bash
python3 scripts/run_agents.py \
  --transcript-file /absolute/path/to/transcript.txt
```
