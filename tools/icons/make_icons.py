#!/usr/bin/env python3
"""Regenerate the masked PWA icons at a declared, spec-derived inset.

    python tools/icons/make_icons.py            # write the icons
    python tools/icons/make_icons.py --measure  # report geometry, write nothing

Needs Pillow. It is not in any requirements file on purpose: this runs by hand
when the mark changes, not in CI, and nothing the site ships depends on it.

WHY THIS EXISTS
The icons were padded by hand, so the padding could not be re-derived and the
four files disagreed with each other. The number here is not a matter of taste:
the W3C maskable spec defines the safe zone as a circle of radius 2/5 of the
icon size, and Android then applies its own circle, squircle or teardrop mask
on top. Artwork whose furthest pixel sits outside that circle is clipped on
some phones and reads as edge-to-edge on all of them.

THE SOURCE IS otto-mark-512.png: the mark alone, white on transparent, so it
carries no palette of its own and the colours below are the only place they are
decided. It is a PNG rather than the SVG because the repo has no rasteriser and
adding one for a command run once a year is not worth a dependency.
"""

from __future__ import annotations

import argparse
import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "frontend" / "public"

# The artwork, full bleed on its plate, and NOT one of the files this writes.
# Reading an output as the input made the script eat its own tail: each run
# cropped the already-inset drawing and inset it again, so the mark shrank a
# little every time anyone ran it.
SOURCE = pathlib.Path(__file__).resolve().parent / "otto-mark-512.png"

# The app's own palette: the "m" in the workbench and the manifest's
# theme_color. Changing an icon's colours means changing these two lines.
PLATE = (13, 14, 17)  # #0d0e11, --wb-bg
INK = (255, 176, 0)   # #ffb000, --wb-amber

# The largest square that fits inside the safe circle is 0.8/sqrt(2) = 56.6% of
# the canvas, and the drawing is wider than its own bounding box is tall, so
# the spec's 80% is the CLIPPING limit, not a target: Android then applies its
# own circle or squircle inside that, and a mark sized to the limit reads as
# edge-to-edge on every phone. 0.46 puts the furthest pixel near 55% of the
# diameter, which is what a launcher icon actually looks like.
MASKABLE_ARTWORK_FRACTION = 0.46

# iOS never crops into the middle - it rounds the corners with a superellipse
# and shows the rest - so this one only has to stop the drawing touching the
# edge. It is deliberately less aggressive than the maskable inset.
APPLE_ARTWORK_FRACTION = 0.55

# purpose "any": shown unmasked in a tab, an install dialog, a task switcher.
# Nothing crops them, so they carry the mark large - padding these is what would
# make it look small and floating.
ANY_ARTWORK_FRACTION = 0.70

TARGETS = [
    ("icon-192.png", 192, ANY_ARTWORK_FRACTION),
    ("icon-512.png", 512, ANY_ARTWORK_FRACTION),
    ("icon-maskable-512.png", 512, MASKABLE_ARTWORK_FRACTION),
    ("apple-touch-icon.png", 180, APPLE_ARTWORK_FRACTION),
]


def plate_of(rgb: Image.Image) -> tuple[int, int, int]:
    """The ground colour, read from a corner.

    The source file and the generated icons are on different grounds now, and a
    measurement that assumed one of them counted the whole plate as artwork.
    """
    return rgb.getpixel((0, 0))  # type: ignore[return-value]


def artwork_bbox(im: Image.Image) -> tuple[int, int, int, int]:
    """The drawing's bounding box.

    Transparency marks the drawing in the source; in a generated icon there is
    none, so the ground is read from a corner. One function for both, because
    --measure is pointed at both.
    """
    if im.mode == "RGBA":
        box = im.getbbox()
        if box is None:
            raise SystemExit(f"no artwork in {SOURCE}")
        return box
    rgb = im.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    ground = plate_of(rgb)
    left, top, right, bottom = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if abs(r - ground[0]) + abs(g - ground[1]) + abs(b - ground[2]) > 60:
                if x < left:
                    left = x
                if x > right:
                    right = x
                if y < top:
                    top = y
                if y > bottom:
                    bottom = y
    if right < 0:
        raise SystemExit(f"no artwork found in {SOURCE} - is the ground still uniform?")
    return left, top, right + 1, bottom + 1


