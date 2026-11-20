#!/usr/bin/env python3
"""Makes the Android launcher icons and splash screens from the iOS app icon.

Usage: python3 scripts/android-art.py

The iOS icon is the one source, so the two apps can't drift apart. Run this
again whenever that icon changes. Needs Pillow.

- Adaptive icon (Android 8 and later): the launcher crops the foreground to its
  own shape and shows only the middle 72 of its 108 dp, so the whole icon is
  scaled into that middle part. The mark then takes the same share of the
  visible icon as it does on iOS. Many launchers cut it to a circle 66 dp
  across, so a mark that reaches into the corners is scaled down to fit it.
- A one-color copy of the mark, for launchers that tint every icon to match
  the wallpaper (themed icons).
- Older launchers get the square icon, and a round one cut to a circle, with
  the mark kept inside it the same way.
- Splash: the mark alone, centered on the icon's background at the size the
  iOS splash shows it on a phone, about a fifth of the screen's width.
"""
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICON = ROOT / "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"
RES = ROOT / "android/app/src/main/res"
# The mark's width as a share of the splash's short side.
SPLASH_MARK = 0.22

DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
SPLASHES = {
    "drawable": (480, 320),
    "drawable-land-mdpi": (480, 320),
    "drawable-land-hdpi": (800, 480),
    "drawable-land-xhdpi": (1280, 720),
    "drawable-land-xxhdpi": (1600, 960),
    "drawable-land-xxxhdpi": (1920, 1280),
    "drawable-port-mdpi": (320, 480),
    "drawable-port-hdpi": (480, 800),
    "drawable-port-xhdpi": (720, 1280),
    "drawable-port-xxhdpi": (960, 1600),
    "drawable-port-xxxhdpi": (1280, 1920),
}


def mark_mask(icon, background):
    """White where the mark is, clear everywhere else, at the icon's size."""
    flat = Image.new("RGB", icon.size, background)
    diff = ImageChops.difference(icon.convert("RGB"), flat).convert("L")
    alpha = diff.point(lambda v: 0 if v < 12 else min(255, v * 3))
    white = Image.new("RGBA", icon.size, (255, 255, 255, 0))
    white.putalpha(alpha)
    return white


def mark_of(icon, background):
    """The icon cropped to its mark, with the flat background around it."""
    flat = Image.new("RGB", icon.size, background)
    diff = ImageChops.difference(icon.convert("RGB"), flat).convert("L")
    box = diff.point(lambda v: 255 if v > 24 else 0).getbbox()
    return icon.crop(box)


def reach_of(icon, background):
    """How far the mark reaches from the center, as a share of half the icon."""
    flat = Image.new("RGB", icon.size, background)
    diff = ImageChops.difference(icon.convert("RGB"), flat).convert("L").point(lambda v: 255 if v > 24 else 0)
    half = icon.width / 2
    pixels = diff.load()
    farthest = 0
    for y in range(0, icon.height, 2):
        for x in range(0, icon.width, 2):
            if pixels[x, y]:
                farthest = max(farthest, ((x - half) ** 2 + (y - half) ** 2) ** 0.5)
    return farthest / half


def save(image, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, optimize=True)


def main():
    icon = Image.open(ICON).convert("RGB")
    background = icon.getpixel((0, 0))
    hex_background = "#%02X%02X%02X" % background
    reach = reach_of(icon, background)
    # Shares of the icon's width that keep the mark inside a circle: 66 of the
    # adaptive icon's 72 visible dp, and most of a round icon, with a margin.
    adaptive_share = min(1.0, (66 / 72) * 0.94 / reach)
    round_share = min(1.0, 0.92 / reach)

    for name, scale in DENSITIES.items():
        folder = RES / f"mipmap-{name}"
        side = round(48 * scale)
        save(icon.resize((side, side), Image.LANCZOS), folder / "ic_launcher.png")

        mask = Image.new("L", (side * 4, side * 4), 0)
        ImageDraw.Draw(mask).ellipse((0, 0, side * 4, side * 4), fill=255)
        disc = Image.new("RGB", (side, side), background)
        inner = round(side * round_share)
        disc.paste(icon.resize((inner, inner), Image.LANCZOS), ((side - inner) // 2, (side - inner) // 2))
        round_icon = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        round_icon.paste(disc, (0, 0), mask.resize((side, side), Image.LANCZOS))
        save(round_icon, folder / "ic_launcher_round.png")

        canvas = round(108 * scale)
        visible = round(72 * scale * adaptive_share)
        foreground = Image.new("RGB", (canvas, canvas), background)
        offset = (canvas - visible) // 2
        foreground.paste(icon.resize((visible, visible), Image.LANCZOS), (offset, offset))
        save(foreground, folder / "ic_launcher_foreground.png")

        monochrome = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
        monochrome.paste(mark_mask(icon, background).resize((visible, visible), Image.LANCZOS), (offset, offset))
        save(monochrome, folder / "ic_launcher_monochrome.png")

    mark = mark_of(icon, background)
    for folder, (width, height) in SPLASHES.items():
        splash = Image.new("RGB", (width, height), background)
        mark_width = round(min(width, height) * SPLASH_MARK)
        mark_height = round(mark.height * mark_width / mark.width)
        sized = mark.resize((mark_width, mark_height), Image.LANCZOS)
        splash.paste(sized, ((width - mark_width) // 2, (height - mark_height) // 2))
        save(splash, RES / folder / "splash.png")

    for name in ("ic_launcher", "ic_launcher_round"):
        (RES / f"mipmap-anydpi-v26/{name}.xml").write_text(
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
            '    <background android:drawable="@color/ic_launcher_background"/>\n'
            '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
            '    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>\n'
            "</adaptive-icon>\n"
        )

    (RES / "values/ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        f'    <color name="ic_launcher_background">{hex_background}</color>\n</resources>\n'
    )
    print(f"Made the icons and splashes on {hex_background}.")


if __name__ == "__main__":
    main()
