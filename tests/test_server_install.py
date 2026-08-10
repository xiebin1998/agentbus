"""TASK-28: 一键安装脚本托管（架构 6.6 / PLAN T24）

契约：中心节点静态托管 install.ps1 / install.sh（干净机器一条命令接入的下载源）；
两脚本属引导资源——与 /health 一样豁免 TASK-25 token 鉴权（装机时尚无 token）。
"""

import pytest
from starlette.testclient import TestClient

import server


@pytest.fixture
def client():
    return TestClient(server.app)


def test_install_scripts_served(client):
    r = client.get("/install.ps1")
    assert r.status_code == 200
    assert "init --yes" in r.text and "doctor" in r.text

    r2 = client.get("/install.sh")
    assert r2.status_code == 200
    assert "init --yes" in r2.text and "doctor" in r2.text


def test_install_scripts_content_matches_files(client):
    """路由直出 scripts/ 下真实文件内容（防漂移）"""
    from pathlib import Path

    root = Path(server.__file__).resolve().parent
    assert client.get("/install.ps1").text == (root / "scripts" / "install.ps1").read_text(encoding="utf-8")
    assert client.get("/install.sh").text == (root / "scripts" / "install.sh").read_text(encoding="utf-8")


def test_install_scripts_token_exempt(monkeypatch):
    """启用 token 鉴权后安装脚本仍可匿名获取（引导资源，与 /health 同级豁免）"""
    monkeypatch.setenv("MCP_API_TOKEN", "s3cret")
    with TestClient(server.app_with_auth) as c:
        assert c.get("/install.ps1").status_code == 200
        assert c.get("/install.sh").status_code == 200
        # 对照：受保护路由仍须 token
        assert c.get("/api/console/namespaces").status_code == 401
