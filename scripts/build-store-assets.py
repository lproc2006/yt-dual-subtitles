#!/usr/bin/env python3
"""生成并校验 Chrome/Edge 商店图标与宣传图。"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SOURCE_ICON = ROOT / "store" / "source" / "icon-artwork-128.png"
ASSET_DIR = ROOT / "store" / "assets"
DOCS_DIR = ROOT / "docs"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size=size, index=1 if bold and candidate.endswith(".ttc") else 0)
    return ImageFont.load_default()


def centered_icon(canvas_size: int, artwork_size: int) -> Image.Image:
    source = Image.open(SOURCE_ICON).convert("RGBA")
    artwork = source.resize((artwork_size, artwork_size), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    offset = (canvas_size - artwork_size) // 2
    canvas.alpha_composite(artwork, (offset, offset))
    return canvas


def gradient(size: tuple[int, int]) -> Image.Image:
    width, height = size
    image = Image.new("RGB", size)
    pixels = image.load()
    for y in range(height):
        for x in range(width):
            ratio = 0.58 * (x / max(1, width - 1)) + 0.42 * (y / max(1, height - 1))
            start = (14, 31, 62)
            end = (28, 100, 201)
            pixels[x, y] = tuple(round(start[i] * (1 - ratio) + end[i] * ratio) for i in range(3))
    return image.convert("RGBA")


def rounded_badge(draw: ImageDraw.ImageDraw, xy: tuple[int, int, int, int], text: str, text_size: int) -> None:
    draw.rounded_rectangle(xy, radius=(xy[3] - xy[1]) // 2, fill=(255, 190, 65, 255))
    text_font = font(text_size, bold=True)
    bounds = draw.textbbox((0, 0), text, font=text_font)
    x = xy[0] + (xy[2] - xy[0] - (bounds[2] - bounds[0])) // 2
    y = xy[1] + (xy[3] - xy[1] - (bounds[3] - bounds[1])) // 2 - 1
    draw.text((x, y), text, font=text_font, fill=(70, 45, 0, 255))


def small_promo() -> Image.Image:
    image = gradient((440, 280))
    draw = ImageDraw.Draw(image)
    artwork = Image.open(SOURCE_ICON).convert("RGBA").resize((108, 108), Image.Resampling.LANCZOS)
    image.alpha_composite(artwork, (28, 86))
    draw.text((158, 44), "双语字幕助手", font=font(31, bold=True), fill="white")
    draw.text((158, 97), "视频字幕，一次提取", font=font(18), fill=(218, 231, 255))
    draw.text((158, 128), "自动翻译 · 双语同步", font=font(18), fill=(218, 231, 255))
    rounded_badge(draw, (158, 178, 396, 224), "首次处理约 1–3 分钟", 16)
    draw.text((158, 239), "非官方工具", font=font(13), fill=(185, 205, 238))
    # Chrome/Edge promotional tiles must be 24-bit PNGs without an alpha channel.
    return image.convert("RGB")


def marquee() -> Image.Image:
    image = gradient((1400, 560))
    draw = ImageDraw.Draw(image)
    artwork = Image.open(SOURCE_ICON).convert("RGBA").resize((260, 260), Image.Resampling.LANCZOS)
    image.alpha_composite(artwork, (108, 150))
    draw.text((430, 105), "双语字幕助手", font=font(68, bold=True), fill="white")
    draw.text((435, 205), "自动提取并翻译 YouTube 中英文字幕", font=font(34), fill=(221, 234, 255))
    draw.text((435, 260), "双语同步显示 · 样式调整 · Markdown 导出", font=font(28), fill=(195, 218, 255))
    rounded_badge(draw, (435, 335, 865, 410), "首次处理约 1–3 分钟", 27)
    draw.text((435, 446), "非官方工具，与 YouTube、Google 或 Microsoft 无隶属关系", font=font(19), fill=(184, 205, 237))
    # Chrome/Edge promotional tiles must be 24-bit PNGs without an alpha channel.
    return image.convert("RGB")


def validate(path: Path, expected: tuple[int, int]) -> None:
    with Image.open(path) as image:
        if image.size != expected:
            raise SystemExit(f"尺寸错误：{path}，实际 {image.size}，应为 {expected}")


def main() -> None:
    if not SOURCE_ICON.exists():
        raise SystemExit(f"缺少图标源文件：{SOURCE_ICON}")
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    DOCS_DIR.mkdir(parents=True, exist_ok=True)

    chrome_icon = centered_icon(128, 96)
    chrome_icon.save(ROOT / "icons" / "icon128.png", optimize=True)
    chrome_icon.save(ASSET_DIR / "icon-chrome-128.png", optimize=True)
    chrome_icon.save(DOCS_DIR / "icon128.png", optimize=True)

    edge_icon = centered_icon(300, 225)
    edge_icon.save(ASSET_DIR / "icon-edge-300.png", optimize=True)
    edge_icon.save(DOCS_DIR / "icon300.png", optimize=True)

    small_promo().save(ASSET_DIR / "promo-small-440x280.png", optimize=True)
    marquee().save(ASSET_DIR / "promo-marquee-1400x560.png", optimize=True)

    expected = {
        ROOT / "icons" / "icon128.png": (128, 128),
        ASSET_DIR / "icon-chrome-128.png": (128, 128),
        ASSET_DIR / "icon-edge-300.png": (300, 300),
        ASSET_DIR / "promo-small-440x280.png": (440, 280),
        ASSET_DIR / "promo-marquee-1400x560.png": (1400, 560),
    }
    for path, size in expected.items():
        validate(path, size)

    alpha_bbox = Image.open(ROOT / "icons" / "icon128.png").convert("RGBA").getchannel("A").getbbox()
    if alpha_bbox != (16, 16, 112, 112):
        raise SystemExit(f"Chrome 128 图标透明留白不符合规范：{alpha_bbox}")

    print("商店图标与宣传图已生成并通过尺寸校验")


if __name__ == "__main__":
    main()
