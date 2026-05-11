#!/usr/bin/env bash
set -euo pipefail

SHELL_FILE="src/shell.html"
SECTIONS_DIR="sections"
OUTPUT="index.html"
MARKER="<!-- {{SECTIONS}} -->"

echo "Building ${OUTPUT}..."

# sections/*.html 을 이름 순으로 연결
SECTIONS_CONTENT=""
for f in $(ls "${SECTIONS_DIR}"/*.html 2>/dev/null | sort); do
  SECTIONS_CONTENT="${SECTIONS_CONTENT}$(cat "$f")"$'\n'
done

# shell.html 읽기
SHELL_CONTENT=$(cat "${SHELL_FILE}")

# 마커를 섹션 내용으로 치환하여 출력
# Python을 사용해 UTF-8 안전 치환 (sed는 멀티바이트에서 불안정할 수 있음)
python3 - <<PYEOF
import sys

shell = open("${SHELL_FILE}", encoding="utf-8").read()
sections = ""
import os, glob
for f in sorted(glob.glob("${SECTIONS_DIR}/*.html")):
    sections += open(f, encoding="utf-8").read() + "\n"

output = shell.replace("${MARKER}", sections)

with open("${OUTPUT}", "w", encoding="utf-8") as fh:
    fh.write(output)
PYEOF

echo "${OUTPUT} built successfully."
