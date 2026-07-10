(() => {
  "use strict";
  const body = document.body;
  const watchPath = body.dataset.path || "";
  const kind = body.dataset.kind || "file";
  let mermaidLoaded = false;

  function isDark() {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  // Lazily load the embedded mermaid bundle, only when a diagram exists.
  function renderMermaid() {
    const nodes = document.querySelectorAll("pre.mermaid:not([data-processed])");
    if (nodes.length === 0) return;
    const run = () => {
      window.mermaid.initialize({
        startOnLoad: false,
        theme: isDark() ? "dark" : "default",
      });
      window.mermaid.run({ nodes }).catch((e) => console.error("mermaid:", e));
    };
    if (mermaidLoaded && window.mermaid) {
      run();
      return;
    }
    const s = document.createElement("script");
    s.src = "/__assets/mermaid.min.js";
    s.onload = () => {
      mermaidLoaded = true;
      run();
    };
    document.head.appendChild(s);
  }

  function showBanner(text) {
    let b = document.querySelector(".reload-banner");
    if (!b) {
      b = document.createElement("div");
      b.className = "reload-banner";
      document.body.appendChild(b);
    }
    b.textContent = text;
    return b;
  }

  // Swap <main> content in place so scroll position is preserved.
  async function refresh() {
    try {
      const res = await fetch(location.pathname, { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 404) showBanner("file removed");
        return;
      }
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const fresh = doc.querySelector("main");
      const current = document.querySelector("main");
      if (fresh && current) {
        current.replaceWith(fresh);
        renderMermaid();
      }
      const banner = document.querySelector(".reload-banner");
      if (banner) banner.remove();
    } catch (e) {
      console.error("refresh:", e);
    }
  }

  function connect() {
    const es = new EventSource("/__events?path=" + encodeURIComponent(watchPath));
    es.addEventListener("change", () => {
      // Directory pages re-render their tree on any change; simplest is reload.
      if (kind === "dir") location.reload();
      else refresh();
    });
    es.onerror = () => {
      // Server likely restarting; EventSource auto-reconnects. Full reload
      // once it comes back so we pick up any asset changes.
      es.close();
      const b = showBanner("reconnecting…");
      const retry = setInterval(() => {
        fetch(location.pathname, { method: "HEAD", cache: "no-store" })
          .then((r) => {
            if (r.ok) {
              clearInterval(retry);
              location.reload();
            }
          })
          .catch(() => {});
      }, 1000);
      b.dataset.retrying = "1";
    };
  }

  renderMermaid();
  connect();
})();
