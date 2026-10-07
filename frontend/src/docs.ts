import mammoth from "mammoth";

export type PreviewKind =
  | "text"
  | "sheet"
  | "csv"
  | "docx"
  | "doc"
  | "pdf"
  | "odt"
  | "rtf"
  | "image"
  | "unsupported-doc";

const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"];

export function extOf(path: string): string {
  const m = path.toLowerCase().match(/(\.[a-z0-9]+)$/);
  return m ? m[1] : "";
}

export function detectPreview(path: string): PreviewKind {
  const ext = extOf(path);
  if ([".xlsx", ".xls", ".xlsm", ".xlsb"].includes(ext)) return "sheet";
  if (ext === ".csv" || ext === ".tsv") return "csv";
  if (ext === ".docx") return "docx";
  if (ext === ".doc") return "doc";
  if (ext === ".pdf") return "pdf";
  if (ext === ".odt") return "odt";
  if (ext === ".rtf") return "rtf";
  if (IMAGE_EXT.includes(ext)) return "image";
  if ([".ppt", ".pptx", ".pps", ".ppsx"].includes(ext)) return "unsupported-doc";
  return "text";
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function mimeForImage(path: string): string {
  const ext = extOf(path);
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".svg": "image/svg+xml",
  };
  return map[ext] ?? "application/octet-stream";
}

function stripXml(xml: string): string {
  return xml
    .replace(/<text:line-break[^>]*\/>/g, "\n")
    .replace(/<text:tab[^>]*\/>/g, "\t")
    .replace(/<text:p[^>]*>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripRtf(rtf: string): string {
  return rtf
    .replace(/\{\\pict[\s\S]*?\}/g, "")
    .replace(/\{\\\*\\[^{}]+\}/g, "")
    .replace(/\\'[0-9a-fA-F]{2}/g, "")
    .replace(/\\u(-?\d+)\??/g, (_, n) => {
      const code = Number(n);
      return code > 0 ? String.fromCharCode(code) : "";
    })
    .replace(/\\par[d]?/g, "\n")
    .replace(/\\tab/g, "\t")
    .replace(/\\line/g, "\n")
    .replace(/\\[a-z]+(-?\d+)?[ ]?/gi, "")
    .replace(/[{}]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Rough text pull from legacy .doc binary (best-effort). */
function roughDocText(buf: ArrayBuffer): string {
  const u8 = new Uint8Array(buf);
  const out: string[] = [];
  let run = "";
  const flush = () => {
    if (run.length >= 4) out.push(run);
    run = "";
  };
  for (let i = 0; i + 1 < u8.length; i += 2) {
    const c = u8[i] | (u8[i + 1] << 8);
    if (c === 0x000d || c === 0x000a) {
      run += "\n";
    } else if (c === 0x0009) {
      run += "\t";
    } else if (c >= 0x20 && c < 0xd800) {
      run += String.fromCharCode(c);
    } else {
      flush();
    }
  }
  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export class DocPane {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private objectUrl: string | null = null;

  constructor(parent: HTMLElement) {
    parent.innerHTML = `<div class="doc-body" id="docBody"></div>`;
    this.root = parent;
    this.body = parent.querySelector("#docBody") as HTMLElement;
  }

  private revoke(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  clear(): void {
    this.revoke();
    this.body.innerHTML = "";
  }

  showMessage(title: string, detail: string): void {
    this.revoke();
    this.body.innerHTML = `
      <div class="doc-message">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(detail)}</p>
      </div>`;
  }

  showHtml(html: string, note?: string): void {
    this.revoke();
    this.body.innerHTML = `
      ${note ? `<div class="doc-note">${escapeHtml(note)}</div>` : ""}
      <article class="doc-html">${html}</article>`;
  }

  showPre(text: string, note?: string): void {
    this.revoke();
    this.body.innerHTML = `
      ${note ? `<div class="doc-note">${escapeHtml(note)}</div>` : ""}
      <pre class="doc-pre"></pre>`;
    (this.body.querySelector(".doc-pre") as HTMLElement).textContent = text;
  }

  showPdf(buf: ArrayBuffer): void {
    this.revoke();
    const blob = new Blob([buf], { type: "application/pdf" });
    this.objectUrl = URL.createObjectURL(blob);
    this.body.innerHTML = `<iframe class="doc-frame" title="PDF" src="${this.objectUrl}"></iframe>`;
  }

  showImage(buf: ArrayBuffer, mime: string): void {
    this.revoke();
    const blob = new Blob([buf], { type: mime });
    this.objectUrl = URL.createObjectURL(blob);
    this.body.innerHTML = `<div class="doc-image-wrap"><img class="doc-image" alt="preview" src="${this.objectUrl}" /></div>`;
  }

  async openDocx(buf: ArrayBuffer): Promise<void> {
    const result = await mammoth.convertToHtml({ arrayBuffer: buf });
    const note =
      result.messages.length > 0
        ? `已转换预览（部分样式可能丢失）`
        : undefined;
    this.showHtml(result.value || "<p>（空文档）</p>", note);
  }

  openDoc(buf: ArrayBuffer): void {
    const text = roughDocText(buf);
    if (text.length < 32) {
      this.showMessage(
        "无法预览此 .doc 文件",
        "旧版 Word 97-2003 二进制格式解析有限。请用 Word / WPS 另存为 .docx 后再打开。",
      );
      return;
    }
    this.showPre(
      text,
      "旧版 .doc 为尽力提取的纯文本预览，格式/图片会丢失。完整排版请另存为 .docx。",
    );
  }

  async openOdt(buf: ArrayBuffer): Promise<void> {
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(buf);
    const entry = zip.file("content.xml");
    if (!entry) {
      this.showMessage("无法预览", "ODT 中缺少 content.xml");
      return;
    }
    const xml = await entry.async("string");
    this.showPre(stripXml(xml), "OpenDocument 文本预览（样式已忽略）");
  }

  openRtf(text: string): void {
    this.showPre(stripRtf(text), "RTF 纯文本预览（样式已忽略）");
  }

  setFontSize(px: number): void {
    this.root.style.setProperty("--doc-font-size", `${px}px`);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
