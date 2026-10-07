import { Compartment, EditorSelection, EditorState, Extension, RangeSetBuilder } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  Decoration,
  ViewPlugin,
  ViewUpdate,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, copyLineDown } from "@codemirror/commands";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  bracketMatching,
  foldGutter,
  foldKeymap,
  StreamLanguage,
} from "@codemirror/language";
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
  SearchQuery,
  setSearchQuery,
  getSearchQuery,
  findNext,
  findPrevious,
} from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
import { xml } from "@codemirror/lang-xml";
import { sql } from "@codemirror/lang-sql";

const FONT_MIN = 10;
const FONT_MAX = 36;
const FONT_DEFAULT = 24;
const FONT_STORAGE_KEY = "fviewer.fontSize";
const WRAP_STORAGE_KEY = "fviewer.lineWrap";
/** Skip syntax highlighting above this size (bytes). */
const LARGE_FILE_BYTES = 5 * 1024 * 1024;

function erlangLike() {
  return StreamLanguage.define({
    name: "erlang",
    startState: () => ({ inString: false }),
    token(stream, state) {
      if (state.inString) {
        while (!stream.eol()) {
          const ch = stream.next();
          if (ch === "\\") stream.next();
          else if (ch === '"') {
            state.inString = false;
            break;
          }
        }
        return "string";
      }
      if (stream.match("%")) {
        stream.skipToEnd();
        return "comment";
      }
      if (stream.match('"')) {
        state.inString = true;
        return "string";
      }
      if (stream.match(/^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/)) return "number";
      if (stream.match(/->[|=]|::|:=|==|=:=|\/=|=\/=|=<|>=|<-|\+\+|--|\|\||&&/)) return "operator";
      if (stream.match(/[{}()\[\];,.]/)) return "punctuation";
      if (stream.match(/[A-Z_][A-Za-z0-9_]*/)) return "variableName";
      if (stream.match(/[a-z][A-Za-z0-9_]*/)) {
        const word = stream.current();
        const keywords = new Set([
          "after", "and", "andalso", "band", "begin", "bnot", "bor", "bsl", "bsr", "bxor",
          "case", "catch", "cond", "div", "end", "fun", "if", "let", "not", "of", "or",
          "orelse", "receive", "rem", "try", "when", "xor", "maybe", "else",
        ]);
        return keywords.has(word) ? "keyword" : "atom";
      }
      stream.next();
      return null;
    },
  });
}

