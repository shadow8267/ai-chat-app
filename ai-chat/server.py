"""Local static server, CORS proxy, logs, and LAN sync for AI Chat."""
from __future__ import annotations

import http.client
import json
import mimetypes
import os
import secrets
import socket
import ssl
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
LOG_DIR = ROOT / "logs"
LOG_FILE = LOG_DIR / "ai-chat.log"
SYNC_FILE = ROOT / "sync-state.json"
SYNC_TOKEN_FILE = ROOT / "sync-token.txt"
SYNC_BACKUP_DIR = ROOT / "logs" / "sync-backups"
MAX_SYNC_BACKUPS = 20
MAX_LOGS = 800
SYNC_LOCK = threading.Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def load_logs() -> list[dict]:
    if not LOG_FILE.exists():
        return []
    entries = []
    for line in LOG_FILE.read_text(encoding="utf-8").splitlines():
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return entries[-MAX_LOGS:]


def append_log(entry: dict) -> None:
    LOG_DIR.mkdir(exist_ok=True)
    entry = {"time": now_iso(), **entry}
    with LOG_FILE.open("a", encoding="utf-8") as file:
        file.write(json.dumps(entry, ensure_ascii=False) + "\n")
    if LOG_FILE.stat().st_size > 1_500_000:
        recent = load_logs()[-MAX_LOGS:]
        LOG_FILE.write_text("".join(json.dumps(item, ensure_ascii=False) + "\n" for item in recent), encoding="utf-8")


def get_sync_token() -> str:
    if SYNC_TOKEN_FILE.exists():
        return SYNC_TOKEN_FILE.read_text(encoding="utf-8").strip()
    token = secrets.token_urlsafe(18)
    SYNC_TOKEN_FILE.write_text(token, encoding="utf-8")
    return token


def get_lan_ips() -> tuple[str | None, list[str]]:
    """Return the default-route IPv4 first, then other non-loopback addresses."""
    addresses: set[str] = set()
    primary: str | None = None
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("192.0.2.1", 80))
        primary = probe.getsockname()[0]
        probe.close()
        if not primary.startswith(("127.", "169.254.")):
            addresses.add(primary)
    except OSError:
        primary = None
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith(("127.", "169.254.")):
                addresses.add(ip)
    except socket.gaierror:
        pass
    return primary if primary in addresses else None, sorted(addresses)


def default_sync_state() -> dict:
    return {"revision": 0, "updatedAt": "", "updatedBy": "", "data": {}}


def load_sync_state() -> dict:
    if not SYNC_FILE.exists():
        return default_sync_state()
    try:
        state = json.loads(SYNC_FILE.read_text(encoding="utf-8"))
        return state if isinstance(state, dict) and isinstance(state.get("data"), dict) else default_sync_state()
    except (OSError, json.JSONDecodeError):
        return default_sync_state()


def save_sync_state(state: dict) -> None:
    if SYNC_FILE.exists():
        backup_name = f"sync-{state.get('revision', 0)}-{int(datetime.now().timestamp() * 1000)}.json"
        backup_path = SYNC_BACKUP_DIR / backup_name
        try:
            SYNC_BACKUP_DIR.mkdir(parents=True, exist_ok=True)
            backup_path.write_text(SYNC_FILE.read_text(encoding="utf-8"), encoding="utf-8")
            prune_old_backups()
        except OSError:
            pass
    temporary = SYNC_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, SYNC_FILE)


def prune_old_backups() -> None:
    if not SYNC_BACKUP_DIR.exists():
        return
    backups = sorted(SYNC_BACKUP_DIR.glob("sync-*.json"))
    for old in backups[:-MAX_SYNC_BACKUPS]:
        try:
            old.unlink()
        except OSError:
            pass


def list_sync_backups() -> list[dict]:
    if not SYNC_BACKUP_DIR.exists():
        return []
    result = []
    for path in sorted(SYNC_BACKUP_DIR.glob("sync-*.json")):
        try:
            with path.open(encoding="utf-8") as file:
                state = json.load(file)
            data = state.get("data", {}) if isinstance(state, dict) else {}
            result.append({
                "file": path.name,
                "revision": int(state.get("revision", 0)),
                "updatedAt": state.get("updatedAt", ""),
                "updatedBy": state.get("updatedBy", ""),
                "conversationCount": len(data.get("conversations", []) or []) if isinstance(data, dict) else 0,
            })
        except (OSError, json.JSONDecodeError):
            continue
    return list(reversed(result))