def recolour(art: Image.Image) -> Image.Image:
    """The mark in INK over PLATE, using the source's own alpha.

    Compositing rather than thresholding, so the antialiased edges stay smooth
    instead of turning into a 1-bit stencil.
    """
    px = art.load()
    w, h = art.size
    out = Image.new("RGB", (w, h))
    op = out.load()
    for y in range(h):
        for x in range(w):
            a = px[x, y][3] / 255
            op[x, y] = tuple(round(PLATE[i] + (INK[i] - PLATE[i]) * a) for i in range(3))
    return out


def furthest_drawn(im: Image.Image) -> float:
    """Distance from centre to the outermost DRAWN pixel, in pixels.

    Not the bounding box's corners: this drawing is arms, and its bbox corners
    are empty plate. Measuring them overstates the reach by about 12% and would
    have the script shrink the mark further than the spec asks.
    """
    rgb = im.convert("RGB")
    w, h = rgb.size
    px = rgb.load()
    cx, cy = w / 2, h / 2
    far = 0.0
    ground = plate_of(rgb)
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if abs(r - ground[0]) + abs(g - ground[1]) + abs(b - ground[2]) > 60:
                d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
                if d > far:
                    far = d
    return far


def report(path: pathlib.Path) -> None:
    im = Image.open(path)
    w, h = im.size
    left, top, right, bottom = artwork_bbox(im)
    far = furthest_drawn(im)
    print(
        f"{path.name:<26} canvas {w}x{h}  artwork {right - left}x{bottom - top}"
        f"  insets L{left} R{w - right} T{top} B{h - bottom}"
        f"  furthest {far:.1f}px = {far / (w / 2) * 100:.1f}% of the radius"
        f"  ({far / w * 200:.1f}% of the diameter)"
    )


def build(name: str, size: int, fraction: float) -> None:
    src = Image.open(SOURCE).convert("RGBA")
    box = artwork_bbox(src)
    art = src.crop(box)

    target_w = round(size * fraction)
    target_h = round(art.height * (target_w / art.width))
    art = art.resize((target_w, target_h), Image.LANCZOS)
    art = recolour(art)

    out = Image.new("RGB", (size, size), PLATE)
    out.paste(art, ((size - target_w) // 2, (size - target_h) // 2))
    dest = PUBLIC / name
    out.save(dest, "PNG", optimize=True)
    report(dest)


# The spec's safe zone, as a fraction of the icon's DIAMETER. Artwork reaching
# past this is clipped by a circular launcher mask.
MASKABLE_LIMIT = 0.80
# A floor as well: an icon shrunk to a speck is its own bug, and the next
# person to make it smaller should have to mean it.
MASKABLE_FLOOR = 0.40


def check() -> int:
    """Fail if a committed icon is outside the safe zone. Run this in CI."""
    bad = 0
    im = Image.open(PUBLIC / "icon-maskable-512.png")
    reach = furthest_drawn(im) / (im.size[0] / 2)
    report(PUBLIC / "icon-maskable-512.png")
    if reach > MASKABLE_LIMIT:
        print(
            f"FAIL: the mark reaches {reach:.1%} of the diameter, past the "
            f"{MASKABLE_LIMIT:.0%} maskable safe zone. A circular launcher mask "
            f"clips it. Run: python tools/icons/make_icons.py",
            file=sys.stderr,
        )
        bad += 1
    if reach < MASKABLE_FLOOR:
        print(
            f"FAIL: the mark reaches only {reach:.1%} of the diameter and will "
            f"look lost in its tile. Raise MASKABLE_ARTWORK_FRACTION.",
            file=sys.stderr,
        )
        bad += 1
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--measure", action="store_true", help="report geometry, write nothing")
    ap.add_argument("--check", action="store_true", help="fail if an icon is out of spec")
    args = ap.parse_args()

    if args.check:
        return check()

    if args.measure:
        for f in ("icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"):
            p = PUBLIC / f
            if p.exists():
                report(p)
        return 0

    for name, size, fraction in TARGETS:
        build(name, size, fraction)
    print("\nthe safe limit for a maskable icon is 80% of the diameter", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
