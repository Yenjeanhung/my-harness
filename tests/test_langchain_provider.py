import asyncio

from langchain_core.messages import AIMessage

from harness.core.messages import Message, TextBlock, ToolResultBlock, ToolUseBlock
from harness.providers.langchain_provider import LangChainProvider, to_lc_messages


class FakeLCModel:
    """duck-typed LC chat model：按脚本 yield AIMessage，记录收到的消息。"""

    def __init__(self, script):
        self.script = list(script)
        self.seen = None

    def bind_tools(self, tools):
        self.bound = tools
        return self

    async def astream(self, messages):
        self.seen = list(messages)
        for m in self.script:
            yield m


def test_text_and_tool_call_assembly():
    script = [
        AIMessage(content="", tool_calls=[{"name": "write_file", "args": {"path": "a.txt", "content": "hi"}, "id": "t1"}]),
        AIMessage(content="done", usage_metadata={"input_tokens": 3, "output_tokens": 2, "total_tokens": 5}),
    ]
    p = LangChainProvider("openai/x", lc_model=FakeLCModel(script))
    r = asyncio.run(
        p.chat(system="s", messages=[Message(role="user", blocks=[TextBlock(text="write")])],
               tools=[{"type": "function", "function": {"name": "write_file"}}])
    )
    assert r.tool_uses[0].name == "write_file" and r.tool_uses[0].input == {"path": "a.txt", "content": "hi"}
    assert r.text == "done" and r.usage.input_tokens == 3 and r.usage.output_tokens == 2


def test_zhipuai_thinking_mapping():
    """GLM 思考档位映射：off→disabled；低/高/最高→enabled + reasoning_effort 直传（对齐 ZCode 三档）。"""
    p = LangChainProvider("zhipuai/glm-5.3-flash", api_key="sk-t", thinking="off")
    m = p._model("zhipuai/glm-5.3-flash")
    assert m.extra_body == {"thinking": {"type": "disabled"}}

    p2 = LangChainProvider("zhipuai/glm-5.3-flash", api_key="sk-t", thinking="max")
    m2 = p2._model("zhipuai/glm-5.3-flash")
    assert m2.extra_body == {"thinking": {"type": "enabled"}, "reasoning_effort": "max"}


def test_openai_max_clamps_to_high():
    """非智谱厂商不认 max：收敛为 high，避免 400。"""
    p = LangChainProvider("openai/gpt-5.2", thinking="max")
    m = p._model("openai/gpt-5.2")
    assert getattr(m, "reasoning_effort", None) == "high"


def test_message_conversion():
    msgs = [
        Message(role="user", blocks=[TextBlock(text="q")]),
        Message(role="assistant", blocks=[ToolUseBlock(id="t1", name="bash", input={"command": "ls"})]),
        Message(role="tool", blocks=[ToolResultBlock(tool_use_id="t1", content="out")]),
    ]
    lc = to_lc_messages(msgs)
    assert [type(m).__name__ for m in lc] == ["HumanMessage", "AIMessage", "ToolMessage"]
    assert lc[1].tool_calls[0]["name"] == "bash" and lc[1].tool_calls[0]["id"] == "t1"
    assert lc[2].content == "out" and lc[2].tool_call_id == "t1"


def test_reasoning_content_streamed_to_on_reason():
    """GLM/DeepSeek 系 reasoning_content 增量经 on_reason 回调外送，不混入正文。"""
    script = [
        AIMessage(content="", additional_kwargs={"reasoning_content": "先想一步，"}),
        AIMessage(content="", additional_kwargs={"reasoning_content": "再想两步"}),
        AIMessage(content="答案是 4"),
    ]
    reasons, texts = [], []
    p = LangChainProvider("zhipuai/glm-5.3-flash", lc_model=FakeLCModel(script))
    r = asyncio.run(
        p.chat(system="s", messages=[Message(role="user", blocks=[TextBlock(text="2+2")])],
               tools=[], on_delta=lambda t: texts.append(t), on_reason=lambda t: reasons.append(t))
    )
    assert "".join(reasons) == "先想一步，再想两步"
    assert r.text == "答案是 4" and "".join(texts) == "答案是 4"
