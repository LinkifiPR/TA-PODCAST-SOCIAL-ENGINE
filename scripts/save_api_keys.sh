#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Save API keys so you don't need to paste them every run.

Usage:
  bash scripts/save_api_keys.sh [options]

Options:
  --openai-key <key>        Set OPENAI_API_KEY
  --openrouter-key <key>    Set OPENROUTER_API_KEY
  --env-file <path>         Project env file (default: .env)
  --shell-rc <path>         Shell rc file (default: ~/.zshrc)
  --scope <project|shell|both>  Where to save keys (default: both)
  -h, --help                Show this help message
USAGE
}

openai_key=""
openrouter_key=""
env_file=".env"
shell_rc="${HOME}/.zshrc"
scope="both"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --openai-key)
      openai_key="${2:-}"
      shift 2
      ;;
    --openrouter-key)
      openrouter_key="${2:-}"
      shift 2
      ;;
    --env-file)
      env_file="${2:-}"
      shift 2
      ;;
    --shell-rc)
      shell_rc="${2:-}"
      shift 2
      ;;
    --scope)
      scope="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$openai_key" && -z "$openrouter_key" ]]; then
  echo "Provide at least one key via --openai-key or --openrouter-key." >&2
  exit 1
fi

if [[ "$scope" != "project" && "$scope" != "shell" && "$scope" != "both" ]]; then
  echo "--scope must be one of: project, shell, both" >&2
  exit 1
fi

write_project_env() {
  local file="$1"
  local set_openai="0"
  local set_openrouter="0"
  [[ -n "$openai_key" ]] && set_openai="1"
  [[ -n "$openrouter_key" ]] && set_openrouter="1"

  touch "$file"
  local tmp
  tmp="$(mktemp)"

  awk \
    -v set_openai="$set_openai" \
    -v set_openrouter="$set_openrouter" \
    -v openai="$openai_key" \
    -v openrouter="$openrouter_key" \
    '
      {
        if (set_openai == "1" && $0 ~ /^OPENAI_API_KEY=/) next
        if (set_openrouter == "1" && $0 ~ /^OPENROUTER_API_KEY=/) next
        print
      }
      END {
        if (set_openai == "1") print "OPENAI_API_KEY=\"" openai "\""
        if (set_openrouter == "1") print "OPENROUTER_API_KEY=\"" openrouter "\""
      }
    ' "$file" > "$tmp"

  mv "$tmp" "$file"
  chmod 600 "$file"
  echo "Saved key(s) to $file"
}

write_shell_rc() {
  local file="$1"
  local start="# >>> TA PODCAST SOCIAL ENGINE API KEYS >>>"
  local end="# <<< TA PODCAST SOCIAL ENGINE API KEYS <<<"

  touch "$file"
  local tmp
  tmp="$(mktemp)"

  awk -v start="$start" -v end="$end" '
    $0 == start {skip=1; next}
    $0 == end {skip=0; next}
    !skip {print}
  ' "$file" > "$tmp"

  {
    echo ""
    echo "$start"
    [[ -n "$openai_key" ]] && echo "export OPENAI_API_KEY=\"$openai_key\""
    [[ -n "$openrouter_key" ]] && echo "export OPENROUTER_API_KEY=\"$openrouter_key\""
    echo "$end"
  } >> "$tmp"

  mv "$tmp" "$file"
  echo "Saved key(s) to $file"
  echo "Run: source $file"
}

if [[ "$scope" == "project" || "$scope" == "both" ]]; then
  write_project_env "$env_file"
fi

if [[ "$scope" == "shell" || "$scope" == "both" ]]; then
  write_shell_rc "$shell_rc"
fi
