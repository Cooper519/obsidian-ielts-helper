#!/usr/bin/env python3
"""Release 后刷新同一客户端清单入口；可直接复制到公开插件仓库。"""

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
from http.client import HTTPException
import ipaddress
import json
import os
import re
import ssl
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


MAX_JSON_BYTES = 1024 * 1024
STABLE_VERSION = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"


class NotifyError(Exception):
    """只携带可公开的静态错误类别，禁止附带网络异常或响应正文。"""

    def __init__(self, code, retryable=False, status=None):
        super().__init__(code)
        self.code = code
        self.retryable = retryable
        self.status = status
        self.stage = "configuration"


def log(event, **fields):
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    print("[{}] {}{}".format(stamp, event, "".join(" {}={}".format(k, v) for k, v in fields.items())), flush=True)


def release_kind(kind, tag):
    """固定标签语法同时防止日志/命令注入；auto 仅用于私有仓自动事件。"""
    if kind == "auto":
        kind = "resources" if tag.startswith("resources-v") else "helper"
    if kind not in ("plugin", "helper", "resources"):
        raise NotifyError("invalid_kind")
    prefix = "resources-v" if kind == "resources" else "v"
    if not re.fullmatch(re.escape(prefix) + STABLE_VERSION, tag):
        raise NotifyError("invalid_stable_tag")
    return kind, tag[len(prefix):]


def feed_url(raw):
    """补默认清单路径，拒绝会改变请求目标/认证边界的 URL 成分。"""
    if not raw or re.search(r"[\s\\\x00-\x1f\x7f]", raw) or "?" in raw or "#" in raw:
        raise NotifyError("invalid_feed_url")
    try:
        u = urlsplit(raw)
        port = u.port
        if u.scheme != "https" or not u.hostname or u.username is not None or u.password is not None:
            raise ValueError()
        if u.netloc.endswith(":") or "%" in u.hostname:
            raise ValueError()
        if ":" in u.hostname:
            host = "[{}]".format(ipaddress.IPv6Address(u.hostname).compressed)
        else:
            if not all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?", label) for label in u.hostname.split(".")):
                raise ValueError()
            host = u.hostname.lower()
        if port is not None and not 1 <= port <= 65535:
            raise ValueError()
        path = u.path or "/"
        if path == "/":
            path = "/manifest.json"
        if not re.fullmatch(r"/(?:[A-Za-z0-9_-]+/)*manifest\.json", path):
            raise ValueError()
        netloc = host if port is None else "{}:{}".format(host, port)
        return urlunsplit((u.scheme, netloc, path, "", ""))
    except ValueError:
        raise NotifyError("invalid_feed_url") from None


def credential(value, name):
    # HTTP Header 必须可编码，且不允许空白分隔或注入第二个 Header。
    if not value or not re.fullmatch(r"[\x21-\x7e]+", value):
        raise NotifyError("invalid_" + name)
    return value


class NoRedirect(HTTPRedirectHandler):
    # 必须在 urllib 解析 Location 之前拒绝，畸形 Location 也保留原始 HTTP 状态。
    def http_error_302(self, req, fp, code, msg, headers):
        return None

    http_error_301 = http_error_302
    http_error_303 = http_error_302
    http_error_307 = http_error_302
    http_error_308 = http_error_302


def fetch_json(url, token, timeout=30):
    """一次有界元数据读取；3xx 从不重发，错误正文从不读取或输出。"""
    req = Request(url, headers={
        "Authorization": "Bearer " + token,
        "Cache-Control": "no-cache",
        "Accept": "application/vnd.github+json" if urlsplit(url).hostname == "api.github.com" else "application/json",
        "Accept-Encoding": "identity",
        "User-Agent": "ielts-release-notify/1",
    })
    # 显式禁用环境代理，TLS 使用 urllib 默认的系统信任与主机名校验。
    opener = build_opener(ProxyHandler({}), NoRedirect())
    try:
        with opener.open(req, timeout=timeout) as response:
            status = response.status
            if status != 200:
                raise NotifyError("http_status", status in (408, 425, 429) or status >= 500, status)
            length = response.headers.get("Content-Length")
            if length is not None:
                try:
                    length = int(length)
                except ValueError:
                    raise NotifyError("invalid_content_length") from None
                if length < 0 or length > MAX_JSON_BYTES:
                    raise NotifyError("response_too_large")
            if response.headers.get_content_type() != "application/json":
                raise NotifyError("invalid_content_type")
            encodings = response.headers.get_all("Content-Encoding", [])
            if any(part.strip().lower() != "identity" for value in encodings for part in value.split(",")):
                raise NotifyError("invalid_content_encoding")
            body = response.read(MAX_JSON_BYTES + 1)
            if len(body) > MAX_JSON_BYTES:
                raise NotifyError("response_too_large")
    except HTTPError as error:
        status = error.code
        error.close()
        raise NotifyError("http_status", status in (408, 425, 429) or status >= 500, status) from None
    except URLError as error:
        if isinstance(error.reason, ssl.SSLCertVerificationError):
            raise NotifyError("tls_verification_error") from None
        raise NotifyError("network_error", True) from None
    except ssl.SSLCertVerificationError:
        raise NotifyError("tls_verification_error") from None
    except (OSError, HTTPException):
        raise NotifyError("network_error", True) from None
    except (ValueError, UnicodeError):
        raise NotifyError("invalid_request") from None
    try:
        result = json.loads(body)
    except (ValueError, UnicodeError, RecursionError):
        raise NotifyError("invalid_json") from None
    if not isinstance(result, dict):
        raise NotifyError("invalid_json_object")
    return result


