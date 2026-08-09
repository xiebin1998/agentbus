"""TASK-21: Web 控制台前端三页（ns/权限/指标）

前端为 hub 直出的单页应用（web/index.html，无构建步骤，原生 JS 调 /api/console/*）。
本文件验证服务路由与页面结构契约（三页导航 + 各页关键交互元素 + API 接线）。
"""
import server
from starlette.testclient import TestClient


def _client():
    return TestClient(server.app)


def test_console_page_serves_html():
    with _client() as client:
        r = client.get("/console")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/html")


def test_console_page_has_three_pages():
    with _client() as client:
        html = client.get("/console").text
        # 三页导航与页面容器（前端约定 data-page 属性）
        for page in ("namespaces", "permissions", "metrics"):
            assert f'data-page="{page}"' in html, f"缺少页面: {page}"


def test_console_page_wires_console_apis():
    with _client() as client:
        html = client.get("/console").text
        # 三页各自依赖的 TASK-20 API 必须接线
        for api in ("/api/console/namespaces", "/api/console/identities",
                    "/api/console/permissions", "/api/console/metrics"):
            assert api in html, f"前端未接线 API: {api}"


def test_console_page_permission_edit_controls():
    with _client() as client:
        html = client.get("/console").text
        # 权限页编辑控件：白名单/入站模式/信任映射 + 保存（下发）按钮
        for marker in ("allowed_senders", "inbound_mode", "trust_map"):
            assert marker in html, f"权限页缺少字段控件: {marker}"
