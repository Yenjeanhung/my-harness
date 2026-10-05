"""icon-1024.png -> build/icon.ico（全尺寸链 256..16）+ 各尺寸 PNG 预览。"""
from pathlib import Path

from PIL import Image

HERE = Path(__file__).parent
REPO_DESKTOP = HERE.parent
SRC = HERE / "icon-1024.png"
OUT_ICO = REPO_DESKTOP / "build" / "icon.ico"

img = Image.open(SRC).convert("RGBA")
OUT_ICO.parent.mkdir(exist_ok=True)
img.save(
    OUT_ICO,
    format="ICO",
    sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)],
)
print(f"saved {OUT_ICO} ({OUT_ICO.stat().st_size // 1024} KB)")
for s in (256, 48, 32, 16):
    img.resize((s, s), Image.LANCZOS).save(HERE / f"icon-{s}.png")
print("previews: icon-256/48/32/16.png")