@dataclass(frozen=True)
class Config:
    url: str
    token: str
    kind: str
    tag: str
    version: str
    attempts: int = 5
    retry_seconds: int = 65
    timeout: int = 30
    repository: str = ""
    github_token: str = ""


def verify_release(config, fetch):
    """仅请求同仓精确 tag 的小 JSON；不接受草稿、预发布或尚未发布记录。"""
    url = "https://api.github.com/repos/{}/releases/tags/{}".format(config.repository, quote(config.tag, safe=""))
    release = fetch(url, config.github_token, config.timeout)
    published = release.get("published_at")
    if (release.get("tag_name") != config.tag or release.get("draft") is not False
            or release.get("prerelease") is not False or not isinstance(published, str) or not published.strip()):
        raise NotifyError("release_not_stable_published")


def notify(config, fetch=fetch_json, sleep=time.sleep):
    """相隔超过一分钟再强刷，不能把有旧缓存的 HTTP 200 当成发布已可见。"""
    verified = not config.repository
    for attempt in range(1, config.attempts + 1):
        stage = "github_release" if not verified else "vps_manifest"
        try:
            if not verified:
                verify_release(config, fetch)
                verified = True
            stage = "vps_manifest"
            manifest = fetch(config.url, config.token, config.timeout)
            if type(manifest.get("schema")) is not int or manifest["schema"] != 1:
                raise NotifyError("invalid_manifest_schema")
            component = manifest.get(config.kind)
            if not isinstance(component, dict):
                raise NotifyError("component_not_visible", True)
            if component.get("tag") != config.tag or component.get("version") != config.version:
                raise NotifyError("tag_not_visible", True, 200)
            log("通知完成", kind=config.kind, tag=config.tag, attempt=attempt)
            return
        except NotifyError as error:
            error.stage = stage
            log("通知未完成", stage=stage, reason=error.code, http_status=error.status or "none", attempt=attempt)
            if not error.retryable or attempt == config.attempts:
                raise
            log("等待重试", seconds=config.retry_seconds)
            sleep(config.retry_seconds)


def main(argv=None):
    parser = argparse.ArgumentParser(description="刷新客户端同一 VPS manifest 入口并核对精确 Release 标签")
    parser.add_argument("--kind", default=os.environ.get("NOTIFY_KIND") or "auto", help="plugin / helper / resources；默认自动判断私有标签")
    parser.add_argument("--tag", default=os.environ.get("NOTIFY_TAG", ""), help="精确稳定 Release 标签")
    parser.add_argument("--verify-release", action="store_true", help="用 GITHUB_TOKEN 和 GITHUB_REPOSITORY 核验已发布稳定 Release")
    parser.add_argument("--attempts", type=int, default=5)
    parser.add_argument("--retry-seconds", type=int, default=65)
    parser.add_argument("--timeout", type=int, default=30)
    args = parser.parse_args(argv)
    try:
        try:
            kind, version = release_kind(args.kind, args.tag)
        except NotifyError as error:
            # 自动事件可包含其他产品的稳定 Release，手动输入错误则必须明确失败。
            if error.code == "invalid_stable_tag" and os.environ.get("GITHUB_EVENT_NAME") == "release":
                log("跳过非目标稳定标签")
                return 0
            raise
        if not (1 <= args.attempts <= 8 and 61 <= args.retry_seconds <= 300 and 1 <= args.timeout <= 60):
            raise NotifyError("invalid_retry_bounds")
        repository = os.environ.get("GITHUB_REPOSITORY", "") if args.verify_release else ""
        github_token = ""
        if args.verify_release:
            if (not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository)
                    or any(segment in (".", "..") for segment in repository.split("/"))):
                raise NotifyError("invalid_repository")
            github_token = credential(os.environ.get("GITHUB_TOKEN", ""), "github_token")
        config = Config(feed_url(os.environ.get("VPS_FEED_URL", "")),
                        credential(os.environ.get("VPS_FEED_TOKEN", ""), "feed_token"),
                        kind, args.tag, version, args.attempts, args.retry_seconds, args.timeout,
                        repository, github_token)
        log("开始通知", kind=kind, tag=args.tag)
        notify(config)
        return 0
    except NotifyError as error:
        log("通知失败", stage=error.stage, reason=error.code, http_status=error.status or "none")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
