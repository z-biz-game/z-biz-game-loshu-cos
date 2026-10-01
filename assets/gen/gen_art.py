#!/usr/bin/env python3
"""幻方 · LOSHU 的美术资产生成器（确定性、无网络、无外部素材）。

母题就是玩法本身：洛书九宫的**点数图**（4 9 2 / 3 5 7 / 8 1 6），压在深靛蓝的纸上，
主对角线走琥珀、副对角线走冰蓝——因为这款游戏要读的是"线"，不是"格"，图标如果不把
两条对角线画出来，它就只是又一个数独 App 的图标。

产出的东西分两类：
  * 品牌资产 icon-*（16→1024 全套，含 maskable）+ apple-touch-icon + og 社交卡；
  * 游戏内纹理 paper-grain.png（canvas 用 createPattern 铺在盘面当纸纹）、
    glow.png / spark.png（提示脉冲与合线的粒子精灵）。

复现方式（不需要任何参数）：`python3 assets/gen/gen_art.py`
随机只用在纸纹上，种子写死，所以同一份脚本在任何机器上产出同样的字节。
"""
import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'img'))
SEED = 20251002

# 与 js/theme.js 同一批令牌，图标和盘面不许长成两个游戏。
INK = (243, 246, 250)
BG_TOP = (7, 10, 18)
BG_BOTTOM = (17, 26, 40)
SURFACE = (14, 22, 34)
PAPER = (11, 18, 32)
LINE = (35, 48, 71)
LINE_HEAVY = (60, 78, 107)
GIVEN = (159, 180, 206)
ACCENT = (255, 200, 92)
ACCENT_EDGE = (255, 227, 166)
DIAG_INK = (123, 184, 255)
SUCCESS = (61, 220, 145)

LOSHU = [[4, 9, 2], [3, 5, 7], [8, 1, 6]]

# 点阵：每个数字在传统洛书图里的点位（3x3 局部坐标，取值 -1/0/1）。
DOTS = {
    1: [(0, 0)],
    2: [(0, -1), (0, 1)],
    3: [(-1, -1), (0, 0), (1, 1)],
    4: [(-1, -1), (1, -1), (-1, 1), (1, 1)],
    5: [(-1, -1), (1, -1), (0, 0), (-1, 1), (1, 1)],
    6: [(-1, -1), (-1, 0), (-1, 1), (1, -1), (1, 0), (1, 1)],
    7: [(-1, -1), (-1, 0), (-1, 1), (0, 0), (1, -1), (1, 0), (1, 1)],
    8: [(dx, dy) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if (dx or dy)],
    9: [(dx, dy) for dy in (-1, 0, 1) for dx in (-1, 0, 1)],
}

CJK_CANDIDATES = [
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/usr/share/fonts/truetype/opfc/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    'C:/Windows/Fonts/msyh.ttc',
]
MONO_CANDIDATES = [
    '/System/Library/Fonts/Menlo.ttc',
    '/System/Library/Fonts/Monaco.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
]


def load_font(paths, size):
    for p in paths:
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return None


def has_cjk(font):
    """没有中文字形时 PIL 会画成豆腐块，而豆腐块和 notdef 是同一个形状——拿 U+FFFF 比对能识破。"""
    if font is None:
        return False
    try:
        a = font.getmask('幻').getbbox()
        b = font.getmask('\uffff').getbbox()
        return a is not None and a != b
    except Exception:
        return False


def radial(size, inner, outer, power=1.0):
    """同心椭圆叠出径向渐变：比逐像素循环快两个数量级，2048 上也只要几十毫秒。"""
    img = Image.new('RGB', (size, size), outer)
    d = ImageDraw.Draw(img)
    steps = 180
    c = size // 2
    for i in range(steps, 0, -1):
        t = (i / steps) ** power
        col = tuple(int(outer[k] + (inner[k] - outer[k]) * (1 - t)) for k in range(3))
        r = int(c * (i / steps))
        d.ellipse([c - r, c - r, c + r, c + r], fill=col)
    return img


