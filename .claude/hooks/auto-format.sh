#!/bin/bash

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

export PATH="$HOME/.local/bin:$PATH"

# Format Python files with ruff (via uvx)
if [[ "$FILE_PATH" == *.py ]]; then
  uvx ruff format "$FILE_PATH"
  uvx ruff check --fix "$FILE_PATH"
  exit $?
fi

# Format JS/TS files with biome
if [[ "$FILE_PATH" == *.js || "$FILE_PATH" == *.ts || "$FILE_PATH" == *.jsx || "$FILE_PATH" == *.tsx ]]; then
  npx @biomejs/biome format --write "$FILE_PATH"
  npx @biomejs/biome check --fix "$FILE_PATH"
  exit $?
fi

exit 0
