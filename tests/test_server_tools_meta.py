"""
TASK-11: 工具描述强化 + readOnlyHint（架构 5.6-C）

- 描述写使用边界（agent 的第一识别入口）
- 查询/回复类工具 ToolAnnotations(readOnlyHint=True)：
  使 readonly/plan 模式客户端免确认可调（否则只读回合连回复都做不了）
- 前提：mcp>=1.6.0（1.2.0 无 ToolAnnotations，实测已升级验证 SSE 兼容）
"""
import pytest

from server import build_tools


def _by_name(tools):
    return {t.name: t for t in tools}


class TestReadOnlyHint:
    def test_查询与回复类工具声明_readOnlyHint(self):
        tools = _by_name(build_tools())
        for name in ["list_agents", "get_agent_info", "send_message"]:
            t = tools[name]
            assert t.annotations is not None, f"{name} 缺少 annotations"
            assert t.annotations.readOnlyHint is True, f"{name} 应声明 readOnlyHint=True"

    def test_写状态类工具不声明只读(self):
        tools = _by_name(build_tools())
        for name in ["update_agent"]:
            t = tools[name]
            assert t.annotations is None or not t.annotations.readOnlyHint

    def test_readOnlyHint_为显式布尔值(self):
        """部分客户端对缺省值解释不一，必须显式 True 而非省略"""
        tools = _by_name(build_tools())
        assert tools["send_message"].annotations.readOnlyHint is True


class TestDescriptions:
    def test_send_message_描述含使用边界(self):
        tools = _by_name(build_tools())
        desc = tools["send_message"].description
        assert "AgentBus" in desc
        assert "[AgentBus]" in desc  # 回复入站信封的场景
        assert "reply_to" in desc     # 回复规范
        assert "用户" in desc          # 触发条件：用户明确要求

    def test_list_agents_描述为查询语义(self):
        desc = _by_name(build_tools())["list_agents"].description
        assert "查询" in desc or "列出" in desc

    def test_工具集完整性(self):
        names = set(_by_name(build_tools()).keys())
        assert {"update_agent", "send_message",
                "list_agents", "get_agent_info"} <= names
        # 定位收敛：ack_message 已移除（无消费者死重，工具面收敛为单一发声方式）
        assert "ack_message" not in names
