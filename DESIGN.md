# mdprev — Design

A local markdown preview server: point it at a directory, get a fast web view of every `.md` file with live reload.

```
mdprev [DIR] [--port 4040] [--open]
```

## Goals

- **Fast**: sub-millisecond renders for typical files, instant startup.
- **Lightweight**: single static binary, no runtime dependencies, no node_modules, works fully offline.
- **Auto reload**: edits show up in the browser without manual refresh, preserving scroll position.
- **Rich rendering**: GFM (tables, task lists, footnotes, strikethrough), syntax-highlighted code, Mermaid diagrams, ASCII-art diagrams rendered to SVG.

## Non-goals

- Not a static site generator (no build output, no permalinks).
- Not an editor — read-only preview.
- No remote/multi-user serving; binds `127.0.0.1` only.

## Stack

| Concern | Choice | Why |
|---|---|---|
| Language | Rust | Single binary, fast, no runtime |
| HTTP server | `axum` + `tokio` | Small, well-maintained, native SSE support |
| Markdown | `comrak` | Full GFM extension set, CommonMark-compliant |
| Syntax highlighting | `syntect` | Server-side — zero JS, no flash-of-unhighlighted-code |
| ASCII diagrams | `svgbob` | Renders ASCII art to clean SVG, server-side, pure Rust |
| Mermaid | `mermaid.min.js`, embedded | Only client-side piece; bundled into the binary so offline works |
| File watching | `notify` (+ debouncer) | Cross-platform FS events |
| Assets | `include_bytes!` / `rust-embed` | CSS/JS compiled into the binary |

Everything except Mermaid renders server-side. The page works with JS disabled (minus Mermaid and live reload).

## Architecture

```
                 ┌─────────────────────────────────────────┐
                 │                 mdprev                   │
                 │                                          │
 browser ◄──────►│  axum router                             │
   ▲             │   ├── GET /{path}      → render pipeline │
   │  SSE        │   ├── GET /__events    → reload bus      │
   └─────────────│   └── GET /__assets/*  → embedded assets │
                 │                                          │
                 │  notify watcher ──► broadcast channel ───┼──► SSE clients
                 │        │                                 │
                 │        └──► render cache invalidation    │
                 └─────────────────────────────────────────┘
```

Three components share state via `Arc<AppState>`:

1. **Router** — resolves URL → file, renders, serves.
2. **Watcher** — one recursive `notify` watcher on the root dir, debounced (~100ms) to collapse editor write bursts. On change: invalidate cache entry, publish the changed path on a `tokio::sync::broadcast` channel.
3. **Reload bus** — each open browser tab holds an SSE connection to `/__events`; the handler forwards broadcast events whose path matches the page the tab is viewing (or any path, for the index).

### Routing & navigation

The served directory browses like a file explorer:

- `GET /` and `GET /some/dir/` → directory index: subdirectories and `.md` files as links; if `README.md` or `index.md` exists in that directory, render it below the listing (GitHub repo-view behavior).
- `GET /notes/foo.md` → rendered page.
- `GET /notes/img.png` → any non-markdown file is served raw with its MIME type, so relative image links in markdown just work.
- **Breadcrumbs**: every page — listing or rendered file — shows a `root / notes / foo.md` trail at the top for jumping back up the tree.
- **Cross-doc links**: relative links between markdown files (`[other](../other.md)`, `[sub](guide/setup.md)`) resolve to their rendered pages, since URLs mirror file paths 1:1 — no link rewriting needed. Links ending in `.md#some-heading` land on the heading anchor. Absolute `http(s)://` links open externally, untouched.
- `GET /__assets/{app.css,app.js,mermaid.min.js}` → embedded, `Cache-Control: immutable`, content-hashed names.
- `GET /__events?path=...` → SSE stream.

Path resolution canonicalizes and verifies the result is inside the root dir — rejects `../` traversal with 404.

### Render pipeline

```
read file → comrak AST → walk code blocks:
    lang == "mermaid"          → emit <pre class="mermaid"> (raw source, client renders)
    lang in {"bob","svgbob","ascii"} → svgbob → inline <svg>
    other lang                 → syntect → highlighted <pre>
→ HTML body → wrap in layout template (title, CSS, reload script)
```

- **Cache**: `HashMap<PathBuf, (mtime, Arc<String>)>` behind an `RwLock`. Hit = serve cached HTML; watcher invalidates on change. Bounds memory naturally (only viewed files), and makes reload latency ≈ render time of one file.
- **syntect** setup: load defaults once at startup into a `lazy_static`/`OnceLock`; use `ClassedHTMLGenerator` (CSS classes, not inline styles) so one stylesheet handles light/dark themes.
- **Headings** get stable slug ids (`## Foo Bar` → `#foo-bar`) for anchor links; auto-generated anchor `¶` on hover.

### Live reload

- Client JS (~50 lines, embedded): open `EventSource('/__events?path=<current>')`.
- On a `change` event: `fetch(location.pathname)`, parse, swap `<article>` innerHTML, re-run `mermaid.run()` on new nodes. Scroll position is untouched because the document isn't reloaded.
- On `EventSource` error (server restarted): retry loop, full reload once it reconnects.
- File deleted → event tells client to show a "file removed" banner; file created → index pages refresh their tree.

Why SSE over WebSocket: one-directional is all we need, auto-reconnect is built into `EventSource`, and it's plain HTTP — less code on both ends.

### Frontend

- One handwritten CSS file (~GitHub-markdown look): responsive `max-width: 860px` article, `prefers-color-scheme` dark/light, print stylesheet.
- Mermaid theme follows the color scheme (`theme: dark/default` chosen at init).
- No framework, no build step. The only third-party asset is `mermaid.min.js` (~2.5 MB), embedded at compile time and served gzipped (~700 KB over the wire, cached immutable). It's loaded lazily — only on pages that actually contain a mermaid block.

## CLI

```
mdprev [DIR]            # default: current directory
  -p, --port <PORT>     # default 4040; falls back to next free port
  -o, --open            # open browser after start
  -q, --quiet           # no per-request logging
```

Startup prints one line: `serving /path/to/dir at http://127.0.0.1:4040`.

## Performance notes

- comrak + syntect render a typical 50 KB markdown file in well under 5 ms; cache makes repeat views ~0.
- Startup cost is dominated by syntect syntax-set loading (~50 ms with `default-fancy` off / dump loading on).
- Watcher is recursive but events are filtered to relevant extensions before hitting the bus.
- Expected binary size: ~10–15 MB (mostly embedded mermaid + syntect dumps). Acceptable for the offline guarantee; a `--no-mermaid` build flag can strip it if it ever matters.

## Security

- Binds `127.0.0.1` only; no flag to change it in v1.
- Canonicalized path containment check on every request (no serving outside root, no symlink escape).
- Raw HTML in markdown is passed through (it's your own local files — same trust model as `git` or an editor preview). Revisit if a share/tunnel feature is ever added.

## Milestones

1. **Serve + render**: CLI, router, comrak → HTML, embedded CSS, directory index. *(usable)*
2. **Highlighting**: syntect integration, light/dark themes.
3. **Live reload**: watcher, SSE, client swap script.
4. **Diagrams**: mermaid embedding + lazy load, svgbob blocks.
5. **Polish**: heading anchors, render cache, `--open`, error pages, request logging.
