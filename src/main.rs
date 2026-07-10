mod render;

use std::collections::HashMap;
use std::convert::Infallible;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use clap::Parser;
use notify::RecursiveMode;
use notify_debouncer_mini::new_debouncer;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use render::{escape_html, page, Renderer};

#[derive(Parser)]
#[command(name = "mdprev", about = "Fast local markdown preview server")]
struct Args {
    /// Directory to serve (default: current directory)
    dir: Option<PathBuf>,
    /// Port to bind (falls back to the next free port)
    #[arg(short, long, default_value_t = 4040)]
    port: u16,
    /// Open the browser after starting
    #[arg(short, long)]
    open: bool,
    /// Suppress per-request logging
    #[arg(short, long)]
    quiet: bool,
}

struct AppState {
    root: PathBuf,
    renderer: Renderer,
    tx: tokio::sync::broadcast::Sender<String>,
    quiet: bool,
}

#[tokio::main]
async fn main() {
    let args = Args::parse();
    let root = args
        .dir
        .unwrap_or_else(|| PathBuf::from("."))
        .canonicalize()
        .unwrap_or_else(|e| {
            eprintln!("mdprev: cannot open directory: {e}");
            std::process::exit(1);
        });
    if !root.is_dir() {
        eprintln!("mdprev: {} is not a directory", root.display());
        std::process::exit(1);
    }

    let (tx, _) = tokio::sync::broadcast::channel::<String>(64);
    let state = Arc::new(AppState {
        root: root.clone(),
        renderer: Renderer::new(),
        tx: tx.clone(),
        quiet: args.quiet,
    });

    spawn_watcher(root.clone(), tx);

    let app = Router::new()
        .route("/__assets/{*file}", get(assets))
        .route("/__events", get(events))
        .route("/", get(serve_root))
        .route("/{*path}", get(serve_path))
        .with_state(state);

    let (listener, port) = bind_port(args.port).await;
    let url = format!("http://127.0.0.1:{port}");
    println!("mdprev: serving {} at {url}", root.display());

    if args.open {
        let _ = std::process::Command::new("open").arg(&url).spawn();
    }

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .unwrap();
}

async fn bind_port(start: u16) -> (tokio::net::TcpListener, u16) {
    for port in start..start.saturating_add(50) {
        if let Ok(l) = tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            return (l, port);
        }
    }
    eprintln!("mdprev: no free port in {start}..{}", start + 50);
    std::process::exit(1);
}

/// Watch the tree and forward changed paths (root-relative, `/`-joined) onto
/// the broadcast channel. `notify` is blocking, so it lives on its own thread.
fn spawn_watcher(root: PathBuf, tx: tokio::sync::broadcast::Sender<String>) {
    std::thread::spawn(move || {
        let (raw_tx, raw_rx) = std::sync::mpsc::channel();
        let mut debouncer = match new_debouncer(Duration::from_millis(120), raw_tx) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("mdprev: watcher disabled: {e}");
                return;
            }
        };
        if let Err(e) = debouncer.watcher().watch(&root, RecursiveMode::Recursive) {
            eprintln!("mdprev: watcher disabled: {e}");
            return;
        }
        for result in raw_rx {
            let Ok(events) = result else { continue };
            for event in events {
                if let Some(rel) = rel_path(&root, &event.path) {
                    let _ = tx.send(rel);
                }
            }
        }
    });
}

fn rel_path(root: &FsPath, path: &FsPath) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let joined = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    if joined.is_empty() {
        None
    } else {
        Some(joined)
    }
}

async fn serve_root(State(state): State<Arc<AppState>>) -> Response {
    serve(&state, "").await
}

async fn serve_path(State(state): State<Arc<AppState>>, Path(path): Path<String>) -> Response {
    serve(&state, &path).await
}

async fn serve(state: &AppState, rel: &str) -> Response {
    let rel = rel.trim_matches('/');
    let target = match resolve(&state.root, rel) {
        Some(p) => p,
        None => return not_found(rel),
    };

    if !state.quiet {
        println!("GET /{rel}");
    }

    if target.is_dir() {
        return render_dir(state, &target, rel).await;
    }

    let is_md = target
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| matches!(e.to_ascii_lowercase().as_str(), "md" | "markdown"))
        .unwrap_or(false);

    if is_md {
        render_file(state, &target, rel).await
    } else {
        serve_raw(&target).await
    }
}

/// Join `rel` under `root` and confirm the canonicalized result stays inside
/// `root` — blocks `../` traversal and symlink escapes.
fn resolve(root: &FsPath, rel: &str) -> Option<PathBuf> {
    let candidate = if rel.is_empty() {
        root.to_path_buf()
    } else {
        root.join(rel)
    };
    let canon = candidate.canonicalize().ok()?;
    if canon.starts_with(root) {
        Some(canon)
    } else {
        None
    }
}

async fn serve_raw(path: &FsPath) -> Response {
    match tokio::fs::read(path).await {
        Ok(bytes) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.as_ref())], bytes).into_response()
        }
        Err(_) => not_found(&path.to_string_lossy()),
    }
}

async fn render_file(state: &AppState, path: &FsPath, rel: &str) -> Response {
    let markdown = match tokio::fs::read_to_string(path).await {
        Ok(s) => s,
        Err(_) => return not_found(rel),
    };
    let body = state.renderer.render(&markdown);
    let title = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "mdprev".into());
    let crumbs = breadcrumbs(rel, false);
    Html(page(&title, &crumbs, &body, rel, "file")).into_response()
}

