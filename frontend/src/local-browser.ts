type DirEntry = {
  name: string;
  kind: "file" | "directory";
  size: number;
  relPath: string;
  handle?: FileSystemHandle;
  file?: File;
};

type BrowserState = {
  /** webkitdirectory 选中的全部文件 */
  allFiles: File[];
  /** 当前浏览路径，如 ["eLfq", "src"] */
  pathCrumbs: string[];
  selectedFiles: Map<string, File>;
  selectedDirs: Set<string>;
  viewEntries: DirEntry[];
};

export type EmbeddedLocalBrowser = {
  reset: () => void;
  browseFolder: () => Promise<void>;
  browseFiles: () => Promise<void>;
  goUp: () => void;
  selectAllInView: () => void;
  resolveSelectedFiles: () => Promise<File[]>;
  selectionSummary: () => string;
};

export type LocalBrowserElements = {
  listEl: HTMLElement;
  pathEl: HTMLElement;
  summaryEl: HTMLElement;
  btnUp: HTMLButtonElement | null;
  folderInput: HTMLInputElement;
  fileInput: HTMLInputElement;
  onSelectionChange?: () => void;
};

export function createEmbeddedLocalBrowser(els: LocalBrowserElements): EmbeddedLocalBrowser {
  const state: BrowserState = {
    allFiles: [],
    pathCrumbs: [],
    selectedFiles: new Map(),
    selectedDirs: new Set(),
    viewEntries: [],
  };

  const notify = () => els.onSelectionChange?.();

  const updateSummary = () => {
    els.summaryEl.textContent = selectionSummary(state);
    notify();
  };

  const currentPrefix = (): string => state.pathCrumbs.join("/");

  const render = () => {
    if (els.btnUp) els.btnUp.disabled = state.pathCrumbs.length <= 1;
    if (state.allFiles.length === 0) {
      els.pathEl.textContent = "（未选择文件或文件夹）";
      renderEmpty(els.listEl);
      state.viewEntries = [];
      updateSummary();
      return;
    }
    els.pathEl.textContent = currentPrefix() || "所选文件";
    state.viewEntries = listFromWebkitFiles(state.allFiles, currentPrefix());
    renderListingSync(state, els.listEl, updateSummary, render);
  };

  const browseFolder = async () => {
    const files = await pickFiles(els.folderInput);
    if (files.length === 0) return;
    state.allFiles = files;
    state.pathCrumbs = [inferRootName(files)];
    state.selectedFiles.clear();
    state.selectedDirs.clear();
    render();
  };

  const browseFiles = async () => {
    const files = await pickFiles(els.fileInput);
    if (files.length === 0) return;
    state.allFiles = files;
    state.pathCrumbs = [""];
    state.selectedFiles.clear();
    state.selectedDirs.clear();
    for (const file of files) state.selectedFiles.set(file.name, file);
    render();
  };

  const goUp = () => {
    if (state.pathCrumbs.length > 1) {
      state.pathCrumbs.pop();
      render();
    }
  };

  const selectAllInView = () => {
    for (const entry of state.viewEntries) {
      if (entry.kind === "directory") state.selectedDirs.add(entry.relPath);
      else if (entry.file) state.selectedFiles.set(entry.relPath, entry.file);
    }
    renderListingSync(state, els.listEl, updateSummary, render);
    updateSummary();
  };

  const reset = () => {
    state.allFiles = [];
    state.pathCrumbs = [];
    state.selectedFiles.clear();
    state.selectedDirs.clear();
    state.viewEntries = [];
    render();
  };

  const resolveSelectedFiles = async (): Promise<File[]> => {
    if (state.selectedFiles.size === 0 && state.selectedDirs.size === 0) return [];
    const out = new Map<string, File>(state.selectedFiles);
    for (const dirRel of state.selectedDirs) {
      for (const file of filesUnderDir(state.allFiles, dirRel)) {
        out.set(relPath(file), file);
      }
    }
    return [...out.values()];
  };

  els.listEl.addEventListener("dragover", (ev) => ev.preventDefault());
  els.listEl.addEventListener("drop", (ev) => {
    ev.preventDefault();
    void handleDrop(ev, state, () => {
      render();
      updateSummary();
    });
  });

  return {
    reset,
    browseFolder,
    browseFiles,
    goUp,
    selectAllInView,
    resolveSelectedFiles,
    selectionSummary: () => selectionSummary(state),
  };
}

function selectionSummary(state: BrowserState): string {
  const fc = state.selectedFiles.size;
  const dc = state.selectedDirs.size;
  if (fc === 0 && dc === 0) return "勾选要上传的文件或文件夹";
  return `已选 ${fc} 个文件、${dc} 个文件夹`;
}

function renderEmpty(listHost: HTMLElement): void {
  listHost.innerHTML = `
    <div class="upload-tree-empty">
      点击上方「选择文件夹」或「选择文件」<br/>
      列表中会同时显示<strong>文件和文件夹</strong>，单击文件夹名进入
    </div>
  `;
  listHost.onclick = null;
}

