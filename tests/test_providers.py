"""Provider 路由测试：用假 litellm 模块捕获 acompletion 参数，不真发请求。"""

import asyncio
import sys
import types

from harness.providers.litellm_provider import (
    DEFAULT_BASES,
    LiteLLMProvider,
)


def install_fake_litellm(monkeypatch, captured):
    """注入假 litellm：记录 acompletion kwargs，返回空流。"""
    fake = types.ModuleType("litellm")

    async def acompletion(**kwargs):
        captured.update(kwargs)

        async def _stream():
            chunk = types.SimpleNamespace(usage=None, choices=[])
            yield chunk

        return _stream()

    fake.acompletion = acompletion
    monkeypatch.setitem(sys.modules, "litellm", fake)


def run_chat(provider):
    from harness.core.messages import Message, TextBlock

    return asyncio.run(
        provider.chat(
            system="s",
            messages=[Message(role="user", blocks=[TextBlock(text="hi")])],
            tools=[],
        )
    )


def test_openai_compatible_vendor_routes_via_openai_channel(monkeypatch):
    """zhipuai 前缀（litellm 新版不认）→ 自动改走 openai/ 兼容通道 + 官方 Base。"""
    captured = {}
    install_fake_litellm(monkeypatch, captured)
    p = LiteLLMProvider("zhipuai/glm-5.3-flash", api_key="sk-test")
    run_chat(p)
    assert captured["model"] == "openai/glm-5.3-flash"
    assert captured["api_base"] == DEFAULT_BASES["zhipuai"]
    assert captured["api_key"] == "sk-test"


def test_explicit_base_url_wins(monkeypatch):
    """用户填了 Base URL → 一律走 openai/ 兼容通道并用用户的端点。"""
    captured = {}
    install_fake_litellm(monkeypatch, captured)
    p = LiteLLMProvider("zhipuai/glm-5.3-flash", api_key="sk-test", api_base="https://open.bigmodel.cn/api/coding/paas/v4")
    run_chat(p)
    assert captured["model"] == "openai/glm-5.3-flash"
    assert captured["api_base"] == "https://open.bigmodel.cn/api/coding/paas/v4"


def test_native_provider_untouched(monkeypatch):
    """litellm 原生支持的厂商（openai/deepseek/anthropic）保持原模型串。"""
    captured = {}
    install_fake_litellm(monkeypatch, captured)
    p = LiteLLMProvider("openai/gpt-4o", api_key="sk-o")
    run_chat(p)
    assert captured["model"] == "openai/gpt-4o"
    assert "api_base" not in captured

    captured.clear()
    p2 = LiteLLMProvider("deepseek/deepseek-chat", api_key="sk-d")
    run_chat(p2)
    assert captured["model"] == "deepseek/deepseek-chat"
    assert "api_base" not in captured


def test_unknown_prefix_without_base_routes_native(monkeypatch):
    """未知前缀且无 Base URL：保持原样交给 litellm（让它给出自己的报错）。"""
    captured = {}
    install_fake_litellm(monkeypatch, captured)
    p = LiteLLMProvider("weirdvendor/m", api_key="k")
    run_chat(p)
    assert captured["model"] == "weirdvendor/m"