async fn render_dir(state: &AppState, dir: &FsPath, rel: &str) -> Response {
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    let mut readme: Option<PathBuf> = None;

    if let Ok(mut entries) = tokio::fs::read_dir(dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let ft = match entry.file_type().await {
                Ok(t) => t,
                Err(_) => continue,
            };
            if ft.is_dir() {
                dirs.push(name);
            } else if is_markdown(&name) {
                if matches!(name.to_ascii_lowercase().as_str(), "readme.md" | "index.md") {
                    readme = Some(entry.path());
                }
                files.push(name);
            }
        }
    }
    dirs.sort();
    files.sort();

    let base = if rel.is_empty() {
        String::new()
    } else {
        format!("{rel}/")
    };
    let mut list = String::from("<ul class=\"dir-list\">");
    if !rel.is_empty() {
        list.push_str("<li><a href=\"../\"><span class=\"icon\">↩</span><span class=\"name\">..</span></a></li>");
    }
    for d in &dirs {
        list.push_str(&format!(
            "<li><a href=\"/{}{}/\"><span class=\"icon\">📁</span><span class=\"name\">{}</span></a></li>",
            escape_attr(&base),
            escape_attr(d),
            escape_html(d),
        ));
    }
    for f in &files {
        list.push_str(&format!(
            "<li><a href=\"/{}{}\"><span class=\"icon\">📄</span><span class=\"name\">{}</span></a></li>",
            escape_attr(&base),
            escape_attr(f),
            escape_html(f),
        ));
    }
    list.push_str("</ul>");

    if let Some(readme_path) = readme {
        if let Ok(md) = tokio::fs::read_to_string(&readme_path).await {
            list.push_str("<hr>");
            list.push_str(&state.renderer.render(&md));
        }
    }

    let title = if rel.is_empty() {
        "mdprev".to_string()
    } else {
        rel.rsplit('/').next().unwrap_or(rel).to_string()
    };
    let crumbs = breadcrumbs(rel, true);
    Html(page(&title, &crumbs, &list, rel, "dir")).into_response()
}

fn is_markdown(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

/// Build the breadcrumb trail. Intermediate segments link to their directory;
/// the final segment of a file page is plain text.
fn breadcrumbs(rel: &str, is_dir: bool) -> String {
    let mut out = String::from("<a href=\"/\">root</a>");
    if rel.is_empty() {
        return out;
    }
    let parts: Vec<&str> = rel.split('/').filter(|s| !s.is_empty()).collect();
    let mut acc = String::new();
    for (i, part) in parts.iter().enumerate() {
        acc.push_str(part);
        let last = i == parts.len() - 1;
        out.push_str("<span class=\"sep\">/</span>");
        if last && !is_dir {
            out.push_str(&escape_html(part));
        } else {
            out.push_str(&format!(
                "<a href=\"/{}{}\">{}</a>",
                escape_attr(&acc),
                if is_dir || !last { "/" } else { "" },
                escape_html(part),
            ));
        }
        acc.push('/');
    }
    out
}

fn escape_attr(s: &str) -> String {
    s.replace('"', "%22").replace(' ', "%20")
}

fn not_found(rel: &str) -> Response {
    (
        StatusCode::NOT_FOUND,
        Html(format!(
            "<!doctype html><meta charset=utf-8><title>404</title>\
             <body style=\"font-family:sans-serif;padding:40px\">\
             <h1>404</h1><p>Not found: {}</p><p><a href=\"/\">root</a></p>",
            escape_html(rel)
        )),
    )
        .into_response()
}

async fn assets(State(state): State<Arc<AppState>>, Path(file): Path<String>) -> Response {
    // syntax.css depends on the loaded theme, so it is generated at runtime.
    if file == "syntax.css" {
        return (
            [
                (header::CONTENT_TYPE, "text/css"),
                (header::CACHE_CONTROL, "public, max-age=3600"),
            ],
            state.renderer.syntax_css.clone(),
        )
            .into_response();
    }
    let (bytes, mime): (&[u8], &str) = match file.as_str() {
        "app.css" => (include_bytes!("../assets/app.css"), "text/css"),
        "app.js" => (
            include_bytes!("../assets/app.js"),
            "text/javascript; charset=utf-8",
        ),
        "mermaid.min.js" => (
            include_bytes!("../assets/mermaid.min.js"),
            "text/javascript; charset=utf-8",
        ),
        _ => return (StatusCode::NOT_FOUND, "").into_response(),
    };
    (
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, "public, max-age=3600"),
        ],
        bytes,
    )
        .into_response()
}

async fn events(
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let sub = params.get("path").cloned().unwrap_or_default();
    let rx = state.tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(move |msg| match msg {
        Ok(changed) if path_matches(&sub, &changed) => {
            Some(Ok(Event::default().event("change").data(changed)))
        }
        _ => None,
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// A subscriber to `sub` cares about a change to `changed` when it is the same
/// file, or (for a directory page) any file beneath it. Empty `sub` is the
/// root index and matches everything.
fn path_matches(sub: &str, changed: &str) -> bool {
    sub.is_empty() || changed == sub || changed.starts_with(&format!("{sub}/"))
}
