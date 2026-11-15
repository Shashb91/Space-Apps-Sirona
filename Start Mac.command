#!/bin/sh
# Sirona - Lunar Landing Site Navigator: double-click to start the app (Mac). On Linux: sh "Start Mac.command"
# All the work is in launcher.py: the maps, the Python packages, the server and the browser.
cd "$(dirname "$0")" || exit 1
printf '\033]0;Sirona - Lunar Landing Site Navigator\007'  # the window title
stop() { printf '\nPress Enter to close this window.'; read -r _; exit 1; }

# A 64-bit Python 3.10 or newer
for py in python3.14 python3.13 python3.12 python3.15 python3.11 python3.10 python3 python; do
  if command -v "$py" >/dev/null 2>&1 &&
     "$py" -c 'import sys, struct; sys.exit(sys.version_info < (3, 10) or struct.calcsize("P") != 8)' >/dev/null 2>&1; then
    "$py" launcher.py "$@" || stop
    exit 0
  fi
done
echo "This app needs Python 3.10 or newer: install it from https://www.python.org/downloads/"
echo "then double-click this file again."
[ "$(uname)" = Darwin ] && open "https://www.python.org/downloads/"
stop
