#!/usr/bin/env python3
"""画 dmg 窗口的背景图：浅色底、两个图标之间一个箭头。要改样子就改这里，重新跑一遍，把生成的两张 PNG 一起提交：

    python3 scripts/release/dmg/make-background.py

需要 Pillow（`pip install pillow`）。只在改背景时跑，发版不依赖它：CI 直接用提交的 PNG。
输出 background.png（660x400）和 background@2x.png（1320x800），两张的坐标和 dmg.sh 里摆图标的位置对得上：
窗口内容区 660x400，yoyo.app 的图标中心在 (170, 185)，「应用程序」在 (490, 185)。
"""
import os

from PIL import Image, ImageDraw

W, H = 660, 400
APP = (170, 185)
APPLICATIONS = (490, 185)
SCALE = 4  # 先放大四倍画，再缩小，边缘才圆滑


def canvas(factor):
    """顶上淡淡的蓝灰，往下渐变到白：窗口比图高几个像素时，露出来的白边看不出来。"""
    top, bottom = (232, 236, 246), (255, 255, 255)
    image = Image.new("RGB", (W * factor, H * factor))
    draw = ImageDraw.Draw(image)
    for y in range(H * factor):
        t = y / (H * factor - 1)
        color = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom))
        draw.line([(0, y), (W * factor, y)], fill=color)
    return image


def arrow(draw, factor):
    """从 yoyo 指向「应用程序」的箭头：圆头的杆，加一个三角的头。"""
    color = (148, 160, 188)
    y = APP[1] * factor
    x0 = (APP[0] + 100) * factor
    x1 = (APPLICATIONS[0] - 100) * factor
    thick = 9 * factor
    head = 26 * factor
    # 杆（两头圆）
    draw.line([(x0, y), (x1 - head, y)], fill=color, width=thick)
    for x in (x0, x1 - head):
        draw.ellipse([x - thick // 2, y - thick // 2, x + thick // 2, y + thick // 2], fill=color)
    # 头
    draw.polygon([(x1 - head, y - head), (x1, y), (x1 - head, y + head)], fill=color)


def render(factor):
    big = canvas(SCALE * factor)
    arrow(ImageDraw.Draw(big), SCALE * factor)
    return big.resize((W * factor, H * factor), Image.LANCZOS)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    render(1).save(os.path.join(here, "background.png"), dpi=(72, 72), optimize=True)
    render(2).save(os.path.join(here, "background@2x.png"), dpi=(144, 144), optimize=True)


if __name__ == "__main__":
    main()
