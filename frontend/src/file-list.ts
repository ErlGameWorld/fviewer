import type { DirEntry } from "./ws";

export type ListRow = DirEntry & { path: string };

export type SortKey = "name" | "mtime" | "type" | "size";
export type SortDir = "asc" | "desc";

export type ColWidths = Record<SortKey, number>;

export type FileListOptions = {
  dir: string;
  entries: ListRow[];
  sortKey: SortKey;
  sortDir: SortDir;
  showHidden: boolean;
  activePath: string;
  onSort: (key: SortKey) => void;
  onOpenDir: (path: string) => void;
  onOpenFile: (path: string) => void;
};

const COLS: { key: SortKey; label: string }[] = [
  { key: "name", label: "名称" },
  { key: "mtime", label: "修改日期" },
  { key: "type", label: "类型" },
  { key: "size", label: "大小" },
];

const COL_WIDTHS_KEY = "fviewer.fileList.colWidths";
const COL_WIDTH_MIN = 48;
const DEFAULT_COL_WIDTHS: ColWidths = {
  name: 160,
  mtime: 148,
  type: 72,
  size: 64,
};

export function loadColWidths(): ColWidths {
  try {
    const raw = localStorage.getItem(COL_WIDTHS_KEY);
    if (!raw) return { ...DEFAULT_COL_WIDTHS };
    const parsed = JSON.parse(raw) as Partial<ColWidths>;
    return {
      name: clampColWidth(parsed.name ?? DEFAULT_COL_WIDTHS.name),
      mtime: clampColWidth(parsed.mtime ?? DEFAULT_COL_WIDTHS.mtime),
      type: clampColWidth(parsed.type ?? DEFAULT_COL_WIDTHS.type),
      size: clampColWidth(parsed.size ?? DEFAULT_COL_WIDTHS.size),
    };
  } catch {
    return { ...DEFAULT_COL_WIDTHS };
  }
}

function clampColWidth(n: number): number {
  if (!Number.isFinite(n)) return COL_WIDTH_MIN;
  return Math.max(COL_WIDTH_MIN, Math.round(n));
}

function saveColWidths(widths: ColWidths): void {
  localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(widths));
}

function applyColWidths(container: HTMLElement, widths: ColWidths): void {
  container.style.setProperty("--col-name-w", `${widths.name}px`);
  container.style.setProperty("--col-mtime-w", `${widths.mtime}px`);
  container.style.setProperty("--col-type-w", `${widths.type}px`);
  container.style.setProperty("--col-size-w", `${widths.size}px`);
}

export function rowsFromEntries(dir: string, entries: DirEntry[], joinPath: (d: string, n: string) => string): ListRow[] {
  return entries.map((e) => ({
    ...e,
    path: joinPath(dir, e.name),
  }));
}

export function sortRows(rows: ListRow[], sortKey: SortKey, sortDir: SortDir): ListRow[] {
  const mul = sortDir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case "name":
        cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        break;
      case "mtime":
        cmp = a.mtime - b.mtime;
        break;
      case "type":
        cmp = typeLabel(a).localeCompare(typeLabel(b), undefined, { sensitivity: "base" });
        break;
      case "size":
        cmp = a.size - b.size;
        break;
    }
    if (cmp === 0 && sortKey !== "name") {
      cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    }
    return cmp * mul;
  });
}

