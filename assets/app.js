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
  let mermaidViewer = null;
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

  function closeMermaidViewer() {
    mermaidViewer?.close();
  }

  function openMermaidViewer(node, trigger) {
    closeMermaidViewer();
    const svg = node.querySelector("svg");
    if (!svg) return;

    const modal = document.createElement("div");
    modal.className = "mermaid-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Diagram viewer");
    const stage = document.createElement("div");
    stage.className = "mermaid-modal-stage";
    const canvas = document.createElement("div");
    canvas.className = "mermaid-modal-canvas";
    const toolbar = document.createElement("div");
    toolbar.className = "mermaid-modal-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Diagram controls");
    const status = document.createElement("span");
    status.className = "mermaid-modal-status";
    status.setAttribute("aria-live", "polite");

    const button = (label, text, action) => {
      const control = document.createElement("button");
      control.type = "button";
      control.className = "mermaid-modal-button";
      control.setAttribute("aria-label", label);
      control.title = label;
      control.textContent = text;
      control.addEventListener("click", action);
      return control;
    };

    const originalStyle = {
      width: svg.style.width,
      height: svg.style.height,
      maxWidth: svg.style.maxWidth,
      transform: svg.style.transform,
      transformOrigin: svg.style.transformOrigin,
    };
    const viewBox = svg.viewBox?.baseVal;
    const rendered = svg.getBoundingClientRect();
    const naturalWidth = viewBox?.width || rendered.width;
    const naturalHeight = viewBox?.height || rendered.height;
    let zoom = 1;
    let panX = 0;
    let panY = 0;
    let drag = null;

    const draw = () => {
      canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
      status.textContent = `${Math.round(zoom * 100)}%`;
      zoomOut.disabled = zoom <= 0.1;
      zoomIn.disabled = zoom >= 5;
    };
    const centerAt = (nextZoom, clientX, clientY) => {
      const rect = stage.getBoundingClientRect();
      const pointX = clientX - rect.left;
      const pointY = clientY - rect.top;
      const worldX = (pointX - panX) / zoom;
      const worldY = (pointY - panY) / zoom;
      zoom = Math.min(5, Math.max(0.1, nextZoom));
      panX = pointX - worldX * zoom;
      panY = pointY - worldY * zoom;
      draw();
    };
    const zoomAtCenter = (factor) => {
      const rect = stage.getBoundingClientRect();
      centerAt(zoom * factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
    };
    const fit = () => {
      const rect = stage.getBoundingClientRect();
      zoom = Math.max(0.1, Math.min((rect.width - 64) / naturalWidth, (rect.height - 64) / naturalHeight, 1));
      panX = (rect.width - naturalWidth * zoom) / 2;
      panY = (rect.height - naturalHeight * zoom) / 2;
      draw();
    };

    const zoomOut = button("Zoom out", "−", () => zoomAtCenter(0.8));
    const fitButton = button("Fit diagram to screen", "Fit", fit);
    const zoomIn = button("Zoom in", "+", () => zoomAtCenter(1.25));
    const closeButton = button("Close diagram viewer", "×", closeMermaidViewer);
    closeButton.classList.add("mermaid-modal-close");
    const onResize = () => fit();
    const onKeyDown = (event) => {
      if (event.key === "Escape" || event.key === "Esc") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeMermaidViewer();
      }
    };

    const close = () => {
      if (mermaidViewer?.modal !== modal) return;
      window.removeEventListener("resize", onResize);
      document.removeEventListener("keydown", onKeyDown, true);
      Object.assign(svg.style, originalStyle);
      node.appendChild(svg);
      modal.remove();
      document.body.classList.remove("mermaid-modal-open");
      mermaidViewer = null;
      if (trigger.isConnected) trigger.focus();
    };
    mermaidViewer = { modal, close };

    toolbar.append(zoomOut, status, fitButton, zoomIn, closeButton);
    canvas.appendChild(svg);
    stage.appendChild(canvas);
    modal.append(stage, toolbar);
    document.body.appendChild(modal);
    document.body.classList.add("mermaid-modal-open");
    canvas.style.width = `${naturalWidth}px`;
    canvas.style.height = `${naturalHeight}px`;
    svg.style.width = `${naturalWidth}px`;
    svg.style.height = `${naturalHeight}px`;
    svg.style.maxWidth = "none";
    svg.style.transform = "none";
    fit();
    window.addEventListener("resize", onResize);
    document.addEventListener("keydown", onKeyDown, true);
    closeButton.focus();

    stage.addEventListener("wheel", (event) => {
      event.preventDefault();
      centerAt(zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), event.clientX, event.clientY);
    }, { passive: false });
    stage.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, panX, panY };
      stage.setPointerCapture(event.pointerId);
      stage.classList.add("is-dragging");
    });
    stage.addEventListener("pointermove", (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      panX = drag.panX + event.clientX - drag.x;
      panY = drag.panY + event.clientY - drag.y;
      draw();
    });
    const stopDragging = (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      drag = null;
      stage.classList.remove("is-dragging");
    };
    stage.addEventListener("pointerup", stopDragging);
    stage.addEventListener("pointercancel", stopDragging);
    modal.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Tab") {
        const controls = Array.from(toolbar.querySelectorAll("button:not(:disabled)"));
        const current = controls.indexOf(document.activeElement);
        const next = event.shiftKey ? current - 1 : current + 1;
        if (current === -1 || next < 0 || next >= controls.length) {
          event.preventDefault();
          controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
        }
      }
    });
  }

  function enhanceMermaid(node) {
    if (!node.isConnected || node.closest(".mermaid-viewer")) return;
    const viewer = document.createElement("div");
    viewer.className = "mermaid-viewer";
    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "mermaid-expand";
    expand.setAttribute("aria-label", "Open diagram viewer");
    expand.title = "Open diagram viewer";
    expand.textContent = "⛶";
    expand.addEventListener("click", () => openMermaidViewer(node, expand));
    node.before(viewer);
    viewer.append(node, expand);
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
        window.mermaid
          .run({ nodes: visible })
          .then(() => visible.forEach(enhanceMermaid))
          .catch((e) => console.error("mermaid:", e));
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
        closeMermaidViewer();
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