def value_noise(w, h, freq, amp, seed):
    """格点噪声，格点按 freq 周期性绕回 ⇒ 产出的贴图天然可无缝平铺。"""
    rng = random.Random(seed)
    lat = [[rng.random() for _ in range(freq)] for _ in range(freq)]
    out = bytearray(w * h)
    sx, sy = freq / w, freq / h
    for y in range(h):
        fy = y * sy
        y0 = int(fy) % freq
        y1 = (y0 + 1) % freq
        ty = fy - int(fy)
        ty = ty * ty * (3 - 2 * ty)
        row = y * w
        for x in range(w):
            fx = x * sx
            x0 = int(fx) % freq
            x1 = (x0 + 1) % freq
            tx = fx - int(fx)
            tx = tx * tx * (3 - 2 * tx)
            a = lat[y0][x0] + (lat[y0][x1] - lat[y0][x0]) * tx
            b = lat[y1][x0] + (lat[y1][x1] - lat[y1][x0]) * tx
            out[row + x] = max(0, min(255, int((a + (b - a) * ty) * 255)))
    return Image.frombytes('L', (w, h), bytes(out))


def grain_tile(px=256, seed=SEED):
    """纸纹：暖白与冷黑的极淡噪声叠在一起，铺在深靛蓝上读成"纸"而不是"塑料"。"""
    n1 = value_noise(px, px, 8, 1, seed).resize((px, px), Image.BILINEAR)
    n2 = value_noise(px, px, 32, 1, seed + 7)
    n3 = value_noise(px, px, 64, 1, seed + 13)
    a = bytearray(px * px * 4)
    d1, d2, d3 = n1.tobytes(), n2.tobytes(), n3.tobytes()
    for i in range(px * px):
        v = (d1[i] * 0.20 + d2[i] * 0.36 + d3[i] * 0.44) / 255.0
        off = abs(v - 0.5) * 2.0
        alpha = int(off ** 2.4 * 30)
        warm = v > 0.5
        a[i * 4] = 255 if warm else 4
        a[i * 4 + 1] = 246 if warm else 8
        a[i * 4 + 2] = 226 if warm else 16
        a[i * 4 + 3] = alpha
    return Image.frombytes('RGBA', (px, px), bytes(a))


def tile_grain(base, tile, scale=1.0):
    """纸纹平铺。scale>1 时先放大图块——2048 的母图上用原始 256 块会细成一片死灰。"""
    t = tile if scale == 1.0 else tile.resize(
        (int(tile.size[0] * scale), int(tile.size[1] * scale)), Image.BICUBIC)
    layer = Image.new('RGBA', base.size, (0, 0, 0, 0))
    for y in range(0, base.size[1], t.size[1]):
        for x in range(0, base.size[0], t.size[0]):
            layer.paste(t, (x, y))
    return Image.alpha_composite(base.convert('RGBA'), layer)