/** Highlight common Erlang/OTP logger, sasl REPORT, and lager-style log lines. */
function erlangLogLike() {
  const levelError = new Set(["error", "critical", "alert", "emergency", "crash"]);
  const levelWarn = new Set(["warning", "warn", "notice"]);
  const levelInfo = new Set(["info", "informational"]);
  const levelDebug = new Set(["debug", "trace"]);

  return StreamLanguage.define({
    name: "erlang-log",
    startState: () => ({ inString: false }),
    token(stream, state) {
      if (state.inString) {
        while (!stream.eol()) {
          const ch = stream.next();
          if (ch === "\\") stream.next();
          else if (ch === '"') {
            state.inString = false;
            break;
          }
        }
        return "string";
      }

      // =ERROR REPORT==== 12-Jan-2024::10:00:00.123 ===
      if (stream.match(/^=[A-Z][A-Z_ ]*REPORT====/)) return "keyword";
      if (stream.match(/^=[A-Z][A-Z_ ]*====/)) return "keyword";

      // ISO / OTP timestamps
      if (
        stream.match(
          /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/,
        ) ||
        stream.match(/^\d{1,2}-[A-Za-z]{3}-\d{4}::\d{2}:\d{2}:\d{2}(?:\.\d+)?/)
      ) {
        return "number";
      }

      // <0.123.0> / #Port<0.1> / #Ref<0.0.0.1>
      if (stream.match(/^#(?:Port|Ref)<[\d.]+>/) || stream.match(/^<\d+\.\d+\.\d+>/)) {
        return "meta";
      }

      // [error] / [INFO] / error:
      if (stream.match(/^\[(?:error|warning|warn|info|debug|notice|critical|alert|emergency|trace)\]/i)) {
        const raw = stream.current().slice(1, -1).toLowerCase();
        if (levelError.has(raw)) return "invalid";
        if (levelWarn.has(raw)) return "modifier";
        if (levelDebug.has(raw)) return "comment";
        return "keyword";
      }
      if (stream.match(/^(?:error|warning|warn|info|debug|notice|critical|alert|emergency|trace)\b/i)) {
        const raw = stream.current().toLowerCase();
        if (levelError.has(raw)) return "invalid";
        if (levelWarn.has(raw)) return "modifier";
        if (levelInfo.has(raw)) return "keyword";
        if (levelDebug.has(raw)) return "comment";
        return "keyword";
      }

      // module:function/arity or module:function(
      if (stream.match(/^[a-z][A-Za-z0-9_]*:[a-zA-Z_][A-Za-z0-9_]*\/\d+/)) return "variableName";
      if (stream.match(/^[a-z][A-Za-z0-9_]*:[a-zA-Z_][A-Za-z0-9_]*(?=\()/)) return "variableName";

      // ** exception ... / CRASH REPORT markers
      if (stream.match(/^\*\*.*$/)) return "invalid";

      if (stream.match('"')) {
        state.inString = true;
        return "string";
      }
      if (stream.match(/^'[^']*'/)) return "string";
      if (stream.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)) return "number";
      if (stream.match(/^[A-Z_][A-Za-z0-9_]*/)) return "variableName";
      if (stream.match(/^[a-z][A-Za-z0-9_]*/)) return "atom";
      if (stream.match(/^[{}()\[\];,.#|]/)) return "punctuation";
      stream.next();
      return null;
    },
  });
}

function isErlangLogPath(path: string): boolean {
  const lower = path.toLowerCase();
  const base = lower.split(/[/\\]/).pop() || lower;
  if (lower.endsWith(".log") || lower.endsWith(".log.txt")) return true;
  if (base === "erl_crash.dump" || base.endsWith(".crash.dump")) return true;
  // Common OTP / release log names without extension
  return /(?:^|[._-])(erlang|sasl|lager|logger|crash|error)[._-]?log(?:$|\.)/.test(base);
}

const GLSL_KEYWORDS = new Set([
  "attribute", "const", "uniform", "varying", "buffer", "shared", "coherent", "volatile",
  "restrict", "readonly", "writeonly", "atomic_uint", "layout", "centroid", "flat",
  "smooth", "noperspective", "patch", "sample", "break", "continue", "do", "for", "while",
  "switch", "case", "default", "if", "else", "subroutine", "in", "out", "inout", "float",
  "double", "int", "void", "bool", "true", "false", "invariant", "precise", "discard",
  "return", "mat2", "mat3", "mat4", "dmat2", "dmat3", "dmat4", "mat2x2", "mat2x3", "mat2x4",
  "mat3x2", "mat3x3", "mat3x4", "mat4x2", "mat4x3", "mat4x4", "vec2", "vec3", "vec4",
  "ivec2", "ivec3", "ivec4", "bvec2", "bvec3", "bvec4", "dvec2", "dvec3", "dvec4",
  "uint", "uvec2", "uvec3", "uvec4", "lowp", "mediump", "highp", "precision", "sampler1D",
  "sampler2D", "sampler3D", "samplerCube", "sampler1DShadow", "sampler2DShadow",
  "samplerCubeShadow", "sampler1DArray", "sampler2DArray", "sampler1DArrayShadow",
  "sampler2DArrayShadow", "isampler1D", "isampler2D", "isampler3D", "isamplerCube",
  "isampler1DArray", "isampler2DArray", "usampler1D", "usampler2D", "usampler3D",
  "usamplerCube", "usampler1DArray", "usampler2DArray", "sampler2DRect", "sampler2DRectShadow",
  "isampler2DRect", "usampler2DRect", "samplerBuffer", "isamplerBuffer", "usamplerBuffer",
  "sampler2DMS", "isampler2DMS", "usampler2DMS", "sampler2DMSArray", "isampler2DMSArray",
  "usampler2DMSArray", "samplerCubeArray", "samplerCubeArrayShadow", "isamplerCubeArray",
  "usamplerCubeArray", "image1D", "iimage1D", "uimage1D", "image2D", "iimage2D", "uimage2D",
  "image3D", "iimage3D", "uimage3D", "image2DRect", "iimage2DRect", "uimage2DRect",
  "imageCube", "iimageCube", "uimageCube", "imageBuffer", "iimageBuffer", "uimageBuffer",
  "image1DArray", "iimage1DArray", "uimage1DArray", "image2DArray", "iimage2DArray",
  "uimage2DArray", "imageCubeArray", "iimageCubeArray", "uimageCubeArray", "image2DMS",
  "iimage2DMS", "uimage2DMS", "image2DMSArray", "iimage2DMSArray", "uimage2DMSArray",
  "struct", "common", "partition", "active", "asm", "class", "union", "enum", "typedef",
  "template", "this", "resource", "goto", "inline", "noinline", "public", "static",
  "extern", "external", "interface", "long", "short", "half", "fixed", "unsigned", "superp",
  "input", "output", "hvec2", "hvec3", "hvec4", "fvec2", "fvec3", "fvec4", "sampler3DRect",
  "filter", "sizeof", "cast", "namespace", "using",
]);

function glslLike() {
  return StreamLanguage.define({
    name: "glsl",
    startState: () => ({ inString: false, inComment: false }),
    token(stream, state) {
      if (state.inComment) {
        if (stream.match(/.*?\*\//)) state.inComment = false;
        else stream.skipToEnd();
        return "comment";
      }
      if (state.inString) {
        while (!stream.eol()) {
          const ch = stream.next();
          if (ch === "\\") stream.next();
          else if (ch === '"') {
            state.inString = false;
            break;
          }
        }
        return "string";
      }
      if (stream.match("//")) {
        stream.skipToEnd();
        return "comment";
      }
      if (stream.match("/*")) {
        state.inComment = true;
        return "comment";
      }
      if (stream.match("#")) {
        stream.skipToEnd();
        return "meta";
      }
      if (stream.match('"')) {
        state.inString = true;
        return "string";
      }
      if (stream.match(/^-?[0-9]+(\.[0-9]*)?([eE][+-]?[0-9]+)?[fF]?/) || stream.match(/^0[xX][0-9a-fA-F]+[uU]?/)) {
        return "number";
      }
      if (stream.match(/[{}()\[\];,.]/)) return "punctuation";
      if (stream.match(/<<=|>>=|<<|>>|<=|>=|==|!=|\+\+|--|\|\||&&|[+\-*/%&|^~!=<>]=?/)) return "operator";
      if (stream.match(/[A-Za-z_][A-Za-z0-9_]*/)) {
        const word = stream.current();
        return GLSL_KEYWORDS.has(word) ? "keyword" : "variableName";
      }
      stream.next();
      return null;
    },
  });
}

function isShaderPath(path: string): boolean {
  const lower = path.toLowerCase();
  // Avoid short ambiguous suffixes like .fs / .vs / .gs (e.g. F# uses .fs).
  return (
    lower.endsWith(".glsl") ||
    lower.endsWith(".frag") ||
    lower.endsWith(".vert") ||
    lower.endsWith(".comp") ||
    lower.endsWith(".geom") ||
    lower.endsWith(".tesc") ||
    lower.endsWith(".tese") ||
    lower.endsWith(".hlsl") ||
    lower.endsWith(".shader") ||
    lower.endsWith(".compute")
  );
}

export function languageForPath(path: string) {
  const lower = path.toLowerCase();
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  ) {
    return javascript({ typescript: lower.includes(".ts") });
  }
  if (lower.endsWith(".json")) return json();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return html();
  if (lower.endsWith(".css") || lower.endsWith(".scss")) return css();
  if (lower.endsWith(".py")) return python();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return markdown();
  if (lower.endsWith(".xml") || lower.endsWith(".svg")) return xml();
  if (lower.endsWith(".sql")) return sql();
  if (lower.endsWith(".erl") || lower.endsWith(".hrl") || lower.endsWith(".escript")) return erlangLike();
  if (isErlangLogPath(path)) return erlangLogLike();
  if (isShaderPath(path)) return glslLike();
  return [];
}

function loadFontSize(): number {
  const n = Number(localStorage.getItem(FONT_STORAGE_KEY));
  if (!Number.isFinite(n)) return FONT_DEFAULT;
  return Math.min(FONT_MAX, Math.max(FONT_MIN, n));
}

function loadLineWrap(): boolean {
  const v = localStorage.getItem(WRAP_STORAGE_KEY);
  if (v === null) return true;
  return v !== "0";
}

const viewerLayoutTheme = EditorView.theme({
  "&": { height: "100%", minWidth: "0" },
  ".cm-scroller": { overflow: "auto", minWidth: "0" },
});

function wrapExtensions(enabled: boolean): Extension[] {
  if (!enabled) return [];
  return [
    EditorView.lineWrapping,
    EditorView.theme({
      ".cm-content, .cm-line": {
        overflowWrap: "anywhere",
        wordBreak: "break-word",
      },
    }),
  ];
}

function fontTheme(size: number): Extension {
  return EditorView.theme({
    "&": { fontSize: `${size}px` },
    ".cm-content": { fontFamily: "ui-monospace, Consolas, 'Courier New', monospace" },
    ".cm-searchMatch": {
      backgroundColor: "rgba(255, 193, 7, 0.38)",
      outline: "1px solid rgba(255, 193, 7, 0.55)",
      borderRadius: "2px",
    },
    ".cm-searchMatch-selected": {
      backgroundColor: "rgba(255, 152, 0, 0.65)",
      outline: "1px solid rgba(255, 193, 7, 0.95)",
      borderRadius: "2px",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "rgba(64, 158, 255, 0.35) !important",
    },
  });
}

const searchMatchMark = Decoration.mark({ class: "cm-searchMatch" });
const searchMatchSelectedMark = Decoration.mark({ class: "cm-searchMatch-selected" });

/** Highlight all current search-query matches (yellow), current one brighter. */
const searchHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate) {
      const queryChanged = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setSearchQuery)),
      );
      if (update.docChanged || update.selectionSet || queryChanged) {
        this.decorations = this.build(update.view);
      }
    }

    build(view: EditorView): DecorationSet {
      const query = getSearchQuery(view.state);
      if (!query.valid || !query.search) return Decoration.none;

      const builder = new RangeSetBuilder<Decoration>();
      const cursor = query.getCursor(view.state);
      const ranges = view.state.selection.ranges;
      let count = 0;
      for (;;) {
        const step = cursor.next();
        if (step.done) break;
        const { from, to } = step.value;
        const selected = ranges.some(
          (r) => (r.from === from && r.to === to) || (r.from <= from && r.to >= to && !r.empty),
        );
        builder.add(from, to, selected ? searchMatchSelectedMark : searchMatchMark);
        if (++count >= 2000) break;
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

export type SearchOptions = {
  search: string;
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
};

/** 行尾空白（含 contenteditable 常用的 nbsp）不参与比较。 */
function stripLineEndSpace(line: string): string {
  return line.replace(/[ \t\u00a0]+$/, "");
}

/**
 * 编辑器里的这一行是否只是被浏览器的 DOM 规范化动过（行尾空白变短或被换成 nbsp），
 * 而不是用户真的在敲字。变长一定是用户输入；内容（去掉行尾空白后）不同也一定是用户输入。
 */
function sameSourceLine(docLine: string, srcLine: string): boolean {
  if (docLine === srcLine) return true;
  if (stripLineEndSpace(docLine) !== stripLineEndSpace(srcLine)) return false;
  return docLine.length <= srcLine.length;
}

/**
 * True when `doc` differs from the file's content `baseline` only in ways the
 * browser can produce on its own. When a contenteditable becomes active (and
 * while it is being edited), Chrome normalizes the DOM: it drops line-end
 * whitespace and rewrites \r\n as \n. CodeMirror reads that DOM back as a
 * document change, so such a difference is NOT a user edit and must never
 * enable 保存.
 *
 * This is deliberately a comparison of content rather than of events: which
 * events a browser emits around its own DOM rewrites is not something we can
 * rely on (Chrome fires a `beforeinput` while activating the editor, which made
 * an earlier timing-based check treat the rewrite as typing).
 */
function isBrowserNormalization(doc: string, baseline: string): boolean {
  if (doc === baseline) return true;
  const a = doc.replace(/\r\n?/g, "\n").split("\n");
  const b = baseline.replace(/\r\n?/g, "\n").split("\n");
  // The browser may drop trailing blank lines the file had …
  while (b.length > a.length && stripLineEndSpace(b[b.length - 1]) === "") b.pop();
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sameSourceLine(a[i], b[i])) return false;
  }
  return true;
}

/** 超过这个长度就不再逐行对齐，直接写编辑器内容（避免在超长文本上反复扫描）。 */
const MERGE_MAX_CHARS = 8 * 1024 * 1024;
/** 行级 LCS 的单元格上限；超过则差异段不做逐行保留（换行风格仍然保留）。 */
const MERGE_LCS_CELLS = 1_000_000;

/** 文件自身的主换行风格：让 CRLF 文件不会因为一次编辑被整体改成 LF。 */
function dominantEol(raw: string): string {
  const crlf = (raw.match(/\r\n/g) || []).length;
  const lf = (raw.match(/\n/g) || []).length - crlf;
  const cr = (raw.match(/\r/g) || []).length - crlf;
  if (crlf > 0 && crlf >= lf && crlf >= cr) return "\r\n";
  if (cr > lf && cr > 0) return "\r";
  return "\n";
}

/**
 * 行级 LCS 对齐差异段。
 * `baseMid` 是进入编辑并稳定后的基准行：相对基准未改的行写回磁盘原文，改过的用编辑器内容。
 */
function alignLines(srcMid: string[], docMid: string[], baseMid: string[]): string[] {
  const a = srcMid.length;
  const b = docMid.length;
  if (a === 0) return docMid.slice();
  if (b === 0) return [];
  if ((a + 1) * (b + 1) > MERGE_LCS_CELLS) return docMid.slice();
  const w = b + 1;
  const dp = new Int32Array((a + 1) * w);
  for (let i = a - 1; i >= 0; i--) {
    for (let j = b - 1; j >= 0; j--) {
      dp[i * w + j] = sameSourceLine(docMid[j], srcMid[i])
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a && j < b) {
    if (sameSourceLine(docMid[j], srcMid[i])) {
      const baseLine = j < baseMid.length ? baseMid[j] : docMid[j];
      out.push(pickMergedLine(srcMid[i], docMid[j], baseLine));
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      i++;
    } else {
      out.push(docMid[j]);
      j++;
    }
  }
  while (j < b) out.push(docMid[j++]);
  return out;
}

/** 相对编辑基准未改 → 磁盘原文；否则 → 编辑器内容（含用户故意删行尾空格）。 */
function pickMergedLine(srcLine: string, docLine: string, baseLine: string): string {
  return docLine === baseLine ? srcLine : docLine;
}

/**
 * 写回磁盘前，把「编辑器里的内容」和「磁盘上的原始文本」合并：只有真正改过的行使用编辑器内容，
 * 其余行沿用磁盘上的原样文本。这样编辑一个 Windows 文件不会把整篇 CRLF 改成 LF，
 * 也不会抹掉未触碰行上的行尾空白（那部分本来只是被 contenteditable 吃掉了，不是用户的修改）。
 * `baseline` 是进入编辑稳定后的编辑器内容，用来区分「浏览器规范化」和「用户故意改行尾」。
 */
function mergeWithSource(raw: string, doc: string, baseline: string): string {
  if (raw.length > MERGE_MAX_CHARS) return doc;
  const rawDoc = raw.replace(/\r\n?/g, "\n");
  if (doc === rawDoc) return raw;
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const srcAll = (bom ? raw.slice(1) : raw).split(/\r\n|\r|\n/);
  const docAll = doc.split("\n");
  const baseAll = baseline.replace(/\r\n?/g, "\n").split("\n");
  if (bom && docAll[0].startsWith("\uFEFF")) docAll[0] = docAll[0].slice(1);

  let tail = 0;
  if (docAll.length >= 2 && docAll[docAll.length - 1] === "") {
    while (
      srcAll.length - tail > docAll.length &&
      stripLineEndSpace(srcAll[srcAll.length - 1 - tail]) === ""
    ) {
      tail++;
    }
  }
  const src = tail > 0 ? srcAll.slice(0, srcAll.length - tail) : srcAll;

  const n = src.length;
  const m = docAll.length;
  let p = 0;
  while (p < n && p < m && sameSourceLine(docAll[p], src[p])) p++;
  let s = 0;
  while (s < n - p && s < m - p && sameSourceLine(docAll[m - 1 - s], src[n - 1 - s])) s++;

  const out: string[] = [];
  for (let i = 0; i < p; i++) {
    out.push(pickMergedLine(src[i], docAll[i], i < baseAll.length ? baseAll[i] : docAll[i]));
  }
  for (const line of alignLines(
    src.slice(p, n - s),
    docAll.slice(p, m - s),
    baseAll.slice(p, Math.max(p, baseAll.length - s)),
  )) {
    out.push(line);
  }
  for (let i = n - s; i < n; i++) {
    const di = m - (n - i);
    out.push(pickMergedLine(src[i], docAll[di], di < baseAll.length ? baseAll[di] : docAll[di]));
  }
  for (let i = srcAll.length - tail; i < srcAll.length; i++) out.push(srcAll[i]);

  const eol = dominantEol(raw);
  const trailingNewline = doc.endsWith("\n");
  const last = out[out.length - 1];
  const body = trailingNewline && last === "" ? out.slice(0, -1) : out;
  return bom + body.join(eol) + (trailingNewline ? eol : "");
}

export class CodePane {
  readonly view: EditorView;
  private currentPath = "";
  private baseline = "";
  /** 磁盘上的原始文本（保留 CRLF / 行尾空白 / BOM），保存时用来做逐行合并。 */
  private diskContent = "";
  private dirtyFlag = false;
  private editable = false;
  /** Absorb contenteditable DOM rewrites for a short window after entering edit. */
  private settleUntil = 0;
  private fontSize = loadFontSize();
  private lineWrap = loadLineWrap();
  private readonly fontCompartment = new Compartment();
  private readonly wrapCompartment = new Compartment();
  private readonly onFontChange?: (size: number) => void;
  private readonly onFocusSearch?: () => void;
  private readonly onDirtyChange?: (dirty: boolean) => void;

  constructor(
    parent: HTMLElement,
    opts?: {
      onFontChange?: (size: number) => void;
      onFocusSearch?: () => void;
      onDirtyChange?: (dirty: boolean) => void;
    },
  ) {
    this.onFontChange = opts?.onFontChange;
    this.onFocusSearch = opts?.onFocusSearch;
    this.onDirtyChange = opts?.onDirtyChange;
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "",
        extensions: this.baseExtensions(""),
      }),
    });
    parent.addEventListener(
      "wheel",
      (ev) => {
        if (!parent.contains(ev.target as Node)) return;
        // 仅 Ctrl/Cmd + 滚轮缩放，普通滚轮留给编辑器滚动
        if (ev.ctrlKey || ev.metaKey) {
          ev.preventDefault();
          this.bumpFont(ev.deltaY < 0 ? 1 : -1);
        }
      },
      { passive: false },
    );
  }

  private emitDirty(dirty: boolean): void {
    if (this.dirtyFlag === dirty) {
      this.onDirtyChange?.(dirty);
      return;
    }
    this.dirtyFlag = dirty;
    this.onDirtyChange?.(dirty);
  }

  /** 保存可用 ⟺ 相对编辑基准有实质改动（冷静期内忽略浏览器 DOM 规范化）。 */
  private recomputeDirty(): void {
    if (!this.editable) {
      this.emitDirty(false);
      return;
    }
    const doc = this.view.state.doc.toString();
    if (performance.now() < this.settleUntil) {
      if (isBrowserNormalization(doc, this.baseline) || doc === this.baseline) {
        this.baseline = doc;
        this.emitDirty(false);
        return;
      }
      this.emitDirty(true);
      return;
    }
    // 冷静期后：换行已统一，行尾空格差异也算用户修改
    this.emitDirty(doc !== this.baseline);
  }

  private baseExtensions(path: string, content = "") {
    return [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      history(),
      foldGutter(),
      bracketMatching(),
      highlightSelectionMatches(),
      viewerLayoutTheme,
      this.wrapCompartment.of(wrapExtensions(this.lineWrap)),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      oneDark,
      // Search state without using the built-in hideable panel.
      search({}),
      searchHighlighter,
      this.fontCompartment.of(fontTheme(this.fontSize)),
      EditorView.editable.of(this.editable),
      EditorState.readOnly.of(!this.editable),
      EditorView.updateListener.of((update) => {
        if (!this.editable || !update.docChanged) return;
        // Runs after CodeMirror applied the change; the content comparison itself
        // decides whether it was a real edit or just the browser normalizing its DOM.
        this.recomputeDirty();
      }),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...searchKeymap.filter((b) => b.key !== "Mod-f" && b.key !== "Mod-Shift-f"),
        {
          key: "Mod-f",
          run: () => {
            this.onFocusSearch?.();
            return true;
          },
        },
        {
          key: "Mod-d",
          run: (view) => copyLineDown(view),
        },
        {
          key: "Mod-=",
          run: () => {
            this.bumpFont(1);
            return true;
          },
        },
        {
          key: "Mod-+",
          run: () => {
            this.bumpFont(1);
            return true;
          },
        },
        {
          key: "Mod--",
          run: () => {
            this.bumpFont(-1);
            return true;
          },
        },
        {
          key: "Mod-0",
          run: () => {
            this.setFontSize(FONT_DEFAULT);
            return true;
          },
        },
        {
          key: "Mod-s",
          run: () => {
            // Handled by main UI; keep focus behavior consistent.
            return false;
          },
        },
      ]),
      ...(content.length <= LARGE_FILE_BYTES ? [languageForPath(path)] : []),
    ];
  }

  private remount(text: string, editable: boolean): void {
    const selection = this.view.state.selection;
    this.editable = editable;
    this.view.setState(
      EditorState.create({
        doc: text,
        selection,
        extensions: this.baseExtensions(this.currentPath, text),
      }),
    );
    this.baseline = this.view.state.doc.toString();
    this.emitDirty(false);
  }

  setFile(path: string, content: string): void {
    this.currentPath = path;
    this.editable = false;
    this.settleUntil = 0;
    this.view.setState(
      EditorState.create({
        doc: content,
        extensions: this.baseExtensions(path, content),
      }),
    );
    // CodeMirror normalizes \r\n/\r to \n — baseline must match the doc, not the raw input.
    this.baseline = this.view.state.doc.toString();
    this.diskContent = content;
    this.emitDirty(false);
  }

  setEditable(editable: boolean): void {
    if (this.editable === editable) return;
    // Remount instead of toggling editable in-place: a fresh state + DOM gives the
    // browser no half-converted contenteditable to rewrite, and the baseline is
    // re-derived from the document, so entering edit mode always starts clean.
    this.remount(this.view.state.doc.toString(), editable);
    if (editable) {
      this.settleUntil = performance.now() + 500;
      this.view.focus();
      const absorb = () => {
        if (!this.editable) return;
        const doc = this.view.state.doc.toString();
        if (isBrowserNormalization(doc, this.baseline) || doc === this.baseline) {
          this.baseline = doc;
          this.emitDirty(false);
        }
      };
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          absorb();
          setTimeout(absorb, 80);
          setTimeout(() => {
            absorb();
            this.settleUntil = 0;
            this.recomputeDirty();
          }, 500);
        });
      });
    } else {
      this.settleUntil = 0;
    }
  }

  isEditable(): boolean {
    return this.editable;
  }

  getContent(): string {
    return this.view.state.doc.toString();
  }

  /**
   * 真正要写回磁盘的内容：在编辑器内容的基础上做逐行合并，未编辑的行保留原样
   * （CRLF、行尾空白、BOM 都不会因为一次编辑被整篇改写）。
   */
  getSaveContent(): string {
    return mergeWithSource(this.diskContent, this.getContent(), this.baseline);
  }

  isDirty(): boolean {
    return this.dirtyFlag;
  }

  markClean(writtenContent?: string): void {
    // diskContent 必须与刚刚写回磁盘的内容一致，否则下一次保存会拿旧的原始文本去合并。
    this.diskContent = writtenContent ?? this.getSaveContent();
    this.baseline = this.getContent();
    this.emitDirty(false);
  }

  revert(): void {
    const current = this.getContent();
    if (current === this.baseline || isBrowserNormalization(current, this.baseline)) {
      this.baseline = current === this.baseline ? this.baseline : current;
      this.emitDirty(false);
      return;
    }
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: this.baseline },
      userEvent: "revert",
    });
    this.emitDirty(false);
  }

  applySearch(opts: SearchOptions): void {
    const query = new SearchQuery({
      search: opts.search,
      caseSensitive: opts.caseSensitive,
      regexp: opts.regexp,
      wholeWord: opts.wholeWord,
    });
    this.view.dispatch({ effects: setSearchQuery.of(query) });
  }

  findNext(): boolean {
    return findNext(this.view);
  }

  findPrevious(): boolean {
    return findPrevious(this.view);
  }

  findAll(): number {
    const ranges = this.collectMatches(1000);
    if (ranges.length === 0) return 0;
    this.view.dispatch({
      selection: EditorSelection.create(ranges.map((r) => EditorSelection.range(r.from, r.to))),
      userEvent: "select.search.matches",
    });
    return ranges.length;
  }

  countMatches(limit = 1000): number {
    return this.collectMatches(limit).length;
  }

  listMatches(limit = 500): { from: number; to: number; line: number; text: string }[] {
    const ranges = this.collectMatches(limit);
    return ranges.map((r) => {
      const line = this.view.state.doc.lineAt(r.from);
      const col = r.from - line.from;
      const snippetStart = Math.max(0, col - 40);
      const snippetEnd = Math.min(line.text.length, col + (r.to - r.from) + 80);
      let text = line.text.slice(snippetStart, snippetEnd);
      if (snippetStart > 0) text = "…" + text;
      if (snippetEnd < line.text.length) text = text + "…";
      return {
        from: r.from,
        to: r.to,
        line: line.number,
        text,
      };
    });
  }

  jumpToMatch(from: number, to: number): void {
    this.view.dispatch({
      selection: EditorSelection.range(from, to),
      effects: EditorView.scrollIntoView(from, { y: "center" }),
      userEvent: "select.search",
    });
    this.view.focus();
  }

  private collectMatches(limit: number): { from: number; to: number }[] {
    const query = getSearchQuery(this.view.state);
    if (!query.valid) return [];
    const ranges: { from: number; to: number }[] = [];
    const cursor = query.getCursor(this.view.state);
    for (let i = 0; i < limit; i++) {
      const step = cursor.next();
      if (step.done) break;
      ranges.push(step.value);
    }
    return ranges;
  }

  bumpFont(delta: number): void {
    this.setFontSize(this.fontSize + delta);
  }

  setFontSize(size: number): void {
    const next = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(size)));
    if (next === this.fontSize) {
      this.onFontChange?.(next);
      return;
    }
    this.fontSize = next;
    localStorage.setItem(FONT_STORAGE_KEY, String(next));
    this.view.dispatch({
      effects: this.fontCompartment.reconfigure(fontTheme(next)),
    });
    this.onFontChange?.(next);
  }

  getFontSize(): number {
    return this.fontSize;
  }

  getLineWrap(): boolean {
    return this.lineWrap;
  }

  setLineWrap(enabled: boolean): void {
    if (enabled === this.lineWrap) return;
    this.lineWrap = enabled;
    localStorage.setItem(WRAP_STORAGE_KEY, enabled ? "1" : "0");
    this.view.dispatch({
      effects: this.wrapCompartment.reconfigure(wrapExtensions(enabled)),
    });
  }

  async copySelectionOrAll(): Promise<boolean> {
    const sel = this.view.state.sliceDoc(
      this.view.state.selection.main.from,
      this.view.state.selection.main.to,
    );
    const text = sel.length > 0 ? sel : this.view.state.doc.toString();
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  get path(): string {
    return this.currentPath;
  }
}
