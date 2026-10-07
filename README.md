# fviewer

网页文件浏览器：Erlang（eWSrv WebSocket）后端 + TypeScript 前端，打包成单个 escript。

## 功能

- 左侧目录树：返回上级、刷新、点击目录展开、点击文件打开
- 右侧只读编辑器：语法高亮、搜索、选中、复制、字体缩放、**下载 / 上传**
- 表格：Excel（xlsx/xls…）、CSV/TSV
- 文档：Word（docx，旧版 doc 尽力提取）、PDF、ODT、RTF、常见图片
- 单文件读取上限 32MB（避免超大文件撑爆内存 / WebSocket）
- 启动时以当前工作目录为浏览起点，可继续返回上级
- 固定节点名 `fviewer`，避免重复启动两个实例
- 默认 30 分钟无 HTTP/WebSocket 活动自动退出（`--idle-timeout 0` 可关闭）

**安全提示**：服务默认监听 `0.0.0.0`（局域网可访问），无鉴权，可读取进程 cwd 可达路径下的文件。仅供本地/可信网络使用；公网部署请自行加防火墙或改绑定地址。

## 开发

```sh
# 首次需要安装前端依赖（之后 rebar3 会在缺 node_modules 时自动 npm install）
cd frontend && npm install && cd ..

# compile / escriptize 会通过 pre_hooks 顺带执行前端构建（有变更才重建）
rebar3 compile
rebar3 escriptize

# 跳过前端构建：
# Windows: set FVIEWER_SKIP_FRONTEND=1 && rebar3 compile
# Unix:    FVIEWER_SKIP_FRONTEND=1 rebar3 compile
```

浏览器打开 <http://127.0.0.1:8989/> 。

## 打包

```sh
rebar3 escriptize
```

产物：`_build/default/bin/fviewer`

### 命令行参数

| 参数 | 说明 |
|------|------|
| `--port N` | 监听端口（默认 `8989`） |
| `--dir PATH` | 浏览根目录（默认启动时 cwd） |
| `--idle-timeout SECS` | 无 HTTP/WebSocket 活动多少秒后自动退出（默认 `1800` = 30 分钟）；`0` = 不自动退出 |
| `PORT` | 位置参数，等价于 `--port PORT` |

```sh
# 直接运行（默认端口 8989，cwd 为根，30 分钟无访问自动退出）
_build/default/bin/fviewer

# 指定端口与目录
_build/default/bin/fviewer --port 9000 --dir /path/to/root
_build/default/bin/fviewer 9000

# 常驻运行（不因空闲自动退出）
_build/default/bin/fviewer --idle-timeout 0

# 5 分钟无访问自动退出
_build/default/bin/fviewer --idle-timeout 300
```

## 从其他 Erlang 节点启动

优先用 `open_port`（非阻塞、可监控子进程、可主动关闭），而不是 `os:cmd`：

```erlang
%% 启动：ListenPort 为 HTTP 端口；返回的 PortRef 是 Erlang port（用于关闭子进程）
{ok, PortRef} = fviewer:start_external(8989, #{
    escript => "/abs/path/to/fviewer",
    dir => "/path/to/browse",
    idle_timeout => 1800   %% 可选，秒；省略则默认 30 分钟；0 = 不自动退出
}).

%% 建议：存下 PortRef，需要时关闭
ok = fviewer:stop_external(PortRef).

%% 也可 monitor 子进程退出
monitor(port, PortRef),
receive
    {'DOWN', _, port, PortRef, _} -> ok
end.
```

### Linux / macOS：直接 spawn escript

```erlang
PortRef = open_port(
    {spawn_executable, "/abs/path/to/fviewer"},
    [{args, ["8989", "--dir", "/path", "--idle-timeout", "1800"]},
     {cd, "/path"}, binary, exit_status, stderr_to_stdout]
).
ok = fviewer:stop_external(PortRef).
```

### Windows：用 `escript.exe` + fviewer 路径

Windows 下 `spawn_executable` 不能直接跑无扩展名的 escript，需用当前 Erlang 自带的 `escript.exe`，**第一个参数**为 fviewer 脚本路径：

```erlang
FviewerEscript = "F:/fviewer/_build/default/bin/fviewer",
BrowseDir      = "F:/path/to/browse",
EscriptExe     = filename:join([code:root_dir(), "bin", "escript.exe"]),

PortRef = open_port(
    {spawn_executable, EscriptExe},
    [
        {args, [
            FviewerEscript,
            "8989",
            "--dir", BrowseDir,
            "--idle-timeout", "1800"
        ]},
        {cd, BrowseDir},
        binary,
        exit_status,
        stderr_to_stdout
    ]
).
ok = fviewer:stop_external(PortRef).
```

等价命令行：

```text
escript.exe F:/fviewer/_build/default/bin/fviewer 8989 --dir F:/path/to/browse --idle-timeout 1800
```

`stop_external/1` 内部调用 `erlang:port_close/1`，会终止对应的 fviewer OS 进程。

`os:cmd` 会阻塞到子进程结束，且不易监控生命周期，不适合常驻服务。

## 上传 / 下载：与 eWSrv 测试页对比

eWSrv 自带的 `wsTPHer` 测试页（`GET /` → `priv/test.html`）走的是 **HTTP**，不是 WebSocket 传文件：

| 能力 | eWSrv `wsTPHer` 测试后端 | fviewer 现在 |
|------|--------------------------|--------------|
| 下载 | `GET /file`：`file:read_file/1` 读**整个文件**，HTTP 响应体返回；`GET /range` 支持 Range 分片 | WebSocket `read`：`fviewer_fs:read_file/1` 读**整个文件**（≤32MB），JSON 里带 `content`（文本 utf8 或二进制 base64）；前端再触发浏览器下载 |
| 上传 | `POST /upload`：只检查 `multipart/form-data`，读**整个 body**，**不落盘**，仅回显字节数 | WebSocket `write`：JSON 里带**整个文件**内容（utf8/base64），`fviewer_fs:write_file/3` 解码后 `file:write_file/2` 一次写入 |
| 分块 / 流式 | HTTP `GET /stream`、`/chunk` 有流式演示，但与文件上传下载无关 | 无；单文件整包读写 |
| WebSocket | `handleWs` 只做 echo/time/chat 等文本消息 | 目录树、`read`/`write` 等 JSON 协议 |

结论：

- **eWSrv 测试页的上传并不是真正把文件写到磁盘**，只是 HTTP 上传接口的占位实现。
- **fviewer 的上传/下载也是整文件读写**，只是改成了 WebSocket JSON（`read` / `write`），并加了 32MB 上限与 base64 二进制支持。
- 若以后要支持超大文件或断点续传，需要在协议层增加分块（chunk）、offset、或单独 HTTP 上传端点，而不是一次 `read`/`write` 整个文件。

## WebSocket 协议（JSON）

客户端 → 服务端：

| op | 字段 |
|----|------|
| `hello` | |
| `list` | `path?`, `id?`（客户端回传，用于区分上传目录树等） |
| `read` | `path` |
| `write` | `path`, `encoding` (`utf8` / `base64`), `content` |
| `parent` | `path` |
| `stat` | `path` |

服务端 → 客户端：`hello` / `list` / `file` / `written` / `stat` / `error`