def board_art(canvas, origin, side, glyph='dots', font=None):
    """把洛书画进 canvas 的一块正方形区域里。调用方给的是超采样坐标，整体再降采样。

    glyph='dots' 是传统点数图（96px 以上才读得开）；'digits' 换成等宽数字，和真实盘面同源，
    留给 16~64 的 favicon——点数图缩到 16px 只剩一团噪点，那是拿母题开玩笑。
    """
    ox, oy = origin
    d = ImageDraw.Draw(canvas)
    pad = side * 0.055
    inner = side - pad * 2

    # 纸面
    d.rounded_rectangle([ox, oy, ox + side, oy + side], radius=int(side * 0.05), fill=PAPER + (255,))
    for r in range(3):
        for c in range(3):
            x0 = ox + pad + c * (inner / 3)
            y0 = oy + pad + r * (inner / 3)
            d.rectangle([x0, y0, x0 + inner / 3, y0 + inner / 3], fill=(9, 15, 27, 255))

    # 两条对角线先落在纸上：图标第一眼要读出来的是"线"
    def centre(r, c):
        return (ox + pad + (c + 0.5) * inner / 3, oy + pad + (r + 0.5) * inner / 3)

    glow = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    w = max(3, int(side * 0.022))
    gd.line([centre(0, 0), centre(2, 2)], fill=ACCENT + (150,), width=w, joint='curve')
    gd.line([centre(0, 2), centre(2, 0)], fill=DIAG_INK + (120,), width=w, joint='curve')
    canvas.alpha_composite(glow.filter(ImageFilter.GaussianBlur(side * 0.02)))
    d.line([centre(0, 0), centre(2, 2)], fill=ACCENT + (70,), width=max(2, int(side * 0.012)))
    d.line([centre(0, 2), centre(2, 0)], fill=DIAG_INK + (60,), width=max(2, int(side * 0.012)))

    # 网格线
    lw = max(2, int(side * 0.008))
    hw = max(3, int(side * 0.016))
    for i in range(4):
        col = LINE_HEAVY if i in (0, 3) else LINE
        wd = hw if i in (0, 3) else lw
        p = pad + i * (inner / 3)
        d.line([(ox + p, oy + pad), (ox + p, oy + pad + inner)], fill=col + (255,), width=wd)
        d.line([(ox + pad, oy + p), (ox + pad + inner, oy + p)], fill=col + (255,), width=wd)

    # 每格的读数：点数图，或小尺寸用的等宽数字
    dot_r = inner / 3 * 0.085
    spacing = inner / 3 * 0.235
    for r in range(3):
        for c in range(3):
            v = LOSHU[r][c]
            if r == c:
                col = ACCENT
            elif r + c == 2:
                col = DIAG_INK
            else:
                col = GIVEN
            cx, cy = centre(r, c)
            if glyph == 'digits':
                f = font
                t = str(v)
                halo = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
                hd = ImageDraw.Draw(halo)
                hd.text((cx, cy), t, font=f, fill=col + (120,), anchor='mm',
                        stroke_width=int(inner * 0.012), stroke_fill=col + (120,))
                canvas.alpha_composite(halo.filter(ImageFilter.GaussianBlur(inner * 0.02)))
                d.text((cx, cy), t, font=f, fill=col + (255,), anchor='mm')
                continue
            halo = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
            hd = ImageDraw.Draw(halo)
            for (dx, dy) in DOTS[v]:
                px_, py_ = cx + dx * spacing, cy + dy * spacing
                hd.ellipse([px_ - dot_r * 2.1, py_ - dot_r * 2.1, px_ + dot_r * 2.1, py_ + dot_r * 2.1],
                           fill=col + (70,))
            canvas.alpha_composite(halo.filter(ImageFilter.GaussianBlur(dot_r * 1.2)))
            for (dx, dy) in DOTS[v]:
                px_, py_ = cx + dx * spacing, cy + dy * spacing
                d.ellipse([px_ - dot_r, py_ - dot_r, px_ + dot_r, py_ + dot_r], fill=col + (255,))
                d.ellipse([px_ - dot_r * 0.45, py_ - dot_r * 0.62, px_ + dot_r * 0.45, py_ + dot_r * 0.1],
                          fill=tuple(min(255, int(k * 1.25)) for k in col) + (200,))


