(() => {
  "use strict";
  const body = document.body;
  const watchPath = body.dataset.path || "";
  const kind = body.dataset.kind || "file";
  const themeToggle = document.querySelector(".theme-toggle");
  const syntaxDarkTheme = document.querySelector("#syntax-dark-theme");
  const explorerTree = document.querySelector(".explorer-tree");
  const explorerPin = document.querySelector(".explorer-pin");
  let mermaidLoaded = false;
  let mermaidLoadPromise = null;
  let mermaidObserver = null;
  let eventSource = null;
  let reconnectTimer = null;
  let fileIndexPromise = null;
  let filePicker = null;
  let pickerInput = null;
  let pickerResults = null;
  let pickerMatches = [];
  let pickerSelection = 0;

  function applyExplorerAutoHide(enabled) {
    document.documentElement.classList.toggle("explorer-auto-hide", enabled);
    if (!explorerPin) return;
    explorerPin.setAttribute("aria-pressed", String(!enabled));
    explorerPin.setAttribute("aria-label", enabled ? "Keep explorer open" : "Enable explorer auto-hide");
    explorerPin.setAttribute("title", enabled ? "Keep explorer open" : "Enable explorer auto-hide");
    explorerPin.classList.toggle("is-pinned", !enabled);
  }

  function toggleExplorerAutoHide() {
    const enabled = !document.documentElement.classList.contains("explorer-auto-hide");
    try { localStorage.setItem("mdprev-explorer-auto-hide", String(enabled)); } catch (_) {}
    applyExplorerAutoHide(enabled);
  }

  function renderExplorer(files) {
    if (!explorerTree) return;
    const root = { directories: new Map(), files: [] };
    files.forEach((path) => {
      const parts = path.split("/");
      const filename = parts.pop();
      let node = root;
      parts.forEach((part) => {
        if (!node.directories.has(part)) node.directories.set(part, { directories: new Map(), files: [] });
        node = node.directories.get(part);
      });
      node.files.push({ name: filename, path });
    });
    const currentParts = watchPath.split("/");
    const build = (node, prefix = "") => {
      const list = document.createElement("ul");
      for (const [name, child] of [...node.directories].sort(([a], [b]) => a.localeCompare(b))) {
        const path = prefix ? `${prefix}/${name}` : name;
        const item = document.createElement("li");
        const details = document.createElement("details");
        details.open = currentParts.slice(0, path.split("/").length).join("/") === path;
        const summary = document.createElement("summary");
        summary.textContent = name;
        details.append(summary, build(child, path));
        item.appendChild(details);
        list.appendChild(item);
      }
      node.files.sort((a, b) => a.name.localeCompare(b.name)).forEach((file) => {
        const item = document.createElement("li");
        const link = document.createElement("a");
        link.href = "/" + file.path.split("/").map(encodeURIComponent).join("/");
        link.textContent = file.name;
        link.title = file.path;
        if (file.path === watchPath) {
          link.className = "is-current";
          link.setAttribute("aria-current", "page");
        }
        item.appendChild(link);
        list.appendChild(item);
      });
      return list;
    };
    explorerTree.replaceChildren(build(root));
    explorerTree.querySelector(".is-current")?.scrollIntoView({ block: "nearest" });
  }

  function loadExplorer() {
    loadFileIndex().then(renderExplorer).catch((error) => {
      console.error(error);
      if (explorerTree) explorerTree.textContent = "Could not load files";
    });
  }

  function fuzzyScore(path, query) {
    const needle = query.toLocaleLowerCase().replaceAll(/\s+/g, "");
    if (!needle) return 0;

    const haystack = path.toLocaleLowerCase();
    const filename = haystack.slice(haystack.lastIndexOf("/") + 1);
    let score = 0;
    let index = -1;
    let previous = -2;
    for (const character of needle) {
      index = haystack.indexOf(character, index + 1);
      if (index === -1) return null;
      score += index === previous + 1 ? 8 : 1;
      if (index === 0 || haystack[index - 1] === "/" || haystack[index - 1] === "-" || haystack[index - 1] === "_") score += 4;
      previous = index;
    }
    if (filename.startsWith(needle)) score += 30;
    else if (filename.includes(needle)) score += 15;
    return score - haystack.length / 100;
  }

  function loadFileIndex() {
    if (!fileIndexPromise) {
      fileIndexPromise = fetch("/__files", { cache: "no-store" }).then((response) => {
        if (!response.ok) throw new Error(`file index: ${response.status}`);
        return response.json();
      });
    }
    return fileIndexPromise;
  }

  function closeFilePicker() {
    filePicker?.remove();
    filePicker = null;
    pickerInput = null;
    pickerResults = null;
    pickerMatches = [];
  }

  function openFile(path) {
    location.assign("/" + path.split("/").map(encodeURIComponent).join("/"));
  }

  function setPickerSelection(index, reveal = false) {
    if (!pickerMatches.length) return;
    pickerSelection = (index + pickerMatches.length) % pickerMatches.length;
    const buttons = pickerResults?.querySelectorAll(".file-picker-result");
    buttons?.forEach((button, resultIndex) => {
      const selected = resultIndex === pickerSelection;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-selected", String(selected));
    });
    if (reveal) buttons?.[pickerSelection]?.scrollIntoView({ block: "nearest" });
  }

  function renderFileMatches() {
    if (!pickerResults || !pickerInput) return;
    const query = pickerInput.value.trim();
    pickerMatches = (filePicker.files || [])
      .map((path) => ({ path, score: fuzzyScore(path, query) }))
      .filter((match) => match.score !== null)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, 50);
    pickerSelection = Math.min(pickerSelection, Math.max(pickerMatches.length - 1, 0));

    pickerResults.replaceChildren();
    if (pickerMatches.length === 0) {
      const empty = document.createElement("li");
      empty.className = "file-picker-empty";
      empty.textContent = "No matching files";
      pickerResults.appendChild(empty);
      return;
    }
    pickerMatches.forEach((match, index) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "file-picker-result";
      button.classList.toggle("is-selected", index === pickerSelection);
      button.setAttribute("aria-selected", String(index === pickerSelection));
      button.textContent = match.path;
      button.addEventListener("mouseenter", () => {
        setPickerSelection(index);
      });
      button.addEventListener("click", () => openFile(match.path));
      item.appendChild(button);
      pickerResults.appendChild(item);
    });
  }

  async function showFilePicker() {
    if (filePicker) {
      pickerInput?.focus();
      return;
    }
    const overlay = document.createElement("div");
    overlay.className = "file-picker";
    overlay.innerHTML = '<div class="file-picker-dialog" role="dialog" aria-modal="true" aria-label="Open file"><input class="file-picker-input" type="search" placeholder="Search files…" autocomplete="off" spellcheck="false"><ul class="file-picker-results" role="listbox"></ul><p class="file-picker-hint"><kbd>↑</kbd><kbd>↓</kbd> to select <kbd>↵</kbd> to open <kbd>Esc</kbd> to close</p></div>';
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) closeFilePicker();
    });
    document.body.appendChild(overlay);
    filePicker = overlay;
    pickerInput = overlay.querySelector(".file-picker-input");
    pickerResults = overlay.querySelector(".file-picker-results");
    pickerInput.addEventListener("input", () => {
      pickerSelection = 0;
      renderFileMatches();
    });
    pickerInput.focus();
    try {
      const files = await loadFileIndex();
      if (filePicker !== overlay) return;
      filePicker.files = files;
      renderFileMatches();
    } catch (error) {
      console.error(error);
      if (filePicker === overlay && pickerResults) pickerResults.textContent = "Could not load files";
    }
  }

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
      fileIndexPromise = null;
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
  let explorerAutoHide = false;
  try { explorerAutoHide = localStorage.getItem("mdprev-explorer-auto-hide") === "true"; } catch (_) {}
  applyExplorerAutoHide(explorerAutoHide);
  themeToggle?.addEventListener("click", toggleTheme);
  explorerPin?.addEventListener("click", toggleExplorerAutoHide);
  document.addEventListener("keydown", (event) => {
    if (!filePicker) return;
    if (event.key === "Escape" || event.key === "Esc") {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeFilePicker();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopImmediatePropagation();
      setPickerSelection(pickerSelection + (event.key === "ArrowDown" ? 1 : -1), true);
    } else if (event.key === "Enter" && pickerMatches[pickerSelection]) {
      event.preventDefault();
      event.stopImmediatePropagation();
      openFile(pickerMatches[pickerSelection].path);
    }
  }, true);
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
      event.preventDefault();
      showFilePicker();
    }
  });
  renderMermaid();
  loadExplorer();
  connect();
  window.addEventListener("pagehide", disconnect);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) connect();
  });
})();
