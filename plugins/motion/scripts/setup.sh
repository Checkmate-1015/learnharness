#!/usr/bin/env bash
# Sets up what Motion needs to render: manimgl (3b1b/manim) in its own Python
# environment, plus checks for ffmpeg and LaTeX. Safe to run again.
#   --check   only report what is present; install nothing
set -euo pipefail

HOME_ENV="${HOME}/.learnharness-motion"
VENV="${HOME_ENV}/venv"
export PATH="/opt/homebrew/bin:/usr/local/bin:/Library/TeX/texbin:${PATH}"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

have() { command -v "$1" >/dev/null 2>&1; }
report() { printf '%-8s %s\n' "$1" "$2"; }

if [ "${CHECK_ONLY}" -eq 0 ]; then
	have uv || { echo "uv is required (brew install uv)"; exit 1; }
	mkdir -p "${HOME_ENV}"
	[ -x "${VENV}/bin/python" ] || uv venv --python 3.12 "${VENV}"
	# manimgl 1.7.2 imports pkg_resources, which setuptools 81 removed.
	uv pip install --python "${VENV}/bin/python" manimgl "setuptools<81"
fi

missing=0
if [ -x "${VENV}/bin/manimgl" ]; then report manimgl "ok (${VENV}/bin/manimgl)"; else report manimgl "missing: run this script without --check"; missing=1; fi
if have ffmpeg; then report ffmpeg "ok"; else report ffmpeg "missing: brew install ffmpeg"; missing=1; fi
if have latex; then report latex "ok"; else
	report latex "missing: brew install --cask basictex, then:"
	echo "         sudo tlmgr update --self && sudo tlmgr install standalone preview doublestroke relsize fundus-calligra wasysym physics dvisvgm rsfs wasy cm-super dvipng setspace calligra xcolor babel-english amsmath amsfonts mathtools"
	missing=1
fi
exit "${missing}"
