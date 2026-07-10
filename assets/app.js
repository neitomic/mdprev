(() => {
  "use strict";
  const body = document.body;
  const watchPath = body.dataset.path || "";
  const kind = body.dataset.kind || "file";
  const themeToggle = document.querySelector(".theme-toggle");
  const syntaxDarkTheme = document.querySelector("#syntax-dark-theme");
  let mermaidLoaded = false;
  let mermaidLoadPromise = null;
  let mermaidObserver = null;
  let eventSource = null;
  let reconnectTimer = null;

  function preference() {
    try {
      const value = localStorage.getItem("mdprev-theme");
      return value === "light" || value === "dark" ? value : null;
    } catch (_) {
      return null;
    }
  }

  function isDark() {
    const selected = preference();
    return selected ? selected === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function applyTheme(theme) {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    if (syntaxDarkTheme) {
      syntaxDarkTheme.media = theme === "dark" ? "all" : theme === "light" ? "not all" : "(prefers-color-scheme: dark)";
    }
    if (themeToggle) {
      const next = isDark() ? "light" : "dark";
      themeToggle.setAttribute("aria-label", `Switch to ${next} theme`);
      themeToggle.setAttribute("title", `Switch to ${next} theme`);
      themeToggle.firstElementChild.textContent = isDark() ? "☀" : "◐";
    }
  }

  function toggleTheme() {
    const next = isDark() ? "light" : "dark";
    try {
      localStorage.setItem("mdprev-theme", next);
    } catch (_) {}
    applyTheme(next);
  }

  // Load Mermaid only if needed, then render diagrams as they approach the
  // viewport. Rendering several flowcharts at once can otherwise monopolize
  // the browser's main thread on diagram-heavy documents.
  function renderMermaid() {
    const nodes = document.querySelectorAll("pre.mermaid:not([data-processed])");
    if (nodes.length === 0) return;

    const observe = () => {
      const render = (visible) => {
        visible.forEach((node) => {
          delete node.dataset.mermaidQueued;
          mermaidObserver?.unobserve(node);
        });
        window.mermaid.initialize({
          startOnLoad: false,
          theme: isDark() ? "dark" : "default",
        });
        window.mermaid.run({ nodes: visible }).catch((e) => console.error("mermaid:", e));
      };

      if (!("IntersectionObserver" in window)) {
        render(Array.from(nodes));
        return;
      }
      if (!mermaidObserver) {
        mermaidObserver = new IntersectionObserver(
          (entries) => render(entries.filter((entry) => entry.isIntersecting && entry.target.isConnected).map((entry) => entry.target)),
          { rootMargin: "300px 0px" },
        );
      }
      nodes.forEach((node) => {
        if (node.isConnected && !node.dataset.mermaidQueued) {
          node.dataset.mermaidQueued = "1";
          mermaidObserver.observe(node);
        }
      });
    };

    if (!mermaidLoadPromise) {
      mermaidLoadPromise = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "/__assets/mermaid.min.js";
        s.onload = () => {
          mermaidLoaded = true;
          resolve();
        };
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    mermaidLoadPromise.then(observe).catch((e) => console.error("mermaid:", e));
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
        mermaidObserver?.disconnect();
        mermaidObserver = null;
        current.replaceWith(fresh);
        renderMermaid();
      }
      const banner = document.querySelector(".reload-banner");
      if (banner) banner.remove();
    } catch (e) {
      console.error("refresh:", e);
    }
  }

  // A document can remain alive briefly during navigation (and can be kept in
  // the back/forward cache). Explicitly release its long-lived connection so
  // successive document visits cannot consume the browser's connection pool.
  function disconnect() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function connect() {
    disconnect();
    const es = new EventSource("/__events?path=" + encodeURIComponent(watchPath));
    eventSource = es;
    es.addEventListener("change", () => {
      if (eventSource !== es) return;
      // Directory pages re-render their tree on any change; simplest is reload.
      if (kind === "dir") location.reload();
      else refresh();
    });
    es.onerror = () => {
      if (eventSource !== es || reconnectTimer) return;
      // Server likely restarting; EventSource auto-reconnects. Full reload
      // once it comes back so we pick up any asset changes.
      es.close();
      eventSource = null;
      const b = showBanner("reconnecting…");
      const retry = setInterval(() => {
        fetch(location.pathname, { method: "HEAD", cache: "no-store" })
          .then((r) => {
            if (r.ok && reconnectTimer === retry) {
              clearInterval(retry);
              reconnectTimer = null;
              location.reload();
            }
          })
          .catch(() => {});
      }, 1000);
      reconnectTimer = retry;
      b.dataset.retrying = "1";
    };
  }

  applyTheme(preference());
  themeToggle?.addEventListener("click", toggleTheme);
  renderMermaid();
  connect();
  window.addEventListener("pagehide", disconnect);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) connect();
  });
})();
