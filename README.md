# mdprev

Fast, lightweight local markdown preview server. Point it at a directory and browse every `.md` file in your browser with live reload — no build step, no node_modules, works fully offline.

```sh
cargo build --release
./target/release/mdprev sample --open
```

## Features

- **Explorer navigation** — browse directories, open files, follow relative links between docs. Breadcrumbs on every page.
- **Live reload** — edits appear instantly; scroll position is preserved (only the article body is swapped).
- **GitHub-flavored markdown** — tables, task lists, footnotes, strikethrough, and GitHub-style alerts (`> [!NOTE]`).
- **Syntax highlighting** — server-side via syntect, with light/dark themes that follow your system.
- **Mermaid diagrams** — ` ```mermaid ` blocks, rendered client-side. The bundle is embedded and lazy-loaded (only on pages that use it).
- **ASCII diagrams** — ` ```bob `, ` ```svgbob `, or ` ```ascii ` blocks are rendered to SVG server-side.

## Usage

```
mdprev [DIR]            # directory to serve (default: current directory)
  -p, --port <PORT>     # default 4040; falls back to the next free port
  -o, --open            # open the browser after starting
  -q, --quiet           # suppress per-request logging
```

The server binds `127.0.0.1` only. See [DESIGN.md](DESIGN.md) for architecture.
