import "./styles.css";
import {
  base64ToArrayBuffer,
  detectPreview,
  DocPane,
  mimeForImage,
} from "./docs";
import { createEmbeddedLocalBrowser, type EmbeddedLocalBrowser } from "./local-browser";
import { CodePane } from "./editor";
import { SheetPane } from "./sheet";
import { DirEntry, FviewerSocket, ServerMsg } from "./ws";
import {
  renderFileList,
  rowsFromEntries,
  type ListRow,
  type SortDir,
  type SortKey,
} from "./file-list";
import {
  renderServerDirTree,
  type ServerEntryNode,
} from "./upload";

const SIDEBAR_MIN = 360;
const FILE_LIST_SORT_KEY = "fviewer.fileList.sortKey";
const FILE_LIST_SORT_DIR = "fviewer.fileList.sortDir";
const FILE_LIST_SHOW_HIDDEN = "fviewer.fileList.showHidden";
const SIDEBAR_MAX = 640;
const SIDEBAR_DEFAULT = 420;
const SIDEBAR_STORAGE_KEY = "fviewer.sidebarWidth";
const SIDEBAR_ZOOM_KEY = "fviewer.sidebarZoom";
const SIDEBAR_ZOOM_MIN = 0.85;
const SIDEBAR_ZOOM_MAX = 1.75;
const SIDEBAR_ZOOM_DEFAULT = 1;
const SIDEBAR_ZOOM_STEP = 0.05;

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes("\\") ? "\\" : "/";
  if (dir.endsWith("/") || dir.endsWith("\\")) return dir + name;
  return dir + sep + name;
}

