#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
open -a "Brave Browser" "brave://extensions/"
open "$SCRIPT_DIR"