def restore_sync_backup(file_name: str) -> dict | None:
    if not file_name or "/" in file_name or "\\" in file_name or ".." in file_name:
        return None
    backup_path = SYNC_BACKUP_DIR / file_name
    if not backup_path.exists():
        return None
    try:
        with backup_path.open(encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def sanitize_sync_data(data: object) -> dict:
    if not isinstance(data, dict):
        return {}
    result = {}
    for name in ("conversations", "activeConv", "params", "theme", "reading"):
        if name in data:
            result[name] = data[name]
    if isinstance(data.get("configs"), list):
        result["configs"] = [{key: value for key, value in item.items() if key != "key"} for item in data["configs"] if isinstance(item, dict)]
    if "activeConfig" in data:
        result["activeConfig"] = data["activeConfig"]
    return result


class ChatHandler(SimpleHTTPRequestHandler):
    server_version = "AIChatLANServer/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format: str, *args) -> None:
        return

    def _send_json(self, status: int, payload: dict, cors: bool = False) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        if cors:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-AI-Chat-Token")
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            value = json.loads(raw.decode("utf-8"))
            return value if isinstance(value, dict) else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            return {}

    def _sync_authorized(self) -> bool:
        return secrets.compare_digest(self.headers.get("X-AI-Chat-Token", ""), get_sync_token())

    def _handle_proxy(self) -> None:
        payload = self._read_json()
        target_url = payload.get("url", "")
        method = (payload.get("method") or "POST").upper()
        req_headers = payload.get("headers") or {}
        req_body = payload.get("body") or ""
        if not target_url:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "url is required"}, True)
            return
        parsed = urlparse(target_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "only absolute http/https URLs are allowed"}, True)
            return
        if method not in ("GET", "POST", "PUT", "PATCH", "DELETE"):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "unsupported proxy method"}, True)
            return
        host = parsed.hostname
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        conn = http.client.HTTPSConnection(host, port, context=ssl.create_default_context(), timeout=120) if parsed.scheme == "https" else http.client.HTTPConnection(host, port, timeout=120)
        clean_headers = {k: v for k, v in req_headers.items() if k.lower() not in ("host", "content-length", "transfer-encoding", "connection")}
        try:
            conn.request(method, path, body=req_body.encode("utf-8") if req_body else None, headers=clean_headers)
            resp = conn.getresponse()
            self.send_response(resp.status)
            for key, value in resp.headers.items():
                if key.lower() not in ("transfer-encoding", "content-length", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade"):
                    self.send_header(key, value)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            stream = getattr(resp, "read1", resp.read)
            while chunk := stream(1024):
                self.wfile.write(chunk)
                self.wfile.flush()
        except ConnectionError as exc:
            # 客户端主动断开（停止生成 / 关页面 / 切换会话）或上游中途掐断。
            # 这里必须覆盖整个 ConnectionError 家族：BrokenPipe、ConnectionReset 之外
            # 还有 WinError 10053 对应的 ConnectionAbortedError —— 只列前两个会漏掉它，
            # 掉到下面的兜底分支后会往已经断开的 socket 写响应，再抛一次异常。
            append_log({"kind": "proxy", "event": "stream_broken", "message": f"代理流式传输中断：{type(exc).__name__}: {exc}", "details": {"host": host, "url": target_url}})
        except Exception as exc:
            append_log({"kind": "proxy", "event": "failed", "message": f"代理请求失败：{type(exc).__name__}: {exc}", "details": {"host": host, "url": target_url, "method": method}})
            # 回错误也要防护：此时连接可能已经不可写，不能再让异常逸出
            try:
                if not self.wfile.closed:
                    self._send_json(HTTPStatus.BAD_GATEWAY, {"error": f"Proxy error: {exc}"}, True)
            except Exception:
                pass
        finally:
            conn.close()

    def do_OPTIONS(self) -> None:
        if urlparse(self.path).path in ("/api/proxy", "/api/sync", "/api/logs", "/api/logs/clear", "/api/open-data-folder"): 
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-AI-Chat-Token")
            self.end_headers()
            return
        super().do_OPTIONS()

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/ping":
            self._send_json(HTTPStatus.OK, {"ok": True, "serverTime": now_iso()}, True)
            return
        if path == "/api/logs":
            self._send_json(HTTPStatus.OK, {"logs": load_logs()}, True)
            return
        if path == "/api/data-folder":
            self._send_json(HTTPStatus.OK, {"ok": True, "path": str(ROOT), "logs": str(LOG_DIR), "sync": str(SYNC_FILE)}, True)
            return
        if path == "/api/sync":
            if not self._sync_authorized():
                self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "sync token invalid"}, True)
                return
            with SYNC_LOCK:
                state = load_sync_state()
            self._send_json(HTTPStatus.OK, state, True)
            return
        super().do_GET()
        if not path.startswith("/api/"):
            append_log({"kind": "access", "method": "GET", "path": path or "/", "client": self.client_address[0]})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/proxy":
            self._handle_proxy()
            return
        if path == "/api/logs":
            payload = self._read_json()
            entry = payload.get("entry")
            if not isinstance(entry, dict):
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "entry must be an object"})
                return
            append_log({"kind": str(entry.get("kind", "operation"))[:30], "event": str(entry.get("event", "unknown"))[:80], "message": str(entry.get("message", ""))[:500], "details": entry.get("details", {}), "payload": entry.get("payload", {})})
            self._send_json(HTTPStatus.CREATED, {"ok": True}, True)
            return
        if path == "/api/logs/clear":
            LOG_DIR.mkdir(exist_ok=True)
            LOG_FILE.write_text("", encoding="utf-8")
            self._send_json(HTTPStatus.OK, {"ok": True}, True)
            return
        if path == "/api/open-data-folder":
            try:
                if os.name == "nt":
                    os.startfile(str(ROOT))
                elif os.name == "posix":
                    subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(ROOT)])
                self._send_json(HTTPStatus.OK, {"ok": True, "path": str(ROOT)}, True)
            except (OSError, NameError) as exc:
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc), "path": str(ROOT)}, True)
            return
        if path == "/api/sync":
            if not self._sync_authorized():
                self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "sync token invalid"}, True)
                return
            payload = self._read_json()
            clean_data = sanitize_sync_data(payload.get("data"))
            if not clean_data:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "sync data missing"}, True)
                return
            with SYNC_LOCK:
                state = load_sync_state()
                state["revision"] = int(state.get("revision", 0)) + 1
                state["updatedAt"] = now_iso()
                state["updatedBy"] = str(payload.get("deviceId", "unknown"))[:80]
                state["data"] = clean_data
                save_sync_state(state)
            append_log({"kind": "sync", "event": "state_updated", "message": f"同步数据已由 {state['updatedBy']} 更新", "details": {"revision": state["revision"]}})
            self._send_json(HTTPStatus.OK, state, True)
            return
        if path == "/api/sync/backups":
            if not self._sync_authorized():
                self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "sync token invalid"}, True)
                return
            self._send_json(HTTPStatus.OK, {"backups": list_sync_backups()}, True)
            return
        if path == "/api/sync/restore":
            if not self._sync_authorized():
                self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "sync token invalid"}, True)
                return
            payload = self._read_json()
            file_name = str(payload.get("file", "")).strip()
            restored = restore_sync_backup(file_name)
            if not restored:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "backup not found"}, True)
                return
            with SYNC_LOCK:
                state = load_sync_state()
                state["revision"] = int(state.get("revision", 0)) + 1
                state["updatedAt"] = now_iso()
                state["updatedBy"] = str(payload.get("deviceId", "unknown"))[:80]
                state["data"] = restored.get("data", {})
                save_sync_state(state)
            append_log({"kind": "sync", "event": "state_restored", "message": f"同步数据已由 {state['updatedBy']} 从备份 {file_name} 恢复", "details": {"revision": state["revision"], "file": file_name}})
            self._send_json(HTTPStatus.OK, state, True)
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main() -> None:
    port = int(os.environ.get("AI_CHAT_PORT", "5200"))
    address = ("0.0.0.0", port)
    server = ThreadingHTTPServer(address, ChatHandler)
    print(f"AI Chat server running at http://localhost:{port}")
    primary_ip, lan_ips = get_lan_ips()
    if primary_ip:
        print("\nRecommended phone sync address (your active network):")
        print(f"  http://{primary_ip}:{port}")
    if lan_ips:
        others = [ip for ip in lan_ips if ip != primary_ip]
        if others:
            print("\nOther addresses (usually VPN or virtual adapters; do not use unless needed):")
            for ip in others:
                print(f"  http://{ip}:{port}")
    else:
        print("\nNo LAN IPv4 address was detected. Check your Wi-Fi or Ethernet connection.")
    print("\nAndroid CORS proxy address: use the same LAN address above in model settings.")
    print(f"LAN sync token: {get_sync_token()}")
    print(f"Logs are saved to {LOG_FILE}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