def icon_master(px=2048, grain=None, glyph='dots', font=None):
    canvas = radial(px, BG_BOTTOM, BG_TOP, power=1.35).convert('RGBA')
    # 一层从左上打下来的柔和光，纸面才不至于像一块纯色 PNG
    sheen = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    ImageDraw.Draw(sheen).ellipse([-px * 0.35, -px * 0.5, px * 0.9, px * 0.7], fill=(40, 60, 96, 90))
    canvas.alpha_composite(sheen.filter(ImageFilter.GaussianBlur(px * 0.14)))
    canvas = tile_grain(canvas, grain, scale=px / 1024.0)

    side = px * 0.62
    ox = (px - side) / 2
    oy = (px - side) / 2 - px * 0.01
    halo = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    ImageDraw.Draw(halo).rounded_rectangle([ox - side * 0.06, oy - side * 0.06,
                                            ox + side * 1.06, oy + side * 1.06],
                                           radius=int(side * 0.09), fill=(255, 200, 92, 40))
    canvas.alpha_composite(halo.filter(ImageFilter.GaussianBlur(px * 0.035)))
    board_art(canvas, (ox, oy), side, glyph, font)

    # 暗角：中心保住亮度，四周压下去，图标放在商店的白色页面上才不会糊成一团
    vg = radial(px, (0, 0, 0), (255, 255, 255), power=0.65).convert('L').point(lambda v: int(v * 0.40))
    canvas.paste((2, 3, 6), (0, 0, px, px), vg)
    return canvas


