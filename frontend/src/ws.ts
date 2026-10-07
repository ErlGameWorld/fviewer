export type DirEntry = {
  name: string;
  type: "dir" | "file";
  size: number;
  mtime: number;
  hidden?: boolean;
};

export type ServerMsg =
  | {
      op: "hello";
      cwd: string;
      node: string;
      roots?: string[];
    }
  | {
      op: "list";
      path: string;
      parent: string;
      entries: DirEntry[];
      id?: string;
    }
  | {
      op: "file";
      path: string;
      size: number;
      encoding: string;
      content: string;
    }
  | {
      op: "written";
      path: string;
      size: number;
    }
  | {
      op: "stat";
      path: string;
      parent: string;
      type: string;
      size: number;
      mtime: number;
    }
  | {
      op: "roots";
      roots: string[];
    }
  | {
      op: "error";
      message: string;
    };

export type ClientMsg =
  | { op: "hello" }
  | { op: "list"; path?: string; id?: string }
  | { op: "read"; path: string }
  | { op: "write"; path: string; encoding: "base64" | "utf8" | "latin1"; content: string }
  | { op: "parent"; path: string }
  | { op: "stat"; path: string }
  | { op: "roots" };

type Handler = (msg: ServerMsg) => void;

export class FviewerSocket {
  private ws: WebSocket | null = null;
  private readonly onMessage: Handler;
  private readonly onStatus: (ok: boolean) => void;
  private retry = 0;
  private closed = false;

  constructor(onMessage: Handler, onStatus: (ok: boolean) => void) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
  }

  connect(): void {
    this.closed = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.onStatus(true);
      this.send({ op: "hello" });
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as ServerMsg;
        this.onMessage(msg);
      } catch {
        this.onMessage({ op: "error", message: "invalid server message" });
      }
    };

    ws.onclose = () => {
      this.onStatus(false);
      if (!this.closed) {
        const delay = Math.min(8000, 500 * 2 ** this.retry++);
        setTimeout(() => this.connect(), delay);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
