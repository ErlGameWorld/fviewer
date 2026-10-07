export type LocalNode = {
  id: string;
  name: string;
  type: "dir" | "file";
  expanded: boolean;
  children: LocalNode[];
  file?: File;
};

export type ServerEntryNode = {
  path: string;
  name: string;
  type: "dir" | "file";
  size: number;
  expanded: boolean;
  loaded: boolean;
  children: ServerEntryNode[];
};

function relPath(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (rel) return rel.replace(/\\/g, "/");
  return file.name;
}

function splitRelPath(rel: string): string[] {
  return rel.replace(/\\/g, "/").split("/").filter((p) => p.length > 0);
}

function sortNodes<T extends { type: string; name: string }>(nodes: T[]): T[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function buildLocalTree(files: File[]): LocalNode[] {
  const roots: LocalNode[] = [];
  const dirIndex = new Map<string, LocalNode>();

  const ensureDir = (id: string, name: string, parentKids: LocalNode[]): LocalNode => {
    let node = dirIndex.get(id);
    if (!node) {
      node = { id, name, type: "dir", expanded: true, children: [] };
      dirIndex.set(id, node);
      parentKids.push(node);
    }
    return node;
  };

  for (const file of files) {
    const parts = splitRelPath(relPath(file));
    if (parts.length === 0) continue;
    let kids = roots;
    let prefix = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isFile = i === parts.length - 1;
      prefix = prefix ? `${prefix}/${part}` : part;
      if (isFile) {
        const existing = kids.find((k) => k.id === prefix);
        if (existing) {
          existing.type = "file";
          existing.file = file;
        } else {
          kids.push({
            id: prefix,
            name: part,
            type: "file",
            expanded: false,
            children: [],
            file,
          });
        }
      } else {
        const dir = ensureDir(prefix, part, kids);
        kids = dir.children;
      }
    }
  }

  const sortTree = (nodes: LocalNode[]): void => {
    sortNodes(nodes);
    for (const n of nodes) {
      if (n.type === "dir") sortTree(n.children);
    }
  };
  sortTree(roots);
  return roots;
}

export function mergeLocalTrees(existing: LocalNode[], files: File[]): LocalNode[] {
  const merged = new Map<string, File>();
  const walk = (nodes: LocalNode[]) => {
    for (const n of nodes) {
      if (n.type === "file" && n.file) merged.set(n.id, n.file);
      walk(n.children);
    }
  };
  walk(existing);
  for (const f of files) merged.set(relPath(f), f);
  return buildLocalTree([...merged.values()]);
}


export function flattenLocalFiles(nodes: LocalNode[]): LocalNode[] {
  const out: LocalNode[] = [];
  const walk = (list: LocalNode[]) => {
    for (const n of list) {
      if (n.type === "file" && n.file) out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export function collectSelectedFiles(nodes: LocalNode[], selected: Set<string>): File[] {
  const out: File[] = [];
  const walk = (list: LocalNode[]) => {
    for (const n of list) {
      if (n.type === "file" && n.file && selected.has(n.id)) out.push(n.file);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export function renderLocalTree(
  container: HTMLElement,
  nodes: LocalNode[],
  selected: Set<string>,
  opts: {
    onToggleDir: (node: LocalNode) => void;
    onSelectFile: (node: LocalNode, ev: MouseEvent) => void;
  },
): void {
  container.innerHTML = "";
  if (nodes.length === 0) {
    container.innerHTML = `<div class="upload-tree-empty">点击「选择文件夹」或「添加文件」<br/>支持任意格式</div>`;
    return;
  }
  for (const node of nodes) {
    container.appendChild(renderLocalNode(node, selected, opts));
  }
}

function renderLocalNode(
  node: LocalNode,
  selected: Set<string>,
  opts: {
    onToggleDir: (node: LocalNode) => void;
    onSelectFile: (node: LocalNode, ev: MouseEvent) => void;
  },
): HTMLElement {
  const wrap = document.createElement("div");
  const row = document.createElement("div");
  const isDir = node.type === "dir";
  const isSelected = !isDir && selected.has(node.id);
  row.className = "upload-tree-item" + (isSelected ? " selected" : "");

  if (isDir) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "upload-tree-toggle";
    toggle.textContent = node.expanded ? "▾" : "▸";
    toggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      opts.onToggleDir(node);
    });
    row.appendChild(toggle);
    row.addEventListener("click", () => opts.onToggleDir(node));
  } else {
    const spacer = document.createElement("span");
    spacer.className = "upload-tree-spacer";
    row.appendChild(spacer);
  }

  const icon = document.createElement("span");
  icon.className = "icon";
  icon.textContent = isDir ? "📁" : "📄";

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = node.name || node.id;

  row.append(icon, name);
  if (!isDir && node.file) {
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = formatSize(node.file.size);
    row.appendChild(size);
    row.addEventListener("click", (ev) => opts.onSelectFile(node, ev));
  }

  wrap.appendChild(row);
  if (isDir && node.expanded) {
    const kids = document.createElement("div");
    kids.className = "upload-tree-children";
    for (const child of node.children) {
      kids.appendChild(renderLocalNode(child, selected, opts));
    }
    wrap.appendChild(kids);
  }
  return wrap;
}

export function renderServerDirTree(
  container: HTMLElement,
  nodes: ServerEntryNode[],
  targetDir: string,
  opts: {
    onToggleDir: (node: ServerEntryNode) => void | Promise<void>;
    onSelectDir: (node: ServerEntryNode) => void;
  },
): void {
  container.innerHTML = "";
  if (nodes.length === 0) {
    container.innerHTML = `<div class="upload-tree-empty">无可用目录</div>`;
    return;
  }
  for (const node of nodes) {
    container.appendChild(renderServerNode(node, targetDir, opts));
  }
}

function renderServerNode(
  node: ServerEntryNode,
  targetDir: string,
  opts: {
    onToggleDir: (node: ServerEntryNode) => void | Promise<void>;
    onSelectDir: (node: ServerEntryNode) => void;
  },
): HTMLElement {
  const wrap = document.createElement("div");
  const row = document.createElement("div");
  const isDir = node.type === "dir";
  row.className =
    "upload-tree-item" +
    (isDir && node.path === targetDir ? " selected" : "") +
    (isDir ? "" : " file-entry");

  if (isDir) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "upload-tree-toggle";
    toggle.textContent = node.expanded ? "▾" : "▸";
    toggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void opts.onToggleDir(node);
    });
    row.appendChild(toggle);
    row.addEventListener("click", () => opts.onSelectDir(node));
  } else {
    const spacer = document.createElement("span");
    spacer.className = "upload-tree-spacer";
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = "📄";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = node.name;
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = formatSize(node.size);
    row.append(spacer, icon, name, size);
    wrap.appendChild(row);
    return wrap;
  }

  const icon = document.createElement("span");
  icon.className = "icon";
  icon.textContent = "📁";

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = node.name;

  row.append(icon, name);
  wrap.appendChild(row);

  if (isDir && node.expanded) {
    const kids = document.createElement("div");
    kids.className = "upload-tree-children";
    for (const child of node.children) {
      kids.appendChild(renderServerNode(child, targetDir, opts));
    }
    wrap.appendChild(kids);
  }
  return wrap;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