def og_card(px_w=2400, px_h=1260, grain=None):
    canvas = radial(px_w, BG_BOTTOM, BG_TOP, power=1.2).convert('RGBA')
    top = (px_w - px_h) // 2
    canvas = canvas.crop((0, top, px_w, top + px_h))
    canvas.load()
    sheen = Image.new('RGBA', (px_w, px_h), (0, 0, 0, 0))
    ImageDraw.Draw(sheen).ellipse([-px_w * 0.2, -px_h * 0.7, px_w * 0.7, px_h * 0.6], fill=(46, 68, 106, 90))
    canvas.alpha_composite(sheen.filter(ImageFilter.GaussianBlur(px_w * 0.08)))
    canvas = tile_grain(canvas, grain, scale=px_w / 1500.0)

    side = int(px_h * 0.72)
    board_art(canvas, (int(px_w * 0.055), (px_h - side) // 2), side)

    d = ImageDraw.Draw(canvas)
    x = int(px_w * 0.48)
    ty = int(px_h * 0.20)
    cjk = load_font(CJK_CANDIDATES, int(px_h * 0.20))
    cjk_small = load_font(CJK_CANDIDATES, int(px_h * 0.042))
    mono = load_font(MONO_CANDIDATES, int(px_h * 0.055))
    small = load_font(MONO_CANDIDATES, int(px_h * 0.040))
    cjk_ok = has_cjk(cjk)
    # 中文行必须有中文字形，否则整张卡是一片豆腐；拉丁读数继续走等宽，和盘上的数字同源。
    body = cjk_small if cjk_ok else small

    title = '幻方' if cjk_ok else 'LOSHU'
    d.text((x, ty), title, font=cjk if cjk_ok else mono, fill=ACCENT + (255,))
    sub_y = ty + int(px_h * (0.24 if cjk_ok else 0.10))
    d.text((x, sub_y), 'LOSHU · 填数推理' if cjk_ok else 'LOSHU · fill the square',
           font=body, fill=GIVEN + (235,))
    line_y = sub_y + int(px_h * 0.10)
    for i, s in enumerate([
        '每行 每列 两条对角线 都等于 M' if cjk_ok else 'every row, column, diagonal = M',
        '九宫 M=15 · 四四 M=34 · 泛对角 M=34' if cjk_ok else '3x3 M=15 · 4x4 M=34 · pandiagonal',
        '每局唯一解，每局都能用逻辑推到底' if cjk_ok else 'one solution, no guessing needed',
    ]):
        d.text((x, line_y + i * int(px_h * 0.072)), s, font=body, fill=INK + (225,))

    chip_y = line_y + 3 * int(px_h * 0.072) + int(px_h * 0.02)
    d.rounded_rectangle([x, chip_y, x + int(px_w * 0.11), chip_y + int(px_h * 0.085)],
                        radius=int(px_h * 0.02), outline=SUCCESS + (200,), width=int(px_h * 0.005))
    d.text((x + int(px_w * 0.018), chip_y + int(px_h * 0.018)), 'M=15', font=mono, fill=SUCCESS + (255,))
    d.rounded_rectangle([x + int(px_w * 0.13), chip_y, x + int(px_w * 0.24), chip_y + int(px_h * 0.085)],
                        radius=int(px_h * 0.02), outline=DIAG_INK + (200,), width=int(px_h * 0.005))
    d.text((x + int(px_w * 0.148), chip_y + int(px_h * 0.018)), 'M=34', font=mono, fill=DIAG_INK + (255,))
    return canvas


def glow_sprite(px=256):
    img = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for i in range(120, 0, -1):
        t = i / 120
        a = int(255 * (1 - t) ** 3 * 0.9)
        r = px / 2 * t
        d.ellipse([px / 2 - r, px / 2 - r, px / 2 + r, px / 2 + r], fill=(255, 255, 255, a))
    return img


def spark_sprite(px=128):
    img = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    c = px / 2
    core = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    ImageDraw.Draw(core).ellipse([c - px * 0.22, c - px * 0.22, c + px * 0.22, c + px * 0.22],
                                 fill=(255, 255, 255, 255))
    img.alpha_composite(core.filter(ImageFilter.GaussianBlur(px * 0.06)))
    arm = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    ad = ImageDraw.Draw(arm)
    for k in range(4):
        a = math.pi / 2 * k
        ad.line([c, c, c + math.cos(a) * px * 0.46, c + math.sin(a) * px * 0.46],
                fill=(255, 255, 255, 90), width=max(1, int(px * 0.02)))
    img.alpha_composite(arm.filter(ImageFilter.GaussianBlur(px * 0.025)))
    return img


def save(img, name, size=None):
    out = img.resize((size, size), Image.LANCZOS) if size and img.size != (size, size) else img
    out.save(os.path.join(OUT, name), 'PNG', optimize=True)
    return os.path.join(OUT, name)


def main():
    os.makedirs(OUT, exist_ok=True)
    grain = grain_tile()
    grain.save(os.path.join(OUT, 'paper-grain.png'), 'PNG', optimize=True)

    master = icon_master(2048, grain)
    master1024 = master.resize((1024, 1024), Image.LANCZOS)
    master1024.save(os.path.join(OUT, 'icon-1024.png'), 'PNG', optimize=True)

    # maskable：内容缩进 80% 安全区，四周补满底色，Android 任意裁形都不会切到点阵
    m512 = Image.new('RGBA', (512, 512), BG_TOP + (255,))
    inner = master1024.resize((int(512 * 0.86), int(512 * 0.86)), Image.LANCZOS)
    m512.paste(inner, ((512 - inner.size[0]) // 2, (512 - inner.size[1]) // 2), inner)
    m512.save(os.path.join(OUT, 'icon-maskable-512.png'), 'PNG', optimize=True)

    for s in (512, 192, 180, 96):
        save(master1024, f'icon-{s}.png', s)
    save(master1024, 'apple-touch-icon.png', 180)

    # 16~64 换数字版：点数图在那个尺寸上只剩一团噪点，而盘面本身写的就是数字。
    small_side = 512 * 0.62
    digit_font = load_font(MONO_CANDIDATES, int(small_side * 0.89 / 3 * 0.56))
    small = icon_master(512, grain, glyph='digits', font=digit_font)
    for s in (64, 48, 32, 16):
        save(small, f'icon-{s}.png', s)

    og = og_card(2400, 1260, grain).resize((1200, 630), Image.LANCZOS)
    og.save(os.path.join(OUT, 'og-loshu.png'), 'PNG', optimize=True)

    glow_sprite().save(os.path.join(OUT, 'glow.png'), 'PNG', optimize=True)
    spark_sprite().save(os.path.join(OUT, 'spark.png'), 'PNG', optimize=True)

    for f in sorted(os.listdir(OUT)):
        p = os.path.join(OUT, f)
        with Image.open(p) as im:
            print(f'{f:26s} {im.size[0]}x{im.size[1]} {im.mode} {os.path.getsize(p)}B')


if __name__ == '__main__':
    main()