export function renderFileList(container: HTMLElement, opts: FileListOptions): void {
  const colWidths = loadColWidths();
  applyColWidths(container, colWidths);
  container.innerHTML = "";

  const head = document.createElement("div");
  head.className = "file-list-head";
  for (let i = 0; i < COLS.length; i++) {
    const col = COLS[i];
    const wrap = document.createElement("div");
    wrap.className = "file-list-col-wrap";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "file-list-col" + (opts.sortKey === col.key ? " sorted" : "");
    btn.dataset.col = col.key;
    const arrow = opts.sortKey === col.key ? (opts.sortDir === "asc" ? " ▲" : " ▼") : "";
    btn.textContent = col.label + arrow;
    btn.title = "点击排序";
    btn.addEventListener("click", () => opts.onSort(col.key));
    wrap.appendChild(btn);

    if (i < COLS.length - 1) {
      const resizer = document.createElement("span");
      resizer.className = "file-list-resizer";
      resizer.title = "拖动调整列宽";
      resizer.addEventListener("pointerdown", (ev) => {
        startColResize(ev, container, col.key, colWidths);
      });
      wrap.appendChild(resizer);
    }

    head.appendChild(wrap);
  }
  container.appendChild(head);

  const body = document.createElement("div");
  body.className = "file-list-body";

  let rows = opts.entries;
  if (!opts.showHidden) rows = rows.filter((r) => !r.hidden);
  rows = sortRows(rows, opts.sortKey, opts.sortDir);

  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "file-list-empty";
    empty.textContent = opts.showHidden ? "此目录为空" : "此目录为空（可点 👁 显示隐藏项）";
    body.appendChild(empty);
  } else {
    for (const row of rows) {
      body.appendChild(makeRow(row, opts));
    }
  }

  container.appendChild(body);
}

function startColResize(ev: PointerEvent, container: HTMLElement, colKey: SortKey, widths: ColWidths): void {
  ev.preventDefault();
  ev.stopPropagation();
  const target = ev.currentTarget as HTMLElement;
  const startX = ev.clientX;
  const startWidth = widths[colKey];

  target.setPointerCapture(ev.pointerId);
  document.body.classList.add("is-col-resizing");

  const onMove = (moveEv: PointerEvent) => {
    if (moveEv.pointerId !== ev.pointerId) return;
    const next = clampColWidth(startWidth + (moveEv.clientX - startX));
    if (next === widths[colKey]) return;
    widths[colKey] = next;
    applyColWidths(container, widths);
  };

  const onEnd = (endEv: PointerEvent) => {
    if (endEv.pointerId !== ev.pointerId) return;
    target.removeEventListener("pointermove", onMove);
    target.removeEventListener("pointerup", onEnd);
    target.removeEventListener("pointercancel", onEnd);
    document.body.classList.remove("is-col-resizing");
    try {
      target.releasePointerCapture(endEv.pointerId);
    } catch {
      /* ignore */
    }
    saveColWidths(widths);
  };

  target.addEventListener("pointermove", onMove);
  target.addEventListener("pointerup", onEnd);
  target.addEventListener("pointercancel", onEnd);
}

function makeRow(row: ListRow, opts: FileListOptions): HTMLElement {
  const el = document.createElement("div");
  el.className =
    "file-list-row" +
    (row.path === opts.activePath ? " active" : "") +
    (row.hidden ? " is-hidden-item" : "");
  el.dataset.path = row.path;

  const nameCell = document.createElement("span");
  nameCell.className = "col-name";
  const icon = document.createElement("span");
  icon.className = "icon";
  icon.textContent = row.type === "dir" ? "📁" : "📄";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = row.name;
  nameCell.append(icon, name);

  const dateCell = document.createElement("span");
  dateCell.className = "col-date";
  dateCell.textContent = formatMtime(row.mtime);

  const typeCell = document.createElement("span");
  typeCell.className = "col-type";
  typeCell.textContent = typeLabel(row);

  const sizeCell = document.createElement("span");
  sizeCell.className = "col-size";
  sizeCell.textContent = row.type === "dir" ? "" : formatSize(row.size);

  el.append(nameCell, dateCell, typeCell, sizeCell);

  if (row.type === "dir") {
    el.title = "双击进入文件夹";
    el.addEventListener("dblclick", () => opts.onOpenDir(row.path));
  } else {
    el.addEventListener("click", () => opts.onOpenFile(row.path));
  }

  return el;
}

function typeLabel(e: DirEntry): string {
  if (e.type === "dir") return "文件夹";
  const dot = e.name.lastIndexOf(".");
  if (dot > 0) return e.name.slice(dot + 1).toUpperCase() + " 文件";
  return "文件";
}

function formatMtime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
