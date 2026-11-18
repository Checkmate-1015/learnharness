# Motion: manim animations beside the lesson

Date: 2026-11-15. Status: awaiting approval.

## Intent

Explain a maths idea as motion, in short clips that track the step the main
session is teaching, in a window that stays open beside the lesson. Built on
3b1b's manim (`3b1b/manim`, the `manimgl` command), with the Claude Code CLI
writing and repairing the scene code.

## Goals

- **On demand:** a sidebar button opens the Motion window; the learner types a
  concept and gets a clip sequence.
- **Proactive:** the teacher has a `motion` tool and calls it when a step would
  land better as an animation. The result appears in the Motion window and as a
  card in the lesson.
- **Bite-size and multi-step:** a request becomes a storyboard of 1 to 6 beats.
  Each beat is one idea, one manim `Scene`, target 10 to 25 seconds, with a
  one-line caption.
- **Matched to the lesson:** the storyboard is written from the current plan
  node, the last teaching message and the learner's latest answer, and uses the
  lesson's own notation.
- **Comments:** the learner comments on a beat (or the whole sequence) with a
  specific instruction; only the affected beats are re-rendered. Earlier
  versions stay viewable.
- **Separate window:** the Motion window is its own OS window, usable while the
  lesson window stays on the current step.

## Non-goals

- Narration or audio.
- Interactive (scrubbable-parameter) scenes; clips are rendered video.
- The manim community edition (`manim`), or mixing the two libraries.
- Publishing or exporting beyond the mp4 files on disk.

## Anti-goals

- A long single video. If a concept needs more than 6 beats it is split into
  several sequences.
- Animations that run ahead of the lesson or teach something the plan has not
  reached.
- Generated code that can run outside its own working folder.

## Constraints

- This Mac has no manim, ffmpeg or LaTeX, and its Python is 3.14. The tool gets
  its own environment: `uv` with a pinned Python (3.12), `manimgl` installed
  into it, `ffmpeg` from Homebrew, and a small LaTeX (BasicTeX plus the packages
  manim needs). Nothing is installed without the user's go-ahead.
- Plugins cannot open a window or dock a panel; that needs a core change, so
  this runs from the fork.
- Claude Code replays can be refused (issue 474); the scene-writing agent keeps
  its own short conversation per sequence and never receives the lesson
  transcript wholesale, only a brief.

## Approaches

1. **Plugin plus one small core capability. Chosen.** A `motion` plugin under
   `plugins/` owns the tool, the storyboard and render workers, storage,
   comments, the sidebar action and the player page. Core gains one generic
   feature: open a plugin view in its own window. Smallest diff to upstream, and
   the window capability is reusable (the agent watcher can use it later).
2. **All in core** as a new background job kind next to `visual` and `demo`.
   Reuses job delivery, but touches the job runner, contracts, tool cards and
   prompts, and conflicts with every upstream release.
3. **Standalone local web app** outside LearnHarness. Trivially its own window,
   but the teacher cannot call it and it cannot see the lesson.

## Design

**Core change (fork):**
- `electron/main.cjs`: an IPC call `lh:open-plugin-window(pluginId, viewId)`
  opens a second `BrowserWindow` on the same origin at
  `/?pluginWindow=<pluginId>/<viewId>`, with the same navigation and
  permission guards as the main window; one window per view, focused if
  already open.
- Frontend: when `pluginWindow` is set, render only that plugin view (no
  sidebar, no lesson). Plugin frontend API gains
  `ctx.app.openViewInWindow(viewId)`, falling back to `openView` in a browser.

**Plugin `plugins/motion`:**
- Backend
  - `motion` teacher tool via `registerTools` + `createBackgroundTool`:
    input `{ concept, nodeId?, focus? }`; returns a sequence id immediately and
    delivers a summary when rendering ends.
  - Storyboard worker (`ctx.workers`): from the brief, produce beats
    `{ title, caption, idea, sceneName }`.
  - Scene agent (`ctx.agents`) per sequence, on the model configured for the
    plugin (default: the Claude Code engine), with two native tools:
    `write_scene(beat, code)` and `render(beat)`. `render` runs
    `manimgl <file> <Scene> -w` in the sequence folder with a timeout, returns
    stderr on failure, and the agent repairs up to 3 times per beat.
  - Storage in the plugin data folder:
    `sequences/<id>/sequence.json`, `beat-<n>/v<k>/scene.py`, `beat-<n>/v<k>/clip.mp4`,
    `comments.json`.
  - Handlers: `list`, `get`, `create`, `comment`, `rerender`, `cancel`,
    `environment` (reports whether manimgl, ffmpeg and LaTeX are present).
  - Instructions (`registerInstructions`): when to reach for `motion` and that
    one call covers one plan node.
- Frontend
  - Sidebar action "Motion" → `openViewInWindow("motion")`.
  - Player view: sequence list, beat strip with captions, video player,
    per-beat comment box, version switcher, progress and errors per beat, a
    "new animation" box, and a setup notice when the environment is incomplete.
  - Tool-result renderer: a compact card in the lesson that opens the sequence
    in the Motion window.
- Lesson matching: the brief is built from `ctx.learning` (current plan node,
  last teacher message, last learner answer) plus the tool input or the typed
  request.

**Setup script** `plugins/motion/scripts/setup.sh`: creates the uv environment,
installs manimgl, checks ffmpeg and LaTeX, prints what is missing.

## Verification

- Unit tests for storage, comment-to-beat targeting, the render tool's
  failure/repair loop (fake `manimgl`), and the window route.
- One real render of a two-beat sequence after setup.
- Live: sidebar button, teacher-initiated call, a comment that re-renders one
  beat. Uses the Claude subscription; needs a go-ahead.

## Calls I made (not decisions you gave me)

- 1 to 6 beats, 10 to 25 seconds each, 3 repair attempts per beat.
- No audio in the first version.
- Comments re-render only the targeted beat unless the comment is on the whole
  sequence.
- Videos play from the plugin's data folder through a plugin handler, not a
  public URL.
- BasicTeX rather than full MacTeX.

## Left to the builder

- Player layout details and exact prompt wording.
- The manimgl config (resolution 720p, 30 fps as the starting point).