function renderListingSync(
  state: BrowserState,
  listHost: HTMLElement,
  updateSummary: () => void,
  rerender: () => void,
): void {
  listHost.innerHTML = "";
  listHost.onclick = null;

  if (state.pathCrumbs.length > 1) {
    listHost.appendChild(
      makeNavRow("..", () => {
        state.pathCrumbs.pop();
        rerender();
      }),
    );
  }

  if (state.viewEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "upload-tree-empty";
    empty.textContent = "此文件夹为空";
    listHost.appendChild(empty);
    updateSummary();
    return;
  }

  for (const entry of state.viewEntries) {
    listHost.appendChild(
      makeSelectableRow(entry, state, updateSummary, () => {
        if (entry.kind === "directory") {
          state.pathCrumbs.push(entry.name);
          rerender();
        }
      }),
    );
  }
  updateSummary();
}

function makeNavRow(label: string, onEnter: () => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "upload-tree-item folder-picker-dir";
  row.innerHTML = `<span class="local-browser-check-spacer"></span><span class="icon">📁</span><span class="name">${label}</span>`;
  row.title = "返回上级";
  row.addEventListener("click", onEnter);
  return row;
}

function makeSelectableRow(
  entry: DirEntry,
  state: BrowserState,
  updateSummary: () => void,
  onEnterDir: (() => void) | null,
): HTMLElement {
  const row = document.createElement("div");
  const isDir = entry.kind === "directory";
  const checked = isDir
    ? state.selectedDirs.has(entry.relPath)
    : state.selectedFiles.has(entry.relPath);

  row.className =
    "upload-tree-item local-browser-row" + (checked ? " selected" : "") + (isDir ? " folder-picker-dir" : "");

  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "local-browser-check";
  check.checked = checked;
  check.title = isDir ? "勾选上传整个文件夹" : "勾选上传此文件";
  check.addEventListener("click", (ev) => ev.stopPropagation());
  check.addEventListener("change", () => {
    if (isDir) {
      if (check.checked) state.selectedDirs.add(entry.relPath);
      else state.selectedDirs.delete(entry.relPath);
    } else if (entry.file) {
      if (check.checked) state.selectedFiles.set(entry.relPath, entry.file);
      else state.selectedFiles.delete(entry.relPath);
    }
    row.classList.toggle("selected", check.checked);
    updateSummary();
  });

  const icon = document.createElement("span");
  icon.className = "icon";
  icon.textContent = isDir ? "📁" : "📄";

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = entry.name;
  if (isDir) {
    name.title = "单击进入";
    name.addEventListener("click", (ev) => {
      ev.stopPropagation();
      onEnterDir?.();
    });
  }

  row.append(check, icon, name);

  if (!isDir) {
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = formatSize(entry.size);
    row.appendChild(size);
    row.addEventListener("click", (ev) => {
      if (ev.target === check || ev.target === name) return;
      check.checked = !check.checked;
      check.dispatchEvent(new Event("change"));
    });
  } else {
    row.addEventListener("click", (ev) => {
      if (ev.target === check) return;
      if (ev.target === name) return;
      onEnterDir?.();
    });
  }

  return row;
}

/** 从 webkitdirectory 文件列表列出当前目录下的直接子项 */
function listFromWebkitFiles(files: File[], prefix: string): DirEntry[] {
  const dirNames = new Set<string>();
  const fileEntries: DirEntry[] = [];
  const prefixSlash = prefix ? prefix + "/" : "";

  for (const file of files) {
    const rel = relPath(file);
    if (prefix) {
      if (rel === prefix) continue;
      if (!rel.startsWith(prefixSlash)) continue;
    }
    const rest = prefix ? rel.slice(prefixSlash.length) : rel;
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash >= 0) {
      dirNames.add(rest.slice(0, slash));
    } else {
      fileEntries.push({
        name: rest,
        kind: "file",
        size: file.size,
        relPath: prefix ? `${prefix}/${rest}` : rest,
        file,
      });
    }
  }

  const dirEntries: DirEntry[] = [...dirNames].sort().map((name) => ({
    name,
    kind: "directory" as const,
    size: 0,
    relPath: prefix ? `${prefix}/${name}` : name,
  }));

  dirEntries.sort((a, b) => a.name.localeCompare(b.name));
  fileEntries.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirEntries, ...fileEntries];
}

function filesUnderDir(files: File[], dirRel: string): File[] {
  const prefix = dirRel + "/";
  return files.filter((f) => {
    const rel = relPath(f);
    return rel.startsWith(prefix);
  });
}

async function handleDrop(ev: DragEvent, state: BrowserState, onUpdate: () => void): Promise<void> {
  const items = ev.dataTransfer?.items;
  if (!items) return;

  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    const handle = await item.getAsFileSystemHandle?.();
    if (handle?.kind === "directory") {
      state.selectedDirs.add(handle.name);
    } else {
      state.selectedFiles.set(file.name, file);
      if (state.allFiles.length === 0) {
        state.allFiles = [file];
        state.pathCrumbs = ["拖入文件"];
      } else {
        state.allFiles.push(file);
      }
    }
  }
  onUpdate();
}

function inferRootName(files: File[]): string {
  const first = files[0];
  if (!first) return "所选目录";
  const rel = relPath(first);
  const slash = rel.indexOf("/");
  if (slash > 0) return rel.slice(0, slash);
  return "所选目录";
}

function pickFiles(input: HTMLInputElement): Promise<File[]> {
  return new Promise((resolve) => {
    input.onchange = () => {
      const files = [...(input.files ?? [])];
      input.value = "";
      resolve(files);
    };
    input.click();
  });
}

function relPath(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (rel) return rel.replace(/\\/g, "/");
  return file.name;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
