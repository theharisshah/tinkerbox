#!/bin/sh
# Tinkerbox command line helper
#
#   tinkerbox              open the current directory in Tinkerbox
#   tinkerbox <folder>     open a project folder in a new tab
#   tinkerbox <file.php>   open a PHP file in a new tab
#
# Installed by Tinkerbox (Help > Install Command Line Tool, or Settings). The installer fills in the
# location of the app below; when the values are empty the tinkerbox:// URL handler is used instead.
# TINKERBOX_TOKEN_FILE holds a secret only this user can read. It is added to the tinkerbox:// link
# so that Tinkerbox opens the folder without asking. Links from anywhere else (web pages, other
# programs) ask for confirmation first.

TINKERBOX_APP="__TINKERBOX_APP__"
TINKERBOX_EXEC="__TINKERBOX_EXEC__"
TINKERBOX_EXEC_ARG="__TINKERBOX_EXEC_ARG__"
TINKERBOX_TOKEN_FILE="__TINKERBOX_TOKEN_FILE__"

# Running the template directly (not installed): ignore the placeholders.
case "$TINKERBOX_APP" in __*__) TINKERBOX_APP="" ;; esac
case "$TINKERBOX_EXEC" in __*__) TINKERBOX_EXEC="" ;; esac
case "$TINKERBOX_EXEC_ARG" in __*__) TINKERBOX_EXEC_ARG="" ;; esac
case "$TINKERBOX_TOKEN_FILE" in __*__) TINKERBOX_TOKEN_FILE="" ;; esac

usage() {
  echo "Usage: tinkerbox [folder | file.php]"
  echo "Opens the folder (default: the current directory) or PHP file in Tinkerbox."
}

case "$1" in
  -h | --help)
    usage
    exit 0
    ;;
  -*)
    echo "tinkerbox: unknown option: $1" >&2
    usage >&2
    exit 2
    ;;
esac

if [ "$#" -gt 1 ]; then
  usage >&2
  exit 2
fi

TARGET=${1:-.}
# A set CDPATH makes `cd` print the directory, which would end up in the captured path.
unset CDPATH

if [ -d "$TARGET" ]; then
  ABS=$(cd -- "$TARGET" && pwd) || exit 1
elif [ -f "$TARGET" ]; then
  DIR=$(dirname -- "$TARGET")
  BASE=$(basename -- "$TARGET")
  ABS="$(cd -- "$DIR" && pwd)/$BASE" || exit 1
else
  echo "tinkerbox: no such file or directory: $TARGET" >&2
  exit 1
fi

# URL-safe base64 without padding, so the value survives URL query parsing untouched.
ENCODED=$(printf '%s' "$ABS" | base64 | tr -d '\n\r' | tr '+/' '-_' | tr -d '=')
URL="tinkerbox://open?cwd=$ENCODED"
if [ -n "$TINKERBOX_TOKEN_FILE" ] && [ -r "$TINKERBOX_TOKEN_FILE" ]; then
  TOKEN=$(tr -cd 'A-Za-z0-9_-' < "$TINKERBOX_TOKEN_FILE")
  if [ -n "$TOKEN" ]; then
    URL="$URL&token=$TOKEN"
  fi
fi

case "$(uname -s)" in
  Darwin)
    if [ -n "$TINKERBOX_APP" ] && [ -d "$TINKERBOX_APP" ]; then
      exec open -a "$TINKERBOX_APP" "$URL"
    fi
    exec open "$URL"
    ;;
  *)
    if [ -n "$TINKERBOX_EXEC" ] && [ -x "$TINKERBOX_EXEC" ]; then
      # A running instance receives the path through the single-instance handoff.
      if [ -n "$TINKERBOX_EXEC_ARG" ]; then
        nohup "$TINKERBOX_EXEC" "$TINKERBOX_EXEC_ARG" "$ABS" >/dev/null 2>&1 &
      else
        nohup "$TINKERBOX_EXEC" "$ABS" >/dev/null 2>&1 &
      fi
      exit 0
    fi
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$URL" >/dev/null 2>&1 &
      exit 0
    fi
    echo "tinkerbox: could not find the Tinkerbox application" >&2
    exit 1
    ;;
esac