function normPath(p: string): string {
  return p.replace(/[/\\]+$/, "").toLowerCase();
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function downloadServerFile(msg: { path: string; encoding: string; content: string }): void {
  const name = basename(msg.path);
  const blob =
    msg.encoding === "base64"
      ? new Blob([base64ToArrayBuffer(msg.content)])
      : new Blob([msg.content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function toast(msg: string): void {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  window.setTimeout(() => el.classList.remove("show"), 1800);
}

function loadSidebarWidth(): number {
  const raw = localStorage.getItem(SIDEBAR_STORAGE_KEY);
  const n = raw ? Number(raw) : SIDEBAR_DEFAULT;
  if (!Number.isFinite(n)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n));
}

function loadSortKey(): SortKey {
  const v = localStorage.getItem(FILE_LIST_SORT_KEY);
  if (v === "name" || v === "mtime" || v === "type" || v === "size") return v;
  return "name";
}

function loadSortDir(): SortDir {
  const v = localStorage.getItem(FILE_LIST_SORT_DIR);
  return v === "desc" ? "desc" : "asc";
}

function loadShowHidden(): boolean {
  return localStorage.getItem(FILE_LIST_SHOW_HIDDEN) === "1";
}

function loadSidebarZoom(): number {
  const n = Number(localStorage.getItem(SIDEBAR_ZOOM_KEY));
  if (!Number.isFinite(n)) return SIDEBAR_ZOOM_DEFAULT;
  return Math.min(SIDEBAR_ZOOM_MAX, Math.max(SIDEBAR_ZOOM_MIN, Math.round(n * 100) / 100));
}

function formatSidebarZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

const app = document.getElementById("app");
if (!app) throw new Error("#app missing");

app.innerHTML = `
  <div class="layout">
    <aside class="sidebar" id="sidebar">
      <div class="topbar">
        <span class="status-dot" id="statusDot"></span>
        <span class="brand">文件浏览器</span>
        <span class="topbar-spacer"></span>
        <div class="sidebar-zoom" title="Ctrl + 滚轮缩放">
          <button type="button" id="btnSidebarZoomOut" title="缩小">−</button>
          <span class="sidebar-zoom-label" id="sidebarZoomLabel">100%</span>
          <button type="button" id="btnSidebarZoomIn" title="放大">+</button>
        </div>
      </div>
      <div class="path-bar">
        <button id="btnUp" title="返回上级">⬆ 上级</button>
        <button id="btnRefresh" title="刷新">↻</button>
        <button type="button" id="btnToggleHidden" class="path-tog" title="显示隐藏的项目" aria-pressed="false">👁</button>
        <select id="pathSelect" title="选择路径 / 盘符"></select>
      </div>
      <div class="file-list" id="tree"></div>
    </aside>
    <div class="splitter" id="splitter" title="拖动调整宽度">
      <button type="button" id="btnFoldSidebar" class="splitter-toggle" title="折叠左侧目录">◂</button>
    </div>
    <section class="editor-pane">
      <div class="toolbar">
        <div class="file-title" id="fileTitle">未打开文件</div>
        <span class="meta" id="fileMeta"></span>
        <div class="search-inline" id="searchBar">
          <input id="findInput" type="search" placeholder="搜索" spellcheck="false" />
          <div class="idea-search">
            <button type="button" class="idea-tog" id="optCase" title="区分大小写 (Match Case)" aria-pressed="false">Cc</button>
            <button type="button" class="idea-tog" id="optWord" title="全词匹配 (Words)" aria-pressed="false">W</button>
            <button type="button" class="idea-tog" id="optRegexp" title="正则表达式 (Regex)" aria-pressed="false">.*</button>
            <span class="idea-sep" aria-hidden="true"></span>
            <span class="idea-results empty" id="matchCount"><span class="idea-results-label">0 results</span></span>
            <button type="button" class="idea-nav" id="btnFindPrev" title="上一个">↑</button>
            <button type="button" class="idea-nav" id="btnFindNext" title="下一个">↓</button>
            <button type="button" class="idea-nav" id="btnFindList" title="查看全部匹配">☰</button>
          </div>
          <div class="search-popup hidden" id="searchPopup">
            <div class="search-popup-head">
              <span id="searchPopupTitle">搜索结果</span>
              <button type="button" id="btnClosePopup" title="关闭">×</button>
            </div>
            <div class="search-popup-list" id="searchPopupList"></div>
          </div>
        </div>
        <div class="zoom-group" title="缩放字体">
          <button type="button" id="btnZoomOut" title="缩小">−</button>
          <span class="zoom-label" id="zoomLabel">24px</span>
          <button type="button" id="btnZoomIn" title="放大">+</button>
        </div>
        <label class="wrap-toggle" title="自动换行（关闭后超长行横向滚动，极长内容可能显示不全）">
          <input type="checkbox" id="optWrap" checked />
          换行
        </label>
        <button id="btnDownload" title="下载当前文件" disabled>下载</button>
        <button id="btnUpload" title="上传文件到服务器目录">上传</button>
        <button id="btnCopy">复制</button>
      </div>
      <div class="viewer-stack">
        <div class="viewer-edit-actions hidden" id="viewerEditActions">
          <button type="button" id="btnEdit" title="编辑当前文本文件" disabled>编辑</button>
          <button type="button" id="btnSave" class="hidden" title="保存修改" disabled>保存</button>
        </div>
        <div id="editor"></div>
        <div id="sheet" class="sheet-pane hidden"></div>
        <div id="doc" class="doc-pane hidden"></div>
      </div>
    </section>
  </div>
  <div class="toast" id="toast"></div>
  <div class="confirm-modal hidden" id="editConfirmModal">
    <div class="confirm-dialog" role="dialog" aria-labelledby="editConfirmTitle">
      <div class="confirm-head" id="editConfirmTitle">有未保存的修改</div>
      <div class="confirm-body" id="editConfirmBody">是否保存后再退出编辑？</div>
      <div class="confirm-foot">
        <button type="button" id="btnConfirmDiscard">放弃修改</button>
        <button type="button" id="btnConfirmCancel">继续编辑</button>
        <button type="button" id="btnConfirmSave" class="primary">保存</button>
      </div>
    </div>
  </div>
  <div class="transfer-modal hidden" id="uploadModal">
    <div class="transfer-dialog" role="dialog" aria-labelledby="uploadModalTitle">
      <div class="transfer-head">
        <span id="uploadModalTitle">上传文件</span>
        <button type="button" id="btnCloseUpload" title="关闭">×</button>
      </div>
      <div class="transfer-body">
        <div class="upload-split">
          <div class="upload-panel">
            <div class="upload-panel-head">
              <span>本地文件</span>
              <div class="upload-panel-actions">
                <button type="button" id="btnPickLocalFolder" class="primary" title="选择文件夹">选择文件夹</button>
                <button type="button" id="btnPickLocalFiles" title="选择一个或多个文件">选择文件</button>
                <button type="button" id="btnLocalUp" title="上级目录">↑ 上级</button>
                <button type="button" id="btnSelectAllLocal" title="全选当前列表">全选</button>
              </div>
            </div>
            <div class="upload-local-path" id="uploadLocalPath">（未选择文件或文件夹）</div>
            <div class="upload-local-summary" id="uploadLocalSummary">勾选要上传的文件或文件夹</div>
            <div class="upload-local-tree" id="uploadLocalTree"></div>
            <input type="file" id="uploadFolderInput" class="hidden-input" webkitdirectory multiple />
            <input type="file" id="uploadFilesInput" class="hidden-input" multiple accept="*/*" />
          </div>
          <div class="upload-panel">
            <div class="upload-panel-head">
              <span>目标目录（服务器）</span>
            </div>
            <div class="upload-dir-path" id="uploadDirPath"></div>
            <div class="upload-dir-tree" id="uploadDirTree"></div>
            <p class="transfer-hint">同名文件将被覆盖；与左侧主目录树独立</p>
          </div>
        </div>
        <div class="upload-progress hidden" id="uploadProgress">
          <div class="upload-progress-track">
            <div class="upload-progress-fill" id="uploadProgressFill"></div>
          </div>
          <div class="upload-progress-text" id="uploadProgressText"></div>
        </div>
      </div>
      <div class="transfer-foot">
        <button type="button" id="btnUploadCancel">取消</button>
        <button type="button" id="btnUploadConfirm" class="primary">上传</button>
      </div>
    </div>
  </div>
`;

const treeEl = document.getElementById("tree") as HTMLElement;
const pathSelect = document.getElementById("pathSelect") as HTMLSelectElement;
const statusDot = document.getElementById("statusDot") as HTMLElement;
const fileTitle = document.getElementById("fileTitle") as HTMLElement;
const fileMeta = document.getElementById("fileMeta") as HTMLElement;
const editorHost = document.getElementById("editor") as HTMLElement;
const sheetHost = document.getElementById("sheet") as HTMLElement;
const docHost = document.getElementById("doc") as HTMLElement;
const searchBar = document.getElementById("searchBar") as HTMLElement;
const sidebar = document.getElementById("sidebar") as HTMLElement;
const sidebarZoomLabel = document.getElementById("sidebarZoomLabel") as HTMLElement;
const splitter = document.getElementById("splitter") as HTMLElement;
const layout = app.querySelector(".layout") as HTMLElement;
const findInput = document.getElementById("findInput") as HTMLInputElement;
const optCase = document.getElementById("optCase") as HTMLButtonElement;
const optRegexp = document.getElementById("optRegexp") as HTMLButtonElement;
const optWord = document.getElementById("optWord") as HTMLButtonElement;
const zoomLabel = document.getElementById("zoomLabel") as HTMLElement;
const optWrap = document.getElementById("optWrap") as HTMLInputElement;
const matchCount = document.getElementById("matchCount") as HTMLElement;
const btnFoldSidebar = document.getElementById("btnFoldSidebar") as HTMLButtonElement;
const btnToggleHidden = document.getElementById("btnToggleHidden") as HTMLButtonElement;
const searchPopup = document.getElementById("searchPopup") as HTMLElement;
const searchPopupList = document.getElementById("searchPopupList") as HTMLElement;
const searchPopupTitle = document.getElementById("searchPopupTitle") as HTMLElement;
const btnDownload = document.getElementById("btnDownload") as HTMLButtonElement;
const btnUpload = document.getElementById("btnUpload") as HTMLButtonElement;
const btnEdit = document.getElementById("btnEdit") as HTMLButtonElement;
const btnSave = document.getElementById("btnSave") as HTMLButtonElement;
const viewerEditActions = document.getElementById("viewerEditActions") as HTMLElement;
const btnUploadConfirm = document.getElementById("btnUploadConfirm") as HTMLButtonElement;
const uploadModal = document.getElementById("uploadModal") as HTMLElement;
const editConfirmModal = document.getElementById("editConfirmModal") as HTMLElement;
const editConfirmBody = document.getElementById("editConfirmBody") as HTMLElement;
const uploadDirPath = document.getElementById("uploadDirPath") as HTMLElement;
const uploadDirTree = document.getElementById("uploadDirTree") as HTMLElement;
const uploadLocalTree = document.getElementById("uploadLocalTree") as HTMLElement;
const uploadLocalPath = document.getElementById("uploadLocalPath") as HTMLElement;
const uploadLocalSummary = document.getElementById("uploadLocalSummary") as HTMLElement;
const uploadFolderInput = document.getElementById("uploadFolderInput") as HTMLInputElement;
const uploadFilesInput = document.getElementById("uploadFilesInput") as HTMLInputElement;
const btnLocalUp = document.getElementById("btnLocalUp") as HTMLButtonElement;
const uploadProgress = document.getElementById("uploadProgress") as HTMLElement;
const uploadProgressFill = document.getElementById("uploadProgressFill") as HTMLElement;
const uploadProgressText = document.getElementById("uploadProgressText") as HTMLElement;

const sheet = new SheetPane(sheetHost);
const doc = new DocPane(docHost);
const code = new CodePane(editorHost, {
  onFontChange: (size) => {
    zoomLabel.textContent = `${size}px`;
    sheet.setFontSize(size);
    doc.setFontSize(size);
  },
  onFocusSearch: () => {
    findInput.focus();
    findInput.select();
  },
  onDirtyChange: () => syncEditUi(),
});
zoomLabel.textContent = `${code.getFontSize()}px`;
optWrap.checked = code.getLineWrap();
sheet.setFontSize(code.getFontSize());
doc.setFontSize(code.getFontSize());

optWrap.addEventListener("change", () => {
  code.setLineWrap(optWrap.checked);
});

type ViewMode = "text" | "sheet" | "doc";
let viewMode: ViewMode = "text";
let editing = false;
let saveBusy = false;
let editWriteWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
type EditConfirmChoice = "save" | "discard" | "cancel";
let editConfirmWaiter: ((choice: EditConfirmChoice) => void) | null = null;

function showMode(mode: ViewMode): void {
  viewMode = mode;
  editorHost.classList.toggle("hidden", mode !== "text");
  sheetHost.classList.toggle("hidden", mode !== "sheet");
  docHost.classList.toggle("hidden", mode !== "doc");
  searchBar.classList.toggle("hidden", mode !== "text");
  if (mode !== "doc") doc.clear();
  if (mode !== "sheet") sheet.clear();
  if (mode !== "text" && editing) {
    editing = false;
    code.setEditable(false);
  }
  syncEditUi();
}

function canEditCurrent(): boolean {
  if (!activeFile || !lastFileMsg || lastFileMsg.path !== activeFile) return false;
  if (viewMode !== "text") return false;
  if (lastFileMsg.encoding === "base64") return false;
  // Binary-as-text (e.g. .beam decoded as latin1) contains NULs — not safely editable.
  if (lastFileMsg.content.includes("\0")) return false;
  const lower = activeFile.toLowerCase();
  if (
    lower.endsWith(".beam") ||
    lower.endsWith(".exe") ||
    lower.endsWith(".dll") ||
    lower.endsWith(".so") ||
    lower.endsWith(".o") ||
    lower.endsWith(".bin") ||
    lower.endsWith(".zip") ||
    lower.endsWith(".gz") ||
    lower.endsWith(".tgz")
  ) {
    return false;
  }
  return true;
}

function syncEditUi(): void {
  const dirty = editing && code.isDirty();
  const editableFile = canEditCurrent();
  const showActions = viewMode === "text" && Boolean(activeFile) && (editableFile || editing);

  viewerEditActions.classList.toggle("hidden", !showActions);

  btnEdit.disabled = (!editableFile && !editing) || saveBusy;
  btnEdit.textContent = editing ? "取消编辑" : "编辑";
  btnEdit.title = editing
    ? "退出编辑模式"
    : editableFile
      ? "编辑当前文本文件"
      : "当前文件不支持编辑";
  btnEdit.classList.toggle("editing", editing);

  btnSave.classList.toggle("hidden", !editing);
  btnSave.disabled = !editing || !dirty || saveBusy;
  btnSave.textContent = saveBusy ? "保存中…" : "保存";

  if (activeFile) {
    fileTitle.textContent = dirty ? `${activeFile} *` : activeFile;
  }
}

function askEditConfirm(message: string): Promise<EditConfirmChoice> {
  return new Promise((resolve) => {
    editConfirmWaiter = resolve;
    editConfirmBody.textContent = message;
    editConfirmModal.classList.remove("hidden");
  });
}

function closeEditConfirm(choice: EditConfirmChoice): void {
  editConfirmModal.classList.add("hidden");
  const waiter = editConfirmWaiter;
  editConfirmWaiter = null;
  waiter?.(choice);
}

async function ensureCanLeaveEdit(message = "有未保存的修改，是否保存后再退出编辑？"): Promise<boolean> {
  if (!editing || !code.isDirty()) {
    if (editing) {
      editing = false;
      code.setEditable(false);
      syncEditUi();
    }
    return true;
  }
  const choice = await askEditConfirm(message);
  if (choice === "cancel") return false;
  if (choice === "save") {
    const ok = await saveCurrentFile();
    if (!ok) return false;
  } else {
    code.revert();
  }
  editing = false;
  code.setEditable(false);
  syncEditUi();
  return true;
}

function waitEditWritten(): Promise<void> {
  return new Promise((resolve, reject) => {
    editWriteWaiter = { resolve, reject };
  });
}

async function saveCurrentFile(): Promise<boolean> {
  if (!activeFile || !editing || saveBusy) return false;
  if (!code.isDirty()) {
    toast("没有需要保存的修改");
    return true;
  }
  saveBusy = true;
  syncEditUi();
  try {
    const payload = code.getSaveContent();
    const encoding = lastFileMsg?.encoding === "latin1" ? "latin1" : "utf8";
    const writePromise = waitEditWritten();
    socket.send({
      op: "write",
      path: activeFile,
      encoding,
      content: payload,
    });
    await writePromise;
    code.markClean(payload);
    if (lastFileMsg && lastFileMsg.path === activeFile) {
      lastFileMsg = {
        ...lastFileMsg,
        content: payload,
        encoding,
        size: new TextEncoder().encode(payload).length,
      };
      fileMeta.textContent = `${formatSize(lastFileMsg.size)} · ${encoding}`;
    }
    toast("已保存");
    requestList(currentDir);
    syncEditUi();
    return true;
  } catch (e) {
    toast(`保存失败: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  } finally {
    saveBusy = false;
    syncEditUi();
  }
}

async function enterEditMode(): Promise<void> {
  if (!canEditCurrent() || editing) return;
  editing = true;
  code.setEditable(true);
  syncEditUi();
}

async function toggleEditMode(): Promise<void> {
  if (editing) {
    await ensureCanLeaveEdit();
    return;
  }
  if (!canEditCurrent()) return;
  await enterEditMode();
}

async function openFile(msg: Extract<ServerMsg, { op: "file" }>, seq: number): Promise<void> {
  const stale = () => seq !== openSeq;
  closeSearchPopup();
  const kind = detectPreview(msg.path);
  try {
    if (kind === "sheet" && msg.encoding === "base64") {
      if (stale()) return;
      sheet.open(base64ToArrayBuffer(msg.content));
      showMode("sheet");
      return;
    }
    if (kind === "csv") {
      if (stale()) return;
      sheet.openCsv(msg.content, msg.path);
      showMode("sheet");
      return;
    }
    if (kind === "docx" && msg.encoding === "base64") {
      await doc.openDocx(base64ToArrayBuffer(msg.content));
      if (stale()) return;
      showMode("doc");
      return;
    }
    if (kind === "doc" && msg.encoding === "base64") {
      if (stale()) return;
      doc.openDoc(base64ToArrayBuffer(msg.content));
      showMode("doc");
      return;
    }
    if (kind === "pdf" && msg.encoding === "base64") {
      if (stale()) return;
      doc.showPdf(base64ToArrayBuffer(msg.content));
      showMode("doc");
      return;
    }
    if (kind === "odt" && msg.encoding === "base64") {
      await doc.openOdt(base64ToArrayBuffer(msg.content));
      if (stale()) return;
      showMode("doc");
      return;
    }
    if (kind === "rtf") {
      if (stale()) return;
      doc.openRtf(msg.content);
      showMode("doc");
      return;
    }
    if (kind === "image" && msg.encoding === "base64") {
      if (stale()) return;
      doc.showImage(base64ToArrayBuffer(msg.content), mimeForImage(msg.path));
      showMode("doc");
      return;
    }
    if (kind === "unsupported-doc") {
      if (stale()) return;
      doc.showMessage(
        "暂不支持此演示文稿格式",
        "当前可预览 Word（docx/doc）、PDF、ODT、RTF、CSV 与常见图片。PPT 请另存为 PDF 后查看。",
      );
      showMode("doc");
      return;
    }
    if (stale()) return;
    showMode("text");
    editing = false;
    code.setFile(msg.path, msg.content);
    syncEditUi();
  } catch (e) {
    if (stale()) return;
    toast(`预览失败: ${e instanceof Error ? e.message : String(e)}`);
    showMode("text");
    editing = false;
    code.setFile(msg.path, msg.encoding === "base64" ? "[binary preview error]" : msg.content);
    syncEditUi();
  }
}

let currentDir = "";
let activeFile = "";
let lastFileMsg: Extract<ServerMsg, { op: "file" }> | null = null;
let downloadOnly = false;
let openSeq = 0;
let roots: string[] = [];
let currentEntries: ListRow[] = [];
let listSortKey: SortKey = loadSortKey();
let listSortDir: SortDir = loadSortDir();
let showHidden = loadShowHidden();
let sidebarCollapsed = false;
let sidebarWidthBeforeCollapse = loadSidebarWidth();
let sidebarZoom = loadSidebarZoom();

function applySidebarZoom(zoom: number): void {
  sidebarZoom = Math.min(SIDEBAR_ZOOM_MAX, Math.max(SIDEBAR_ZOOM_MIN, Math.round(zoom * 100) / 100));
  sidebar.style.setProperty("--sidebar-zoom", String(sidebarZoom));
  sidebarZoomLabel.textContent = formatSidebarZoom(sidebarZoom);
  localStorage.setItem(SIDEBAR_ZOOM_KEY, String(sidebarZoom));
}

function bumpSidebarZoom(delta: number): void {
  applySidebarZoom(sidebarZoom + delta);
}

applySidebarZoom(sidebarZoom);
const uploadPendingLists = new Map<string, (entries: DirEntry[]) => void>();
let uploadListSeq = 0;
let uploadWriteWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
let uploadRootNodes: ServerEntryNode[] = [];
let uploadTargetDir = "";
let uploadBusy = false;
let localBrowser: EmbeddedLocalBrowser | null = null;

function getLocalBrowser(): EmbeddedLocalBrowser {
  if (!uploadLocalTree || !uploadLocalPath || !uploadLocalSummary || !uploadFolderInput || !uploadFilesInput) {
    throw new Error("上传面板未就绪");
  }
  if (!localBrowser) {
    localBrowser = createEmbeddedLocalBrowser({
      listEl: uploadLocalTree,
      pathEl: uploadLocalPath,
      summaryEl: uploadLocalSummary,
      btnUp: btnLocalUp,
      folderInput: uploadFolderInput,
      fileInput: uploadFilesInput,
      onSelectionChange: () => {
        uploadLocalSummary.textContent = getLocalBrowser().selectionSummary();
      },
    });
  }
  return localBrowser;
}

sidebar.style.width = `${sidebarWidthBeforeCollapse}px`;

const socket = new FviewerSocket(onMessage, (ok) => {
  statusDot.classList.toggle("ok", ok);
});

function onMessage(msg: ServerMsg): void {
  if (msg.op === "hello") {
    currentDir = msg.cwd;
    roots = msg.roots ?? [];
    syncPathSelect(currentDir);
    requestList(currentDir);
    return;
  }
  if (msg.op === "roots") {
    roots = msg.roots;
    syncPathSelect(currentDir);
    return;
  }
  if (msg.op === "list") {
    if (msg.id?.startsWith("upload:")) {
      const waiter = uploadPendingLists.get(msg.id);
      uploadPendingLists.delete(msg.id);
      waiter?.(msg.entries);
      return;
    }
    currentDir = msg.path;
    syncPathSelect(msg.path);
    currentEntries = rowsFromEntries(msg.path, msg.entries, joinPath);
    renderFileBrowser();
    return;
  }
  if (msg.op === "file") {
    if (downloadOnly) {
      downloadOnly = false;
      downloadServerFile(msg);
      toast("已开始下载");
      return;
    }
    lastFileMsg = msg;
    btnDownload.disabled = false;
    const seq = ++openSeq;
    activeFile = msg.path;
    fileTitle.textContent = msg.path;
    fileMeta.textContent = `${formatSize(msg.size)} · ${msg.encoding}`;
    void openFile(msg, seq).then(() => {
      if (seq === openSeq) {
        highlightActive();
        syncEditUi();
      }
    });
    return;
  }
  if (msg.op === "written") {
    if (editWriteWaiter) {
      const w = editWriteWaiter;
      editWriteWaiter = null;
      w.resolve();
      return;
    }
    if (uploadWriteWaiter) {
      const w = uploadWriteWaiter;
      uploadWriteWaiter = null;
      w.resolve();
      return;
    }
    toast(`已上传: ${basename(msg.path)} (${formatSize(msg.size)})`);
    if (uploadTargetDir) requestList(uploadTargetDir);
    if (activeFile === msg.path && !editing) socket.send({ op: "read", path: msg.path });
    return;
  }
  if (msg.op === "error") {
    if (editWriteWaiter) {
      const w = editWriteWaiter;
      editWriteWaiter = null;
      w.reject(new Error(msg.message));
      return;
    }
    if (uploadWriteWaiter) {
      const w = uploadWriteWaiter;
      uploadWriteWaiter = null;
      w.reject(new Error(msg.message));
      return;
    }
    toast(msg.message);
  }
}

function setUploadProgress(done: number, total: number, name: string): void {
  if (total <= 0) {
    uploadProgress.classList.add("hidden");
    uploadProgressFill.style.width = "0%";
    uploadProgressText.textContent = "";
    return;
  }
  const pct = Math.round((done / total) * 100);
  uploadProgress.classList.remove("hidden");
  uploadProgressFill.style.width = `${pct}%`;
  uploadProgressText.textContent =
    done < total ? `上传中 ${done + 1}/${total}：${name}` : `完成 ${total}/${total}`;
}

function resetUploadUi(): void {
  uploadBusy = false;
  if (btnUpload) btnUpload.disabled = false;
  if (btnUploadConfirm) btnUploadConfirm.disabled = false;
  uploadWriteWaiter = null;
  setUploadProgress(0, 0, "");
}

function showLocalBrowserPlaceholder(): void {
  if (uploadLocalPath) {
    uploadLocalPath.textContent = "（未选择文件或文件夹）";
  }
  if (uploadLocalSummary) {
    uploadLocalSummary.textContent = "勾选要上传的文件或文件夹";
  }
  if (uploadLocalTree) {
    uploadLocalTree.innerHTML =
      `<div class="upload-tree-empty">点击上方「选择文件夹」或「选择文件」</div>`;
    uploadLocalTree.onclick = null;
  }
}

function updateUploadDirPathDisplay(): void {
  uploadDirPath.textContent = uploadTargetDir || "（未选择）";
}

function rootsToUploadNodes(): ServerEntryNode[] {
  const src = roots.length > 0 ? roots : currentDir ? [currentDir] : [];
  return src.map((r) => ({
    path: r,
    name: r,
    type: "dir" as const,
    size: 0,
    expanded: false,
    loaded: false,
    children: [],
  }));
}

function requestUploadList(path: string): Promise<DirEntry[]> {
  const reqId = `upload:${++uploadListSeq}`;
  return new Promise((resolve) => {
    const onEntries = (entries: DirEntry[]) => {
      clearTimeout(timer);
      resolve(entries);
    };
    uploadPendingLists.set(reqId, onEntries);
    const timer = window.setTimeout(() => {
      if (uploadPendingLists.get(reqId) === onEntries) {
        uploadPendingLists.delete(reqId);
        resolve([]);
      }
    }, 30_000);
    socket.send({ op: "list", path, id: reqId });
  });
}

function loadUploadChildren(node: ServerEntryNode): Promise<void> {
  if (node.loaded) return Promise.resolve();
  return requestUploadList(node.path).then((entries) => {
    node.children = entries.map((e) => ({
      path: joinPath(node.path, e.name),
      name: e.name,
      type: e.type,
      size: e.size,
      expanded: false,
      loaded: e.type !== "dir",
      children: [],
    }));
    node.loaded = true;
  });
}

function renderUploadDirTree(): void {
  renderServerDirTree(uploadDirTree, uploadRootNodes, uploadTargetDir, {
    onToggleDir: async (node) => {
      node.expanded = !node.expanded;
      if (node.expanded) await loadUploadChildren(node);
      renderUploadDirTree();
    },
    onSelectDir: (node) => {
      uploadTargetDir = node.path;
      updateUploadDirPathDisplay();
      renderUploadDirTree();
    },
  });
}


function relPath(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (rel) return rel.replace(/\\/g, "/");
  return file.name;
}

async function browseLocalFolder(): Promise<void> {
  try {
    await getLocalBrowser().browseFolder();
  } catch (e) {
    toast(`无法选择文件夹: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function browseLocalFiles(): Promise<void> {
  try {
    await getLocalBrowser().browseFiles();
  } catch (e) {
    toast(`无法选择文件: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function expandUploadPathTo(target: string): Promise<void> {
  if (!target) return;
  const targetNorm = normPath(target);
  let rootNode = uploadRootNodes.find((n) => {
    const rn = normPath(n.path);
    return targetNorm === rn || targetNorm.startsWith(rn.replace(/[/\\]+$/, "") + "/") || targetNorm.startsWith(rn.replace(/[/\\]+$/, "") + "\\");
  });
  if (!rootNode && uploadRootNodes.length === 1) rootNode = uploadRootNodes[0];
  if (!rootNode) {
    uploadTargetDir = target;
    return;
  }

  const rootBase = rootNode.path.replace(/[/\\]+$/, "");
  const rel = target.slice(rootBase.length).replace(/^[/\\]+/, "");
  const parts = rel ? rel.split(/[/\\]/).filter(Boolean) : [];

  rootNode.expanded = true;
  await loadUploadChildren(rootNode);
  let current = rootNode;
  for (const part of parts) {
    const child = current.children.find(
      (c) => c.type === "dir" && normPath(c.name) === normPath(part),
    );
    if (!child) break;
    child.expanded = true;
    await loadUploadChildren(child);
    current = child;
  }
  uploadTargetDir = current.path;
}

async function initUploadDirTree(): Promise<void> {
  uploadRootNodes = rootsToUploadNodes();
  uploadTargetDir = currentDir || roots[0] || "";
  if (uploadTargetDir) await expandUploadPathTo(uploadTargetDir);
  updateUploadDirPathDisplay();
  renderUploadDirTree();
}

function openUploadModal(): void {
  if (uploadBusy) return;
  if (!uploadModal) {
    toast("上传面板未找到");
    return;
  }
  resetUploadUi();
  uploadModal.classList.remove("hidden");
  if (localBrowser) {
    try {
      localBrowser.reset();
    } catch (e) {
      showLocalBrowserPlaceholder();
      toast(`本地浏览初始化失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    showLocalBrowserPlaceholder();
  }
  void initUploadDirTree();
}

function closeUploadModal(): void {
  if (uploadBusy) return;
  uploadModal.classList.add("hidden");
  resetUploadUi();
}

function waitUploadWritten(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      if (uploadWriteWaiter) {
        uploadWriteWaiter = null;
        reject(new Error("上传超时"));
      }
    }, 120_000);
    uploadWriteWaiter = {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    };
  });
}

async function confirmUpload(): Promise<void> {
  const dir = uploadTargetDir;
  let fileArr: File[] = [];
  try {
    fileArr = await getLocalBrowser().resolveSelectedFiles();
  } catch {
    fileArr = [];
  }
  if (!dir) {
    toast("请在右侧选择目标目录");
    return;
  }
  if (fileArr.length === 0) {
    toast("请在左侧选择要上传的文件");
    return;
  }
  uploadBusy = true;
  btnUpload.disabled = true;
  btnUploadConfirm.disabled = true;
  let okCount = 0;
  try {
    for (let i = 0; i < fileArr.length; i++) {
      const file = fileArr[i]!;
      setUploadProgress(i, fileArr.length, file.name);
      const buf = await file.arrayBuffer();
      if (buf.byteLength > 300 * 1024 * 1024) {
        toast(`${file.name} 超过 300MB，已跳过`);
        continue;
      }
      const path = joinPath(dir, relPath(file));
      const writePromise = waitUploadWritten();
      socket.send({
        op: "write",
        path,
        encoding: "base64",
        content: arrayBufferToBase64(buf),
      });
      await writePromise;
      okCount++;
      setUploadProgress(i + 1, fileArr.length, file.name);
    }
    toast(okCount > 0 ? `成功上传 ${okCount} 个文件` : "没有文件被上传");
    requestList(dir);
  } catch (e) {
    toast(`上传失败: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    resetUploadUi();
  }
}

function syncPathSelect(path: string): void {
  const options = new Map<string, string>();
  for (const root of roots) {
    options.set(normPath(root), root);
  }
  if (path) {
    options.set(normPath(path), path);
  }

  const selectedNorm = normPath(path);
  pathSelect.innerHTML = "";
  for (const value of options.values()) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value;
    if (normPath(value) === selectedNorm) opt.selected = true;
    pathSelect.appendChild(opt);
  }
}

function setShowHidden(on: boolean): void {
  showHidden = on;
  localStorage.setItem(FILE_LIST_SHOW_HIDDEN, on ? "1" : "0");
  btnToggleHidden.setAttribute("aria-pressed", on ? "true" : "false");
  btnToggleHidden.classList.toggle("on", on);
  btnToggleHidden.title = on ? "隐藏的项目（已显示）" : "显示隐藏的项目";
  renderFileBrowser();
}

function setListSort(key: SortKey): void {
  if (listSortKey === key) {
    listSortDir = listSortDir === "asc" ? "desc" : "asc";
  } else {
    listSortKey = key;
    listSortDir = "asc";
  }
  localStorage.setItem(FILE_LIST_SORT_KEY, listSortKey);
  localStorage.setItem(FILE_LIST_SORT_DIR, listSortDir);
  renderFileBrowser();
}

function renderFileBrowser(): void {
  renderFileList(treeEl, {
    dir: currentDir,
    entries: currentEntries,
    sortKey: listSortKey,
    sortDir: listSortDir,
    showHidden,
    activePath: activeFile,
    onSort: setListSort,
    onOpenDir: async (path) => {
      const ok = await ensureCanLeaveEdit("切换目录前有未保存的修改，是否保存？");
      if (!ok) return;
      requestList(path);
    },
    onOpenFile: async (path) => {
      if (path === activeFile) return;
      const ok = await ensureCanLeaveEdit("打开其他文件前有未保存的修改，是否保存？");
      if (!ok) return;
      socket.send({ op: "read", path });
    },
  });
}

function highlightActive(): void {
  treeEl.querySelectorAll(".file-list-row.active").forEach((el) => el.classList.remove("active"));
  if (!activeFile) return;
  const hit = treeEl.querySelector(`.file-list-row[data-path="${CSS.escape(activeFile)}"]`);
  hit?.classList.add("active");
}

function requestList(path: string): void {
  socket.send({ op: "list", path });
}

function setupSplitter(): void {
  let dragging = false;

  const onMove = (clientX: number) => {
    const rect = layout.getBoundingClientRect();
    const width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, clientX - rect.left));
    sidebar.style.width = `${width}px`;
  };

  splitter.addEventListener("pointerdown", (ev) => {
    if (sidebarCollapsed) return;
    if ((ev.target as HTMLElement).closest(".splitter-toggle")) return;
    dragging = true;
    splitter.setPointerCapture(ev.pointerId);
    document.body.classList.add("is-resizing");
    ev.preventDefault();
  });

  splitter.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    onMove(ev.clientX);
  });

  const endDrag = (ev: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("is-resizing");
    try {
      splitter.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    const width = Math.round(sidebar.getBoundingClientRect().width);
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(width));
  };

  splitter.addEventListener("pointerup", endDrag);
  splitter.addEventListener("pointercancel", endDrag);

  splitter.addEventListener("dblclick", () => {
    sidebar.style.width = `${SIDEBAR_DEFAULT}px`;
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(SIDEBAR_DEFAULT));
  });
}

document.getElementById("btnUp")!.addEventListener("click", async () => {
  const ok = await ensureCanLeaveEdit("切换目录前有未保存的修改，是否保存？");
  if (!ok) return;
  const path = pathSelect.value || currentDir;
  if (!path) return;
  socket.send({ op: "parent", path });
});

document.getElementById("btnRefresh")!.addEventListener("click", async () => {
  const ok = await ensureCanLeaveEdit("刷新前有未保存的修改，是否保存？");
  if (!ok) return;
  requestList(pathSelect.value || currentDir);
});

btnToggleHidden.addEventListener("click", () => setShowHidden(!showHidden));
setShowHidden(showHidden);

pathSelect.addEventListener("change", async () => {
  const path = pathSelect.value.trim();
  if (!path) return;
  const ok = await ensureCanLeaveEdit("切换路径前有未保存的修改，是否保存？");
  if (!ok) {
    syncPathSelect(currentDir);
    return;
  }
  requestList(path);
});

function isToggleOn(btn: HTMLButtonElement): boolean {
  return btn.getAttribute("aria-pressed") === "true";
}

function setToggle(btn: HTMLButtonElement, on: boolean): void {
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.classList.toggle("on", on);
}

function syncSearchQuery(): void {
  code.applySearch({
    search: findInput.value,
    caseSensitive: isToggleOn(optCase),
    regexp: isToggleOn(optRegexp),
    wholeWord: isToggleOn(optWord),
  });
}

function setMatchCountText(text: string, empty: boolean): void {
  matchCount.classList.toggle("empty", empty);
  const label = matchCount.querySelector(".idea-results-label");
  if (label) label.textContent = text;
  else matchCount.textContent = text;
}

function refreshMatchCount(): void {
  const q = findInput.value;
  if (!q) {
    syncSearchQuery();
    setMatchCountText("0 results", true);
    return;
  }
  syncSearchQuery();
  const n = code.countMatches(1000);
  if (n <= 0) {
    setMatchCountText("0 results", true);
  } else if (n >= 1000) {
    setMatchCountText("1000+ results", false);
  } else {
    setMatchCountText(n === 1 ? "1 result" : `${n} results`, false);
  }
}

let searchDebounce: ReturnType<typeof setTimeout> | undefined;

findInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(refreshMatchCount, 200);
});

findInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    syncSearchQuery();
    if (ev.shiftKey) code.findPrevious();
    else code.findNext();
    refreshMatchCount();
  }
});

for (const btn of [optCase, optWord, optRegexp]) {
  btn.addEventListener("click", () => {
    setToggle(btn, !isToggleOn(btn));
    refreshMatchCount();
    if (findInput.value) code.findNext();
  });
}

document.getElementById("btnFindNext")!.addEventListener("click", () => {
  syncSearchQuery();
  if (!code.findNext()) toast("没有更多匹配");
});
document.getElementById("btnFindPrev")!.addEventListener("click", () => {
  syncSearchQuery();
  if (!code.findPrevious()) toast("没有更多匹配");
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlightSnippet(lineText: string, query: string, caseSensitive: boolean): string {
  if (!query) return escapeHtml(lineText);
  if (isToggleOn(optRegexp)) {
    try {
      const flags = caseSensitive ? "g" : "gi";
      const re = new RegExp(query, flags);
      let out = "";
      let last = 0;
      for (const m of lineText.matchAll(re)) {
        const start = m.index ?? 0;
        out += escapeHtml(lineText.slice(last, start));
        out += `<mark>${escapeHtml(m[0])}</mark>`;
        last = start + m[0].length;
      }
      out += escapeHtml(lineText.slice(last));
      return out;
    } catch {
      return escapeHtml(lineText);
    }
  }
  const src = caseSensitive ? lineText : lineText.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const idx = src.indexOf(needle);
  if (idx < 0) return escapeHtml(lineText);
  const before = escapeHtml(lineText.slice(0, idx));
  const hit = escapeHtml(lineText.slice(idx, idx + query.length));
  const after = escapeHtml(lineText.slice(idx + query.length));
  return `${before}<mark>${hit}</mark>${after}`;
}

function closeSearchPopup(): void {
  searchPopup.classList.add("hidden");
}

function openSearchPopup(): void {
  syncSearchQuery();
  const q = findInput.value.trim();
  refreshMatchCount();
  const hits = q ? code.listMatches(500) : [];
  searchPopupTitle.textContent =
    !q ? "搜索结果" : hits.length >= 500 ? "搜索结果（前 500 条）" : `搜索结果（${hits.length}）`;
  searchPopupList.innerHTML = "";
  if (!q) {
    searchPopupList.innerHTML = `<div class="search-popup-empty">请先输入搜索内容</div>`;
  } else if (hits.length === 0) {
    searchPopupList.innerHTML = `<div class="search-popup-empty">未找到匹配</div>`;
  } else {
    const caseSensitive = isToggleOn(optCase);
    for (const hit of hits) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "search-hit";
      btn.dataset.from = String(hit.from);
      btn.dataset.to = String(hit.to);
      btn.innerHTML = `
        <span class="ln">${hit.line}</span>
        <span class="tx">${highlightSnippet(hit.text, q, caseSensitive)}</span>`;
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        searchPopupList.querySelectorAll(".search-hit.active").forEach((el) => el.classList.remove("active"));
        btn.classList.add("active");
        code.jumpToMatch(hit.from, hit.to);
        // 保持弹窗打开：仅手动关闭或打开新文件时关闭
      });
      searchPopupList.appendChild(btn);
    }
  }
  searchPopup.classList.remove("hidden");
}

document.getElementById("btnFindList")!.addEventListener("click", (ev) => {
  ev.stopPropagation();
  if (searchPopup.classList.contains("hidden")) openSearchPopup();
  else closeSearchPopup();
});

document.getElementById("btnClosePopup")!.addEventListener("click", (ev) => {
  ev.stopPropagation();
  closeSearchPopup();
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    if (!editConfirmModal.classList.contains("hidden")) {
      closeEditConfirm("cancel");
      return;
    }
    closeSearchPopup();
  }
});

document.getElementById("btnZoomIn")!.addEventListener("click", () => code.bumpFont(1));
document.getElementById("btnZoomOut")!.addEventListener("click", () => code.bumpFont(-1));

document.getElementById("btnSidebarZoomIn")!.addEventListener("click", () => bumpSidebarZoom(SIDEBAR_ZOOM_STEP));
document.getElementById("btnSidebarZoomOut")!.addEventListener("click", () => bumpSidebarZoom(-SIDEBAR_ZOOM_STEP));

sidebar.addEventListener(
  "wheel",
  (ev) => {
    if (!sidebar.contains(ev.target as Node)) return;
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      bumpSidebarZoom(ev.deltaY < 0 ? SIDEBAR_ZOOM_STEP : -SIDEBAR_ZOOM_STEP);
    }
  },
  { passive: false },
);

btnFoldSidebar.addEventListener("click", (ev) => {
  ev.stopPropagation();
  sidebarCollapsed = !sidebarCollapsed;
  if (sidebarCollapsed) {
    sidebarWidthBeforeCollapse = Math.round(sidebar.getBoundingClientRect().width) || sidebarWidthBeforeCollapse;
    layout.classList.add("sidebar-collapsed");
    btnFoldSidebar.textContent = "▸";
    btnFoldSidebar.title = "展开左侧目录";
  } else {
    layout.classList.remove("sidebar-collapsed");
    sidebar.style.width = `${sidebarWidthBeforeCollapse}px`;
    btnFoldSidebar.textContent = "◂";
    btnFoldSidebar.title = "折叠左侧目录";
  }
});

btnFoldSidebar.addEventListener("pointerdown", (ev) => {
  ev.stopPropagation();
});

document.getElementById("btnCopy")!.addEventListener("click", async () => {
  const ok = await code.copySelectionOrAll();
  toast(ok ? "已复制到剪贴板" : "复制失败");
});

btnEdit.addEventListener("click", () => void toggleEditMode());
btnSave.addEventListener("click", () => void saveCurrentFile());

document.getElementById("btnConfirmDiscard")!.addEventListener("click", () => closeEditConfirm("discard"));
document.getElementById("btnConfirmCancel")!.addEventListener("click", () => closeEditConfirm("cancel"));
document.getElementById("btnConfirmSave")!.addEventListener("click", () => closeEditConfirm("save"));
editConfirmModal.addEventListener("click", (ev) => {
  if (ev.target === editConfirmModal) closeEditConfirm("cancel");
});

document.addEventListener("keydown", (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
    if (editing && viewMode === "text") {
      ev.preventDefault();
      void saveCurrentFile();
    }
  }
});

btnDownload.addEventListener("click", () => {
  if (!activeFile) return;
  if (lastFileMsg && lastFileMsg.path === activeFile) {
    downloadServerFile(lastFileMsg);
    toast("已开始下载");
    return;
  }
  downloadOnly = true;
  socket.send({ op: "read", path: activeFile });
});

btnUpload.addEventListener("click", () => openUploadModal());
document.getElementById("btnPickLocalFolder")!.addEventListener("click", () => void browseLocalFolder());
document.getElementById("btnPickLocalFiles")!.addEventListener("click", () => void browseLocalFiles());
btnLocalUp?.addEventListener("click", () => getLocalBrowser().goUp());
document.getElementById("btnSelectAllLocal")!.addEventListener("click", () => getLocalBrowser().selectAllInView());
document.getElementById("btnCloseUpload")!.addEventListener("click", closeUploadModal);
document.getElementById("btnUploadCancel")!.addEventListener("click", closeUploadModal);
document.getElementById("btnUploadConfirm")!.addEventListener("click", () => void confirmUpload());
uploadModal.addEventListener("click", (ev) => {
  if (ev.target === uploadModal) closeUploadModal();
});

setupSplitter();
syncEditUi();
socket.connect();
