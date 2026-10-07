import * as XLSX from "xlsx";

function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return String(v);
}

export class SheetPane {
  private readonly root: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly tableWrap: HTMLElement;
  private workbook: XLSX.WorkBook | null = null;
  private activeSheet = "";

  constructor(parent: HTMLElement) {
    parent.innerHTML = `
      <div class="sheet-tabs" id="sheetTabs"></div>
      <div class="sheet-table-wrap" id="sheetTableWrap"></div>
    `;
    this.root = parent;
    this.tabs = parent.querySelector("#sheetTabs") as HTMLElement;
    this.tableWrap = parent.querySelector("#sheetTableWrap") as HTMLElement;
  }

  open(data: ArrayBuffer): void {
    this.workbook = XLSX.read(data, { type: "array", cellDates: true });
    const names = this.workbook.SheetNames;
    this.activeSheet = names[0] ?? "";
    this.renderTabs();
    this.renderSheet();
  }

  openCsv(text: string, path: string): void {
    const fs = path.toLowerCase().endsWith(".tsv") ? "\t" : ",";
    this.workbook = XLSX.read(text, { type: "string", FS: fs, raw: false });
    const names = this.workbook.SheetNames;
    this.activeSheet = names[0] ?? "";
    this.renderTabs();
    this.renderSheet();
  }

  clear(showEmpty = false): void {
    this.workbook = null;
    this.activeSheet = "";
    this.tabs.innerHTML = "";
    this.tableWrap.innerHTML = showEmpty
      ? `<div class="empty">无法解析表格</div>`
      : "";
  }

  private renderTabs(): void {
    if (!this.workbook) return;
    this.tabs.innerHTML = "";
    for (const name of this.workbook.SheetNames) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sheet-tab" + (name === this.activeSheet ? " active" : "");
      btn.textContent = name;
      btn.addEventListener("click", () => {
        this.activeSheet = name;
        this.renderTabs();
        this.renderSheet();
      });
      this.tabs.appendChild(btn);
    }
  }

  private renderSheet(): void {
    if (!this.workbook || !this.activeSheet) {
      this.clear(true);
      return;
    }
    const sheet = this.workbook.Sheets[this.activeSheet];
    if (!sheet) {
      this.clear(true);
      return;
    }

    const rows = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(sheet, {
      header: 1,
      defval: "",
      raw: false,
    }) as unknown[][];

    const table = document.createElement("table");
    table.className = "sheet-table";

    const rawMaxCols = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
    const maxColsLimit = 200;
    const maxCols = Math.min(rawMaxCols, maxColsLimit);
    if (maxCols === 0) {
      this.tableWrap.innerHTML = `<div class="empty">空工作表</div>`;
      return;
    }

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    const corner = document.createElement("th");
    corner.className = "row-num";
    corner.textContent = "";
    headRow.appendChild(corner);
    for (let c = 0; c < maxCols; c++) {
      const th = document.createElement("th");
      th.textContent = XLSX.utils.encode_col(c);
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    const limit = Math.min(rows.length, 5000);
    for (let r = 0; r < limit; r++) {
      const tr = document.createElement("tr");
      const rn = document.createElement("th");
      rn.className = "row-num";
      rn.textContent = String(r + 1);
      tr.appendChild(rn);
      const row = (rows[r] as unknown[]) || [];
      for (let c = 0; c < maxCols; c++) {
        const td = document.createElement("td");
        td.textContent = cellText(row[c]);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    this.tableWrap.innerHTML = "";
    this.tableWrap.appendChild(table);
    if (rows.length > limit || rawMaxCols > maxColsLimit) {
      const note = document.createElement("div");
      note.className = "sheet-note";
      const parts: string[] = [];
      if (rows.length > limit) parts.push(`仅显示前 ${limit} 行（共 ${rows.length} 行）`);
      if (rawMaxCols > maxColsLimit) parts.push(`仅显示前 ${maxColsLimit} 列（共 ${rawMaxCols} 列）`);
      note.textContent = parts.join("；");
      this.tableWrap.appendChild(note);
    }
  }

  setFontSize(px: number): void {
    this.root.style.setProperty("--sheet-font-size", `${px}px`);
  }
}

export function isSpreadsheetPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.endsWith(".xlsx") ||
    lower.endsWith(".xls") ||
    lower.endsWith(".xlsm") ||
    lower.endsWith(".xlsb")
  );
}
