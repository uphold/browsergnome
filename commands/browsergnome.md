---
name: browsergnome
description: The autonomous JS web performance engineer. Open the browsergnome menu (Perf Map 3D, Autoresearch, Senior Engineer Audit, Doctor, Configurations), analyze dependencies for perf-relevant upgrades (Dep Pulse), or pass a natural-language goal.
argument-hint: "<natural-language goal> | scan <path> | map <graph.json> | first-load | analyze my deps"
---

browsergnome routes web performance work through chrome-devtools-mcp, runs a scientific propose →
measure → keep/revert loop (`first-load`, `bundle-size`, `interaction`, and `layout-shift`), builds a
3D Perf Map, and maintains per-repo performance memory.

Read `${CLAUDE_PLUGIN_ROOT}/skills/browsergnome/SKILL.md` now and follow it.

ARGUMENTS: $ARGUMENTS

Routing:
- **No arguments** → present the top menu per SKILL.md's menu rules.
- **"scan <path>"** or a diagnostic ask ("what's slow here", "build a perf map") → run Perf Map 3D.
- **"fix my LCP" / "the homepage is slow to load" / "first-load"** → run the `first-load` Autoresearch
  preset (SKILL.md's Autoresearch section).
- **"shrink my bundle" / "my JS is too big" / "bundle-size"** → run the `bundle-size` Autoresearch
  preset (SKILL.md's Autoresearch section, `bundle-size` subsection).
- **"my INP is bad" / "the UI feels laggy when I click X"** → run the `interaction` Autoresearch preset
  (SKILL.md's Autoresearch section, `interaction` subsection).
- **"fix my CLS" / "content keeps jumping"** → run the `layout-shift` Autoresearch preset (SKILL.md's
  Autoresearch section, `layout-shift` subsection) — check the target's baseline shift-occurrence rate
  first, per that subsection, before committing to a full N-run loop.
- **"analyze my deps" / "dependency recommendations" / "what should I upgrade"** → run Dep Pulse
  standalone (SKILL.md's Dep Pulse section, `references/dep-pulse.md`'s "Standalone" section) — inline
  in this agent, no subagent dispatch, never routed through Senior Engineer Audit or a Perf Map scan.

Note: if running scripts outside a Claude session, run `npm install` in the plugin root first.
