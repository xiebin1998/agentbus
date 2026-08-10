"""TASK-19: hub 侧 daemon 指标采集（server.py）

daemon 周期性 publish 指标到 /agentbus/ai/metric/<ns>/<client_id>，hub 订阅
/agentbus/ai/metric/# 汇总；/health 扩展返回 daemon_metrics。
本文件覆盖纯逻辑层：metric topic 解析 + MetricsStore 汇总。
"""
import server


def test_parse_metric_topic_ns_form():
    assert server.parse_metric_topic("/agentbus/ai/metric/iot/fe-a") == "iot/fe-a"


def test_parse_metric_topic_flat_removed():
    """四期：flat 兼容已删除，旧格式一律 None（hub 记 warning 后丢弃）"""
    assert server.parse_metric_topic("/agentbus/ai/metric/legacy-daemon") is None


def test_parse_metric_topic_invalid():
    assert server.parse_metric_topic("/agentbus/ai/channel/x/message") is None
    assert server.parse_metric_topic("/agentbus/ai/metric/") is None
    assert server.parse_metric_topic("") is None
    # 超过两段的身份非法（只取前两段以外视为非法）
    assert server.parse_metric_topic("/agentbus/ai/metric/a/b/c") is None


def test_metrics_store_update_and_snapshot():
    store = server.MetricsStore()
    store.update("iot/fe-a", {"injected_ok": 2, "dropped": 1}, "2026-08-09T10:00:00Z")
    snap = store.snapshot()
    assert "iot/fe-a" in snap
    assert snap["iot/fe-a"]["metrics"]["injected_ok"] == 2
    assert snap["iot/fe-a"]["report_count"] == 1
    assert snap["iot/fe-a"]["last_seen"] == "2026-08-09T10:00:00Z"


def test_metrics_store_latest_wins_and_counts_accumulate():
    store = server.MetricsStore()
    store.update("d/x", {"injected_ok": 1}, "t1")
    store.update("d/x", {"injected_ok": 5}, "t2")
    snap = store.snapshot()
    # 指标以最新一次上报为准（daemon 侧累计），报告次数累加
    assert snap["d/x"]["metrics"]["injected_ok"] == 5
    assert snap["d/x"]["report_count"] == 2
    assert snap["d/x"]["last_seen"] == "t2"


def test_metrics_store_ignores_non_numeric_metrics():
    store = server.MetricsStore()
    store.update("d/x", "not-a-dict", "t1")
    assert store.snapshot() == {}
