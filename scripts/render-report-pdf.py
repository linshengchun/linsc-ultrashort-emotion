"""Render a local LINSC Markdown report to a compact, Chinese-capable PDF."""

from pathlib import Path
import argparse
import re

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle


def parse_args():
    parser = argparse.ArgumentParser(description="Render a LINSC Markdown report to PDF")
    parser.add_argument("--date", required=True, help="交易日 YYYY-MM-DD")
    parser.add_argument("--input", help="Markdown input path")
    parser.add_argument("--output", help="PDF output path")
    return parser.parse_args()


def choose_font():
    for candidate in (r"C:\Windows\Fonts\simhei.ttf", r"C:\Windows\Fonts\Deng.ttf", r"/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"):
        path = Path(candidate)
        if path.exists() and path.suffix.lower() != ".ttc":
            return path
    raise FileNotFoundError("未找到可用中文字体，请安装黑体、等线或 Noto Sans CJK")


def inline(value):
    value = value.replace("—", "-").replace("–", "-")
    value = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", value)
    value = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", value)
    value = value.replace("<", "&lt;").replace(">", "&gt;")
    return value.replace("&lt;b&gt;", "<b>").replace("&lt;/b&gt;", "</b>")


def table_flowable(lines, styles, width):
    rows = []
    for line in lines:
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if cells and not all(re.fullmatch(r":?-+:?", cell) for cell in cells):
            rows.append(cells)
    if not rows:
        return None
    columns = max(len(row) for row in rows)
    rows = [row + [""] * (columns - len(row)) for row in rows]
    data = []
    for row_index, row in enumerate(rows):
        style = styles["CellHead"] if row_index == 0 else styles["CellCN"]
        data.append([Paragraph(inline(cell), style) for cell in row])
    table = Table(data, colWidths=[width / columns] * columns, repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#991b1b")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#fffbf5")),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#d6d3d1")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    return table


def build_story(markdown, styles, width):
    lines = markdown.splitlines()
    story = []
    index = 0
    while index < len(lines):
        line = lines[index]
        if not line.strip():
            index += 1
            continue
        if line.startswith("# "):
            story.append(Paragraph(inline(line[2:]), styles["TitleCN"]))
            index += 1
            continue
        if line.startswith("## "):
            story.append(Paragraph(inline(line[3:]), styles["H2CN"]))
            index += 1
            continue
        if line.startswith("### "):
            story.append(Paragraph(inline(line[4:]), styles["H3CN"]))
            index += 1
            continue
        if line.startswith("| "):
            table_lines = []
            while index < len(lines) and lines[index].startswith("|"):
                table_lines.append(lines[index])
                index += 1
            table = table_flowable(table_lines, styles, width)
            if table:
                story.extend([Spacer(1, 1.2 * mm), table, Spacer(1, 1.2 * mm)])
            continue
        if line.startswith(">"):
            quote = line.lstrip("> ")
            if quote:
                story.append(Paragraph(inline(quote), styles["QuoteCN"]))
            index += 1
            continue
        if line.startswith("- "):
            story.append(Paragraph("- " + inline(line[2:]), styles["BodyCN"]))
            index += 1
            continue
        if line == "---":
            story.append(Spacer(1, 2 * mm))
            index += 1
            continue
        paragraph = [line.strip()]
        index += 1
        while index < len(lines) and lines[index].strip() and not re.match(r"^(#|>|- |\| |---)", lines[index]):
            paragraph.append(lines[index].strip())
            index += 1
        story.append(Paragraph(inline(" ".join(paragraph)), styles["BodyCN"]))
    return story


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor("#e7e5e4"))
    canvas.line(15 * mm, 11 * mm, A4[0] - 15 * mm, 11 * mm)
    canvas.setFont("CN", 7)
    canvas.setFillColor(colors.HexColor("#78716c"))
    canvas.drawString(15 * mm, 7 * mm, "LINSC超短情绪复盘")
    canvas.drawRightString(A4[0] - 15 * mm, 7 * mm, f"第 {doc.page} 页")
    canvas.restoreState()


def main():
    args = parse_args()
    root = Path(__file__).resolve().parents[1]
    source = Path(args.input) if args.input else root / "data" / "reports" / f"{args.date}.md"
    output = Path(args.output) if args.output else root / "public" / "reports" / f"{args.date}.pdf"
    if not source.is_absolute():
        source = root / source
    if not output.is_absolute():
        output = root / output
    if not source.exists():
        raise FileNotFoundError(f"报告不存在：{source}")
    pdfmetrics.registerFont(TTFont("CN", str(choose_font())))
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="TitleCN", parent=styles["Title"], fontName="CN", fontSize=17, leading=21, alignment=TA_CENTER, textColor=colors.HexColor("#7f1d1d"), spaceAfter=7))
    styles.add(ParagraphStyle(name="H2CN", parent=styles["Heading2"], fontName="CN", fontSize=12.5, leading=15, textColor=colors.HexColor("#991b1b"), spaceBefore=8, spaceAfter=4, keepWithNext=True))
    styles.add(ParagraphStyle(name="H3CN", parent=styles["Heading3"], fontName="CN", fontSize=10.5, leading=13, textColor=colors.HexColor("#b45309"), spaceBefore=5, spaceAfter=2, keepWithNext=True))
    styles.add(ParagraphStyle(name="BodyCN", parent=styles["BodyText"], fontName="CN", fontSize=8.6, leading=12.2, spaceAfter=3))
    styles.add(ParagraphStyle(name="QuoteCN", parent=styles["BodyText"], fontName="CN", fontSize=8.7, leading=12.4, leftIndent=7, rightIndent=4, borderPadding=5, borderColor=colors.HexColor("#fecaca"), borderWidth=0.6, backColor=colors.HexColor("#fff7ed"), spaceBefore=2, spaceAfter=4))
    styles.add(ParagraphStyle(name="CellCN", parent=styles["BodyText"], fontName="CN", fontSize=6.6, leading=8.3, spaceAfter=0))
    styles.add(ParagraphStyle(name="CellHead", parent=styles["BodyText"], fontName="CN", fontSize=6.7, leading=8.4, textColor=colors.white, spaceAfter=0))
    output.parent.mkdir(parents=True, exist_ok=True)
    doc = BaseDocTemplate(str(output), pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=13 * mm, bottomMargin=15 * mm, title=f"LINSC超短情绪复盘-{args.date}", author="LINSC")
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="normal")
    doc.addPageTemplates([PageTemplate(id="report", frames=[frame], onPage=footer)])
    doc.build(build_story(source.read_text(encoding="utf-8"), styles, doc.width))
    print(output)


if __name__ == "__main__":
    main()
