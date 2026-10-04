import base64

from harness.core.messages import (
    ImageBlock,
    Message,
    TextBlock,
    to_openai_messages,
)


def test_image_block_roundtrip():
    m = Message(
        role="user",
        blocks=[TextBlock(text="看这张图"), ImageBlock(media_type="image/png", data="aGVsbG8=")],
    )
    restored = Message.from_payload(m.to_payload())
    assert restored.images()[0].media_type == "image/png"
    assert restored.text() == "看这张图"


def test_openai_multimodal_content():
    m = Message(
        role="user",
        blocks=[TextBlock(text="描述图片"), ImageBlock(media_type="image/png", data="QQ==")],
    )
    out = to_openai_messages("sys", [m])
    content = out[1]["content"]
    assert isinstance(content, list)
    assert content[0] == {"type": "text", "text": "描述图片"}
    assert content[1]["type"] == "image_url"
    assert content[1]["image_url"]["url"] == "data:image/png;base64,QQ=="


def test_text_only_stays_plain():
    out = to_openai_messages("sys", [Message(role="user", blocks=[TextBlock(text="hi")])])
    assert out[1]["content"] == "hi"
