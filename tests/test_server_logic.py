"""TASK-01: server.py 纯逻辑可测化重构 —— 路由/寻址/容量纯函数测试。

覆盖范围（对应 TASKS.md TASK-01）：
- build_sub_topic: flat/ns 订阅 topic 构造（兼容规则：未传 ns → flat）
- resolve_target: 目标解析（跨 ns、@tool 剥离）
- build_pub_topics: 群发展开 + 去重
- check_text_size: 64KB 消息体上限
"""
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server


# ---------- build_sub_topic ----------

class TestBuildSubTopic:
    def test_flat_topic_when_ns_absent(self):
        """未传 ns → 旧 flat topic，兼容既有客户端"""
        assert server.build_sub_topic("demo") == "/agentbus/ai/channel/demo/message"

    def test_flat_topic_when_ns_none(self):
        """运行时语义：ns 未传 → None → flat（空串不是合法 ns，按显式处理）"""
        assert server.build_sub_topic("demo", None) == "/agentbus/ai/channel/demo/message"

    def test_ns_topic_when_ns_present(self):
        assert server.build_sub_topic("demo", "iot") == "/agentbus/ai/channel/iot/demo/message"


# ---------- resolve_target ----------

class TestResolveTarget:
    def test_plain_client_id_has_no_explicit_ns(self):
        """无 ns/ 前缀 → ns=None，由 build_pub_topics 按发件人 ns 解释"""
        assert server.resolve_target("demo") == (None, "demo", None)

    def test_cross_ns_target(self):
        assert server.resolve_target("iot/be-svc") == ("iot", "be-svc", None)

    def test_explicit_default_ns(self):
        assert server.resolve_target("default/a") == ("default", "a", None)

    def test_tool_suffix_stripped(self):
        assert server.resolve_target("demo@kilo") == (None, "demo", "kilo")

    def test_cross_ns_with_tool(self):
        assert server.resolve_target("iot/be-svc@kilo") == ("iot", "be-svc", "kilo")

    def test_empty_client_id_rejected(self):
        with pytest.raises(ValueError):
            server.resolve_target("iot/")

    def test_blank_target_rejected(self):
        with pytest.raises(ValueError):
            server.resolve_target("   ")


# ---------- build_pub_topics ----------

class TestBuildPubTopics:
    def test_single_target_from_flat_sender_is_flat(self):
        """兼容规则：发件人未传 ns（sender_ns=None）且目标无 ns 前缀 → flat topic"""
        assert server.build_pub_topics("demo", None) == ["/agentbus/ai/channel/demo/message"]

    def test_single_target_in_named_ns_uses_ns_topic(self):
        """发件人在 iot ns 且目标无 ns 前缀 → 同 ns 的 ns topic"""
        assert server.build_pub_topics("demo", "iot") == [
            "/agentbus/ai/channel/iot/demo/message"
        ]

    def test_explicit_default_ns_prefix_is_not_flat(self):
        """显式 default/cid → ns topic（显式传 ns 的连接不在 flat 上）"""
        assert server.build_pub_topics("default/a", "default") == [
            "/agentbus/ai/channel/default/a/message"
        ]

    def test_cross_ns_target(self):
        assert server.build_pub_topics("iot/be-svc", None) == [
            "/agentbus/ai/channel/iot/be-svc/message"
        ]

    def test_tool_suffix_does_not_affect_topic(self):
        assert server.build_pub_topics("demo@kilo", None) == [
            "/agentbus/ai/channel/demo/message"
        ]

    def test_comma_separated_group(self):
        assert server.build_pub_topics("a,b", None) == [
            "/agentbus/ai/channel/a/message",
            "/agentbus/ai/channel/b/message",
        ]

    def test_list_group(self):
        assert server.build_pub_topics(["a", "iot/b"], None) == [
            "/agentbus/ai/channel/a/message",
            "/agentbus/ai/channel/iot/b/message",
        ]

    def test_dedupe_across_flat_and_ns_forms(self):
        """flat 与显式 default/ 前缀是两个不同 topic，均需保留"""
        assert server.build_pub_topics("a,default/a", None) == [
            "/agentbus/ai/channel/a/message",
            "/agentbus/ai/channel/default/a/message",
        ]

    def test_exact_duplicates_removed(self):
        assert server.build_pub_topics("a,a", None) == [
            "/agentbus/ai/channel/a/message"
        ]

    def test_sender_in_default_ns_targets_stay_in_default(self):
        """显式 ns=default 的发件人，无前缀目标解析到 default ns topic（非 flat）"""
        assert server.build_pub_topics("a", "default") == [
            "/agentbus/ai/channel/default/a/message"
        ]

    def test_empty_group_rejected(self):
        with pytest.raises(ValueError):
            server.build_pub_topics([], None)


