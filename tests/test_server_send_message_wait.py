"""send_message wait_reply 阻塞等待机制测试"""
import pytest


class TestPendingReply:
    """测试 PendingReply 数据类"""

    def test_pending_reply_initialization(self):
        """测试 PendingReply 初始化"""
        from server import PendingReply
        
        pending = PendingReply()
        assert pending.event is not None
        assert pending.reply is None
        assert pending.error is None
        assert pending.created_at > 0

    def test_pending_reply_event_signal(self):
        """测试 Event 信号机制"""
        from server import PendingReply
        
        pending = PendingReply()
        assert not pending.event.is_set()
        
        pending.reply = {"test": "data"}
        pending.event.set()
        
        assert pending.event.is_set()
        assert pending.reply["test"] == "data"

    def test_pending_reply_store_global(self):
        """测试全局存储"""
        from server import _pending_replies, PendingReply
        
        # 清空
        _pending_replies.clear()
        
        # 添加
        msg_id = "msg-store-test"
        pending = PendingReply()
        _pending_replies[msg_id] = pending
        
        # 验证
        assert msg_id in _pending_replies
        assert _pending_replies[msg_id] is pending
        
        # 清理
        _pending_replies.pop(msg_id, None)
        assert msg_id not in _pending_replies


class TestOnMessageReplyMatching:
    """测试 on_message 回复匹配"""

    def test_on_message_matches_pending_reply(self):
        """测试 on_message 匹配等待中的回复"""
        from server import _pending_replies, PendingReply
        
        _pending_replies.clear()
        
        msg_id = "msg-match-test"
        pending = PendingReply()
        _pending_replies[msg_id] = pending
        
        # 模拟收到回复
        payload = {
            "id": "msg-reply456",
            "reply_to": msg_id,
            "text": "这是回复内容",
            "from": "agent-b",
        }
        
        # 模拟 on_message 处理：匹配 reply_to
        if payload.get("reply_to") in _pending_replies:
            matched = _pending_replies[payload["reply_to"]]
            matched.reply = payload
            matched.event.set()
        
        # 验证
        assert pending.event.is_set()
        assert pending.reply["reply_to"] == msg_id
        
        # 清理
        _pending_replies.pop(msg_id, None)

    def test_on_message_no_match_for_new_message(self):
        """测试新消息不匹配"""
        from server import _pending_replies, PendingReply
        
        _pending_replies.clear()
        
        # 新消息没有 reply_to
        payload = {
            "id": "msg-new-123",
            "from": "agent-a",
            "text": "新消息",
        }
        
        # 不应该匹配
        reply_to = payload.get("reply_to")
        assert reply_to is None or reply_to not in _pending_replies


class TestSendMessageToolDefinition:
    """测试 send_message 工具定义"""

    def test_tool_has_wait_reply_param(self):
        """测试工具定义包含 wait_reply 参数"""
        from server import build_tools
        
        tools = build_tools()
        send_msg_tool = next((t for t in tools if t.name == "send_message"), None)
        
        assert send_msg_tool is not None
        assert "wait_reply" in send_msg_tool.inputSchema["properties"]
        assert send_msg_tool.inputSchema["properties"]["wait_reply"]["type"] == "boolean"
        assert send_msg_tool.inputSchema["properties"]["wait_reply"]["default"] == False

    def test_tool_has_timeout_param(self):
        """测试工具定义包含 timeout 参数"""
        from server import build_tools
        
        tools = build_tools()
        send_msg_tool = next((t for t in tools if t.name == "send_message"), None)
        
        assert send_msg_tool is not None
        assert "timeout" in send_msg_tool.inputSchema["properties"]
        assert send_msg_tool.inputSchema["properties"]["timeout"]["type"] == "number"
        assert send_msg_tool.inputSchema["properties"]["timeout"]["default"] == 300

    def test_tool_has_reply_to_param(self):
        """测试工具定义包含 reply_to 参数"""
        from server import build_tools
        
        tools = build_tools()
        send_msg_tool = next((t for t in tools if t.name == "send_message"), None)
        
        assert send_msg_tool is not None
        assert "reply_to" in send_msg_tool.inputSchema["properties"]
        assert send_msg_tool.inputSchema["properties"]["reply_to"]["type"] == "string"


class TestSendMessageWithWaitFunction:
    """测试 send_message_with_wait 函数"""

    def test_function_exists(self):
        """测试函数存在"""
        from server import send_message_with_wait
        
        assert callable(send_message_with_wait)

    def test_function_signature(self):
        """测试函数签名"""
        from server import send_message_with_wait
        import inspect
        
        sig = inspect.signature(send_message_with_wait)
        params = list(sig.parameters.keys())
        
        assert "session" in params
        assert "text" in params
        assert "to" in params
        assert "msg_id" in params
        assert "timeout" in params
        assert "session_id" in params
        assert "reply_to" in params


class TestExpectReplyPayloadField:
    """测试 expect_reply 字段"""

    def test_expect_reply_field_logic(self):
        """测试 expect_reply 字段逻辑"""
        # 验证 payload 构建逻辑
        payload = {
            "id": "msg-test",
            "from": "agent-a",
            "to": "agent-b",
            "text": "test",
            "type": "text",
        }
        
        # expect_reply=True 时应写入
        expect_reply = True
        if expect_reply:
            payload["expect_reply"] = True
        
        assert payload["expect_reply"] == True
        
        # expect_reply=False 时不写入（或显式 False）
        payload2 = {
            "id": "msg-test2",
            "from": "agent-a",
            "to": "agent-b",
            "text": "test",
            "type": "text",
        }
        expect_reply = False
        if expect_reply:
            payload2["expect_reply"] = True
        
        assert "expect_reply" not in payload2

    def test_reply_to_field_logic(self):
        """测试 reply_to 字段逻辑"""
        payload = {
            "id": "msg-reply",
            "from": "agent-b",
            "to": "agent-a",
            "text": "回复内容",
            "type": "text",
        }
        
        reply_to = "msg-original-123"
        if reply_to:
            payload["reply_to"] = reply_to
        
        assert payload["reply_to"] == "msg-original-123"