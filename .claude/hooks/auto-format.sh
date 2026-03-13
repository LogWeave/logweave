#!/bin/bash

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Format Python files with ruff
if [[ "$FILE_PATH" == *.py ]]; then
  ruff format "$FILE_PATH" 2>/dev/null
  ruff check --fix "$FILE_PATH" 2>/dev/null
  exit 0
fi

# Format JS/TS files with biome
if [[ "$FILE_PATH" == *.js || "$FILE_PATH" == *.ts || "$FILE_PATH" == *.jsx || "$FILE_PATH" == *.tsx ]]; then
  npx @biomejs/biome format --write "$FILE_PATH" 2>/dev/null
  npx @biomejs/biome check --fix "$FILE_PATH" 2>/dev/null
  exit 0
fi

exit 0
