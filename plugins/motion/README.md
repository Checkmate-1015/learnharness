# Motion

Short manim animations (3b1b/manim, the `manimgl` command) that follow the lesson, in their own window.

- **Sidebar → Motion** opens the Motion window. Type a concept to get a sequence of short clips: a quick look (up to 4) or a step-by-step derivation (up to 16) with a worked example, the reason for each step and a recap.
- The teacher has a `motion` tool and can send an animation to the window during a lesson.
- Comment on a clip to re-render just that clip; earlier versions stay available.
- If a run is cut off (the Mac slept, it was cancelled, a clip failed), **Continue** picks it up from the saved outline and makes only the clips that are missing. A run blocked part-way by the model provider's content filter restarts itself this way, up to 5 times.

## Setup

```bash
plugins/motion/scripts/setup.sh
```

Installs `manimgl` into `~/.learnharness-motion/venv` (Python 3.12 via `uv`) and reports whether `ffmpeg` and LaTeX are present. `--check` only reports.

## Install into the app

Copy `plugins/motion/dist` to `<data>/plugins/motion/dist`, then enable Motion under Settings → Community plugins. Opening in a separate window needs the fork's desktop build; in a plain browser the view opens in place.

## Safety

Scenes are Python written by the model and run on this machine with your user permissions. A filter refuses imports other than `manimlib`, `numpy` and `math` and obvious file, process and network calls. It is a filter, not a sandbox.

## Tests

```bash
node --test plugins/motion/tests/backend.test.cjs
```