# ---------- check_text_size ----------

class TestCheckTextSize:
    def test_small_text_passes(self):
        server.check_text_size("hello")

    def test_none_text_passes(self):
        server.check_text_size(None)

    def test_exactly_at_limit_passes(self):
        server.check_text_size("x" * server.MAX_TEXT_BYTES)

    def test_over_limit_rejected(self):
        with pytest.raises(ValueError):
            server.check_text_size("x" * (server.MAX_TEXT_BYTES + 1))


# ---------- MQTT 就绪门控（TASK-13 冒烟：SSE 握手返回时订阅未完成，早到回复丢失；
#            TASK-24 起门控跟随 hub 共享连接的通配订阅就绪）----------

class TestSessionReadyGate:
    def _make_session(self, cid):
        import asyncio

        return server.AgentSession(cid, asyncio.new_event_loop())

    def test_not_ready_before_connect(self):
        server._shared_ready.clear()
        session = self._make_session("gate-a")
        assert session.is_mqtt_ready() is False

    def test_ready_after_shared_subscribed(self):
        session = self._make_session("gate-b")
        server._shared_ready.set()
        try:
            assert session.is_mqtt_ready() is True
        finally:
            server._shared_ready.clear()

    def test_not_ready_again_after_disconnect(self):
        session = self._make_session("gate-d")
        server._shared_ready.set()
        server._shared_ready.clear()  # 模拟共享连接断开
        assert session.is_mqtt_ready() is False

    def test_wait_ready_times_out_when_not_connected(self):
        server._shared_ready.clear()
        session = self._make_session("gate-e")
        assert session.wait_ready(timeout=0.1) is False

    def test_wait_ready_returns_true_when_connected_later(self):
        """模拟异步建连：稍后就绪，wait_ready 应等到 True"""
        server._shared_ready.clear()
        session = self._make_session("gate-f")
        threading.Timer(0.05, server._shared_ready.set).start()
        try:
            assert session.wait_ready(timeout=2) is True
        finally:
            server._shared_ready.clear()


# ---------- 发送目标三态划分（TASK-13 冒烟：纯 MQTT daemon 不在 _sessions，
#           若拒发则 hub 永远无法触达 daemon —— 未知目标应尽力发布）----------

class TestPlanSendTargets:
    def test_online_target_delivered(self):
        delivered, unknown = server.plan_send_targets(["a"], {"a"})
        assert delivered == ["a"]
        assert unknown == []

    def test_unknown_target_is_best_effort_not_rejected(self):
        """不在 SSE 会话表 ≠ 离线：可能是纯 MQTT 直连（daemon），尽力发布"""
        delivered, unknown = server.plan_send_targets(["demo"], set())
        assert delivered == ["demo"]
        assert unknown == ["demo"]

    def test_mixed_group_preserves_order(self):
        delivered, unknown = server.plan_send_targets(["a", "b", "c"], {"a", "c"})
        assert delivered == ["a", "b", "c"]
        assert unknown == ["b"]

    def test_empty_group_rejected(self):
        with pytest.raises(ValueError):
            server.plan_send_targets([], {"a"})
