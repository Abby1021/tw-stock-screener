"""台股條件選股器 本機伺服器

直接雙擊 index.html 時，瀏覽器會擋下網頁去讀證交所、櫃買中心的資料（CORS 限制）。
這個小程式在你的電腦上開一個網頁伺服器，並幫網頁轉接交易所的資料。
只用 Python 內建模組，不需要安裝任何套件。

用法：雙擊 start.bat（Windows），或在這個資料夾執行  python3 server.py
"""
import hashlib
import http.cookiejar
import http.server
import json
import re
import os
import socketserver
import ssl
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

PORT = 8765
ALLOWED_HOSTS = {
    "openapi.twse.com.tw",
    "www.twse.com.tw",
    "www.tpex.org.tw",
    "mis.twse.com.tw",
    "ess.api.cnyes.com",
}
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/129.0 Safari/537.36")

# 仍會驗證憑證；只關掉 Python 3.13 新加的嚴格檢查（證交所憑證缺少 Subject Key Identifier 會被它擋掉）
SSL_CTX = ssl.create_default_context()
if hasattr(ssl, "VERIFY_X509_STRICT"):
    SSL_CTX.verify_flags &= ~ssl.VERIFY_X509_STRICT


UPD_FILES = ["index.html", "style.css", "app.js", "server.ps1", "server.py", "start.bat", "README.txt", "version.json"]
RAW_BASE = os.environ.get("UPDATE_BASE", "https://raw.githubusercontent.com")
ROOT = os.path.dirname(os.path.abspath(__file__))


def upd_cfg():
    try:
        with open(os.path.join(ROOT, "update.json"), encoding="utf-8-sig") as f:
            c = json.load(f)
    except Exception:
        return None
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", str(c.get("repo", ""))):
        return None
    c.setdefault("branch", "main")
    return c


def raw_get(cfg, name):
    import time
    url = f"{RAW_BASE}/{cfg['repo']}/{cfg['branch'] or 'main'}/{name}?t={int(time.time())}"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with OPENER.open(req, timeout=30) as r:
        return r.read()


OPENER = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
    urllib.request.HTTPSHandler(context=SSL_CTX),
)


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/proxy?"):
            return self.proxy()
        if self.path.split("?")[0] == "/update/check":
            return self.update_check()
        return super().do_GET()

    def do_POST(self):
        if self.path.split("?")[0] == "/update/apply":
            return self.update_apply()
        self.send_error(405)

    def send_json(self, status, obj):
        self.reply(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def update_check(self):
        cfg = upd_cfg()
        if not cfg:
            return self.send_json(200, {"configured": False})
        try:
            self.reply(200, raw_get(cfg, "version.json"), "application/json; charset=utf-8")
        except Exception as e:
            print(f"[檢查更新失敗] {e}")
            self.send_json(502, {"error": str(e)})

    def update_apply(self):
        cfg = upd_cfg()
        if not cfg:
            return self.send_json(400, {"error": "update.json 沒有設定 repo"})
        try:
            vb = raw_get(cfg, "version.json")
            ver = json.loads(vb.decode("utf-8-sig"))
            names = [n for n in ver.get("files", []) if n in UPD_FILES]
            if "version.json" not in names:
                names.append("version.json")
            got = {n: (vb if n == "version.json" else raw_get(cfg, n)) for n in names}
            changed = []
            for n, data in got.items():
                dest = os.path.join(ROOT, n)
                if os.path.exists(dest) and hashlib.sha256(open(dest, "rb").read()).digest() == hashlib.sha256(data).digest():
                    continue
                with open(dest + ".new", "wb") as f:
                    f.write(data)
                changed.append(n)
            for n in changed:
                os.replace(os.path.join(ROOT, n + ".new"), os.path.join(ROOT, n))
            print(f"[已更新] v{ver.get('version')}：{', '.join(changed)}")
            self.send_json(200, {"ok": True, "version": ver.get("version"), "changed": changed, "restart": "server.py" in changed})
        except Exception as e:
            print(f"[更新失敗] {e}")
            self.send_json(502, {"error": str(e)})

    def proxy(self):
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        url = query.get("url", [""])[0]
        parts = urllib.parse.urlsplit(url)
        if parts.scheme != "https" or parts.hostname not in ALLOWED_HOSTS:
            return self.reply(403, b"host not allowed", "text/plain; charset=utf-8")
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "zh-TW,zh;q=0.9",
            "Referer": f"https://{parts.hostname}/",
        })
        try:
            with OPENER.open(req, timeout=30) as r:
                body = r.read()
                ctype = r.headers.get("Content-Type", "application/json; charset=utf-8")
                self.reply(200, body, ctype)
        except urllib.error.HTTPError as e:
            print(f"[轉接失敗] HTTP {e.code}  {url}")
            self.reply(e.code, f"upstream HTTP {e.code}".encode(), "text/plain; charset=utf-8")
        except Exception as e:  # 連線逾時、憑證錯誤等
            print(f"[轉接失敗] {type(e).__name__}: {e}  {url}")
            self.reply(502, f"{type(e).__name__}: {e}".encode(), "text/plain; charset=utf-8")

    def reply(self, status, body, ctype):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # 不印每一筆請求，只印錯誤


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = None
    port = PORT
    for port in range(PORT, PORT + 20):
        try:
            server = Server(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    if server is None:
        print("找不到可用的連接埠，請關掉其他程式後再試。")
        sys.exit(1)
    url = f"http://localhost:{port}/index.html"
    print("台股條件選股器已啟動")
    print(f"網址：{url}")
    print("使用期間請不要關掉這個視窗；要結束時直接關閉視窗或按 Ctrl+C。")
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("已結束。")


if __name__ == "__main__":
    main()
