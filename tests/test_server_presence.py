"""LWT presence 在线态：显式状态 + 60s 心跳兜底 + 无 presence 旧客户端回退指标窗口。"""
from datetime import datetime, timedelta, timezone

NOW = datetime(2026, 8, 12, 2, 0, 0, tzinfo=timezone.utc)


def _ts(delta_s):
    return (NOW - timedelta(seconds=delta_s)).isoformat().replace("+00:00", "Z")


def test_presence_online_with_fresh_heartbeat():
    import server
    presence = {"iot/a": {"state": "online", "ts": _ts(1)}}
    metrics = {"iot/a": {"last_seen": _ts(10), "report_count": 5}}
    assert server.agent_online("iot/a", presence, metrics, NOW) is True


def test_presence_online_but_heartbeat_stale_60s_fallback():
    """presence 说 online 但 60s 无心跳（断网+遗嘱丢失场景）→ 判离线"""
    import server
    presence = {"iot/a": {"state": "online", "ts": _ts(120)}}
    metrics = {"iot/a": {"last_seen": _ts(120), "report_count": 5}}
    assert server.agent_online("iot/a", presence, metrics, NOW) is False


def test_presence_offline_even_with_fresh_heartbeat():
    import server
    presence = {"iot/a": {"state": "offline", "ts": _ts(1)}}
    metrics = {"iot/a": {"last_seen": _ts(1)}}
    assert server.agent_online("iot/a", presence, metrics, NOW) is False


def test_no_presence_entry_falls_back_to_legacy_metric_window():
    """旧客户端（0.2.6 前无 presence）：回退 90s 指标窗口，不破坏存量"""
    import server
    metrics_fresh = {"iot/a": {"last_seen": _ts(30)}}
    metrics_stale = {"iot/a": {"last_seen": _ts(150)}}
    assert server.agent_online("iot/a", {}, metrics_fresh, NOW) is True
    assert server.agent_online("iot/a", {}, metrics_stale, NOW) is False


def test_presence_store_update_and_snapshot():
    import server
    store = server.PresenceStore()
    store.update("iot/a", "online", _ts(0), reason="")
    store.update("iot/b", "offline", _ts(0), reason="graceful_stop")
    snap = store.snapshot()
    assert snap["iot/a"]["state"] == "online"
    assert snap["iot/b"]["state"] == "offline"
    store.remove("iot/a")
    assert "iot/a" not in store.snapshot()
