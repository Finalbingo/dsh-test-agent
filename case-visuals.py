import json
import os
import sys
from pathlib import Path


def make_figure(spec, target):
    from PIL import Image, ImageDraw, ImageFont

    if "input" in spec:
        with Image.open(spec["input"]) as original:
            image = original.convert("RGBA")
        if "bounds" in spec:
            x, y, w, h = spec["bounds"]
            left, top = round(x * image.width), round(y * image.height)
            right = max(left + 1, round((x + w) * image.width))
            bottom = max(top + 1, round((y + h) * image.height))
            if spec["crop"]:
                pad = max(8, max(right - left, bottom - top) // 4)
                offset_x, offset_y = max(0, left - pad), max(0, top - pad)
                image = image.crop((offset_x, offset_y, min(image.width, right + pad),
                                    min(image.height, bottom + pad)))
                left, right = left - offset_x, right - offset_x
                top, bottom = top - offset_y, bottom - offset_y
            scale = min(960 / image.width, 720 / image.height, 3 if spec["crop"] else 1)
            image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))),
                                 Image.Resampling.LANCZOS)
            box = tuple(round(value * scale) for value in (left, top, right, bottom))
            draw = ImageDraw.Draw(image)
            draw.rectangle(box, outline="white", width=5)
            draw.rectangle(box, outline="#0068ec", width=3)
        else:
            image.thumbnail((960, 720))
    else:
        lines = spec["lines"]
        font_path = "/System/Library/Fonts/STHeiti Medium.ttc"
        font = ImageFont.truetype(font_path, 24) if Path(font_path).exists() else ImageFont.load_default(24)
        measure = ImageDraw.Draw(Image.new("RGB", (1, 1)))
        width = max(540, round(max(measure.textlength(line, font=font) for line in lines)) + 48)
        image = Image.new("RGB", (width, 36 * len(lines) + 30), "#f0f5ff")
        draw = ImageDraw.Draw(image)
        for index, line in enumerate(lines):
            draw.text((24, 16 + index * 36), line, font=font, fill="#16335c")
    image.save(target, format="PNG")



def make_vision(spec, target):
    """Vision input: crop from the original image, never draw a locator box."""
    from PIL import Image

    with Image.open(spec["input"]) as original:
        image = original.convert("RGBA")
    left = top = right = bottom = None
    if "bounds" in spec:
        x, y, w, h = spec["bounds"]
        left, top = round(x * image.width), round(y * image.height)
        right = max(left + 1, round((x + w) * image.width))
        bottom = max(top + 1, round((y + h) * image.height))
        pad = spec.get("pad", 0.25)
        pad_x, pad_y = round((right - left) * pad), round((bottom - top) * pad)
        box_left, box_top = max(0, left - pad_x), max(0, top - pad_y)
        box_right, box_bottom = min(image.width, right + pad_x), min(image.height, bottom + pad_y)
        image = image.crop((box_left, box_top, box_right, box_bottom))
        left, right = left - box_left, right - box_left
        top, bottom = top - box_top, bottom - box_top
    max_width = spec.get("max_width", 1400)
    max_height = spec.get("max_height", 1000)
    scale = min(max_width / image.width, max_height / image.height, 1)
    if scale < 1:
        image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))),
                             Image.Resampling.LANCZOS)
    image.save(target, format="PNG")


def embed_images(spec, target):
    from openpyxl import load_workbook
    from openpyxl.drawing.image import Image
    from openpyxl.utils import get_column_letter

    workbook = load_workbook(spec["workbook"])
    sheet = workbook["追溯与图片"]
    for row, figures in enumerate(spec["rows"], 2):
        for index, figure in enumerate(figures):
            image = Image(figure)
            scale = min(320 / image.width, 180 / image.height, 1)
            image.width = max(1, round(image.width * scale))
            image.height = max(1, round(image.height * scale))
            column = get_column_letter(8 + index)
            sheet.cell(1, 8 + index, f"配图 {index + 1}")
            sheet.column_dimensions[column].width = 48
            sheet.add_image(image, f"{column}{row}")
            sheet.row_dimensions[row].height = max(sheet.row_dimensions[row].height or 0,
                                                   round(image.height * 0.75) + 8)
    workbook.save(target)


mode, target = sys.argv[1:]
spec = json.load(sys.stdin)
temp = target + f".{os.getpid()}.tmp"
try:
    {"figure": make_figure, "vision": make_vision, "embed": embed_images, "workbook": embed_images}[mode](spec, temp)
    os.replace(temp, target)
finally:
    Path(temp).unlink(missing_ok=True)
