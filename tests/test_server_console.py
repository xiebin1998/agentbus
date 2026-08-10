"""指标汇总与 metric 通道回归。

四期：旧控制台 API（ns 声明/权限档案/团队）已由控制台 API v4 取代
（见 test_server_console_v4.py：session 鉴权 + 账号/ns 管理），
本文件仅保留仍有效的指标回归用例。
"""
import server


# ─── 纯逻辑层 ────────────────────────────────────────────────────────────────


def test_build_metric_summary_aggregates():
    snap = {
        "ns/a": {"metrics": {"injected_ok": 2, "injected_fail": 1, "dropped": 1,
                             "deduped": 0, "queued": 0, "senders": 3, "uptime_s": 10},
                 "report_count": 4},
        "ns/b": {"metrics": {"injected_ok": 5, "injected_fail": 0, "dropped": 2,
                             "deduped": 1, "queued": 1, "senders": 1, "uptime_s": 99},
                 "report_count": 2},
        "ns/bad": {"metrics": "not-a-dict"},  # 非法条目跳过
    }
    s = server.build_metric_summary(snap)
    assert s["daemon_count"] == 2
    assert s["totals"] == {"injected_ok": 7, "injected_fail": 1, "dropped": 3,
                           "deduped": 1, "queued": 1}
    assert s["total_senders"] == 4


# ─── metric 通道端到端（需本地 broker，无 broker 时 skip） ────────────────────


def test_metric_client_publish_delivers_end_to_end():
    """真机级单测（需本地 broker，无 broker 时 skip）：paho publish 后独立订阅者
    应能收到（防 PUBACK 已到但消息未投递的静默丢失回归）。
    TASK-25：尊重 MQTT_USERNAME/PASSWORD（匿名被拒的 broker 上无凭证则 skip）"""
    import os
    import time
    import paho.mqtt.client as mqtt2

    host = os.getenv("MQTT_BROKER_HOST", "127.0.0.1")
    port = int(os.getenv("MQTT_BROKER_PORT", "18830"))
    user = os.getenv("MQTT_USERNAME", "")

    def _apply_auth(client):
        if user:
            client.username_pw_set(user, os.getenv("MQTT_PASSWORD", ""))

    conn = {"rc": None}

    def _on_connect(c, u, f, rc, properties=None):
        conn["rc"] = getattr(rc, "value", rc)

    received = []
    sub = mqtt2.Client(client_id="pytest-metric-sub", protocol=mqtt2.MQTTv311,
                       callback_api_version=mqtt2.CallbackAPIVersion.VERSION2)
    sub.on_message = lambda c, u, m: received.append((m.topic, m.payload.decode("utf-8")))
    sub.on_connect = _on_connect
    _apply_auth(sub)
    try:
        sub.connect(host, port, keepalive=30)
    except Exception:
        import pytest
        pytest.skip("本地 broker 不可达，跳过端到端验证")
    sub.subscribe("/agentbus/ai/metric/#", qos=1)
    sub.loop_start()
    for _ in range(30):
        if conn["rc"] is not None:
            break
        time.sleep(0.1)
    if conn["rc"] not in (0, None):
        import pytest
        sub.loop_stop(); sub.disconnect()
        pytest.skip(f"broker 拒绝连接（rc={conn['rc']}，未配 MQTT_USERNAME），跳过端到端验证")
    time.sleep(1.0)

    pub = mqtt2.Client(client_id="pytest-metric-pub", protocol=mqtt2.MQTTv311,
                       callback_api_version=mqtt2.CallbackAPIVersion.VERSION2)
    _apply_auth(pub)
    pub.connect(host, port, keepalive=30)
    pub.loop_start()
    info = pub.publish("/agentbus/ai/metric/pytest/x", '{"type":"metric"}', qos=1)
    info.wait_for_publish(timeout=5.0)
    assert info.is_published()
    time.sleep(1.5)
    sub.loop_stop(); sub.disconnect()
    pub.loop_stop(); pub.disconnect()
    assert any(t == "/agentbus/ai/metric/pytest/x" for t, _ in received), \
        f"PUBACK 已到但订阅者未收到（broker={host}:{port}）"
