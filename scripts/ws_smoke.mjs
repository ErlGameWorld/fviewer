const ws = new WebSocket("ws://127.0.0.1:8989/ws");

ws.addEventListener("open", () => {
  console.log("WS_OPEN");
  ws.send(JSON.stringify({ op: "hello" }));
});

ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(String(ev.data));
  console.log("MSG", msg.op, msg.cwd || msg.path || msg.message || "");
  if (msg.op === "hello") {
    ws.send(JSON.stringify({ op: "list", path: msg.cwd }));
  } else if (msg.op === "list") {
    console.log("ENTRIES", (msg.entries || []).length);
    const file = (msg.entries || []).find((e) => e.type === "file");
    if (!file) {
      console.log("WS_OK_NO_FILE");
      ws.close();
      process.exit(0);
    }
    const sep = msg.path.includes("\\") ? "\\" : "/";
    const p =
      msg.path.endsWith("\\") || msg.path.endsWith("/")
        ? msg.path + file.name
        : msg.path + sep + file.name;
    ws.send(JSON.stringify({ op: "read", path: p }));
  } else if (msg.op === "file") {
    console.log(
      "FILE",
      msg.path,
      "size",
      msg.size,
      "encoding",
      msg.encoding,
      "content_len",
      msg.content.length,
    );
    console.log("WS_OK");
    ws.close();
    process.exit(0);
  } else if (msg.op === "error") {
    console.error("WS_ERR", msg.message);
    process.exit(1);
  }
});

ws.addEventListener("error", () => {
  console.error("WS_ERROR");
  process.exit(1);
});

setTimeout(() => {
  console.error("TIMEOUT");
  process.exit(1);
}, 8000);
