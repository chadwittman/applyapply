#!/usr/bin/env python3
"""Generate the applyapply icon set and OpenGraph card.

The mark is a doubled chevron: the product's name repeats, and the shape reads
as forward motion. It is drawn as polygons rather than set in a typeface so it
stays sharp at 16px, where a letterform would turn to mush.

Run: python3 tools/make-brand.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), '..', 'brand')
BLACK, WHITE = (10, 10, 10, 255), (255, 255, 255, 255)
SS = 8  # supersample factor


def chevron_mark(size, bg=BLACK, fg=WHITE, radius_ratio=0.22):
    """Rounded square with two chevrons."""
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * radius_ratio), fill=bg)

    # Two chevrons, centred as a pair.
    stroke = S * 0.103          # arm thickness
    h = S * 0.255               # half-height of a chevron
    w = S * 0.173               # horizontal reach
    gap = S * 0.105
    cy = S / 2
    total = w * 2 + gap
    x0 = (S - total) / 2 - S * 0.015

    for i in range(2):
        apex_x = x0 + i * (w + gap) + w
        top = (apex_x - w, cy - h)
        mid = (apex_x, cy)
        bot = (apex_x - w, cy + h)
        d.line([top, mid, bot], fill=fg, width=int(stroke), joint='curve')
        # Square the ends off cleanly.
        for pt in (top, bot):
            d.ellipse([pt[0] - stroke / 2, pt[1] - stroke / 2,
                       pt[0] + stroke / 2, pt[1] + stroke / 2], fill=fg)
    return img.resize((size, size), Image.LANCZOS)


def font(size, bold=True):
    for path in ('/System/Library/Fonts/Supplemental/Arial Bold.ttf' if bold
                 else '/System/Library/Fonts/Supplemental/Arial.ttf',
                 '/System/Library/Fonts/Helvetica.ttc'):
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def og_card(w=1200, h=630):
    """Social card. Kept left-aligned but inside a safe margin, because the
    crop varies by platform and centred type gets cut in odd places."""
    img = Image.new('RGB', (w, h), BLACK[:3])
    d = ImageDraw.Draw(img)
    x = 96

    # Lockup: mark and wordmark share an optical centre line.
    mark_px = 104
    mark = chevron_mark(mark_px, bg=(0, 0, 0, 0), fg=WHITE, radius_ratio=0)
    wf = font(86)
    word = 'applyapply'
    wbox = d.textbbox((0, 0), word, font=wf)
    lock_y = 92
    word_h = wbox[3] - wbox[1]
    img.paste(mark, (x - 6, lock_y + (word_h - mark_px) // 2 - wbox[1] // 2), mark)
    d.text((x + mark_px + 14, lock_y - wbox[1]), word, font=wf, fill=WHITE[:3])

    hf = font(62)
    d.text((x, 268), 'Job applications, done for you.', font=hf, fill=WHITE[:3])

    sf = font(36, bold=False)
    d.text((x, 360), 'Agents find the roles overnight. AI writes the kit.\n'
                     'The extension fills the form.',
           font=sf, fill=(163, 163, 163), spacing=14)

    d.line([(x, 520), (x + 120, 520)], fill=(72, 72, 72), width=3)
    d.text((x, 548), 'applyapply.xyz', font=font(30), fill=(130, 130, 130))
    return img


os.makedirs(OUT, exist_ok=True)
for s in (16, 32, 48, 64, 128, 180, 192, 256, 512):
    chevron_mark(s).save(os.path.join(OUT, f'icon-{s}.png'))

# Multi-resolution .ico for browsers that still ask for one.
chevron_mark(256).save(os.path.join(OUT, 'favicon.ico'),
                       sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
og_card().save(os.path.join(OUT, 'og.png'), optimize=True)
print('wrote', len(os.listdir(OUT)), 'files to brand/')
