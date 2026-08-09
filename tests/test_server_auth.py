"""TASK-25: 安全基线 —— hub SSE/控制台接入鉴权（架构三期清单）

契约：环境变量 MCP_API_TOKEN 非空时启用 token 鉴权——
/sse、/messages/*、/console、/api/console/* 须携带 ?token= 或 Authorization: Bearer；
/health 保持开放（监控探针）。未设 token 时保持全开放（内网/开发兼容）。
"""

import pytest
from starlette.testclient import TestClient

import server


# ─── 纯函数层 ───────────────────────────────────────────────────────────────

def test_check_auth_token(monkeypatch):
    monkeypatch.setenv("MCP_API_TOKEN", "s3cret")
    assert server.check_auth_token(False, None) is True        # 未启用 → 放行
    assert server.check_auth_token(True, None) is False        # 启用且未携带 → 拒
    assert server.check_auth_token(True, "") is False
    assert server.check_auth_token(True, "wrong") is False
    assert server.check_auth_token(True, "s3cret") is True     # 正确 token → 放行


def test_extract_token_from_query_and_header():
    scope_q = {"type": "http", "path": "/sse",
               "query_string": b"client_id=a&token=s3cret", "headers": []}
    assert server.extract_token(scope_q) == "s3cret"
    scope_h = {"type": "http", "path": "/sse", "query_string": b"",
               "headers": [(b"authorization", b"Bearer s3cret")]}
    assert server.extract_token(scope_h) == "s3cret"
    scope_none = {"type": "http", "path": "/sse", "query_string": b"", "headers": []}
    assert server.extract_token(scope_none) is None


# ─── 行为层（ASGI 中间件） ──────────────────────────────────────────────────

@pytest.fixture
def authed_client(monkeypatch):
    monkeypatch.setenv("MCP_API_TOKEN", "s3cret")
    with TestClient(server.app_with_auth) as client:
        yield client


@pytest.fixture
def open_client(monkeypatch):
    monkeypatch.delenv("MCP_API_TOKEN", raising=False)
    with TestClient(server.app_with_auth) as client:
        yield client


def test_open_when_token_not_configured(open_client):
    assert open_client.get("/api/console/namespaces").status_code == 200
    assert open_client.get("/health").status_code == 200


def test_api_rejected_without_token(authed_client):
    assert authed_client.get("/api/console/namespaces").status_code == 401
    assert authed_client.get("/api/console/metrics").status_code == 401
    assert authed_client.get("/console").status_code == 401


def test_api_allowed_with_token_query_or_header(authed_client):
    assert authed_client.get("/api/console/namespaces?token=s3cret").status_code == 200
    assert authed_client.get(
        "/api/console/namespaces", headers={"Authorization": "Bearer s3cret"}
    ).status_code == 200
    assert authed_client.get("/api/console/namespaces?token=wrong").status_code == 401


def test_health_stays_open(authed_client):
    assert authed_client.get("/health").status_code == 200


def test_sse_and_messages_rejected_without_token(authed_client):
    assert authed_client.get("/sse?client_id=x").status_code == 401
    assert authed_client.post("/messages/?session_id=x", json={}).status_code == 401


def test_sse_allowed_with_token(authed_client):
    # SSE 端点带 token 后进入正常流程（无 client_id 时报 400，而非 401）
    assert authed_client.get("/sse?token=s3cret").status_code == 400
