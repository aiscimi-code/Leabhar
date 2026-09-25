#!/usr/bin/env python3
"""
generate-synthetic-invoice-pdfs.py — synthetic PDF invoice generator for the
extraction-pipeline test suite (issue #237).

Produces fictitious supplier invoices, sales invoices, credit notes, a pro-forma,
a statement and degraded 'scanned' image PDFs into fixtures/documents/synthetic/,
plus invoice_index.csv with the ground-truth fields for scoring extraction.

These are NOT the real, anonymised invoices required by #202 (see #218, formerly
its §J) — never use this output as evidence for a real VAT figure or match it
against a real bank transaction. All entities here are fictitious.

Requires: reportlab, Pillow  (pip install reportlab pillow)
No network, no external assets.
"""
import os, random, csv
from datetime import date, timedelta
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, white
from PIL import Image, ImageDraw, ImageFont, ImageFilter

random.seed(42)
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO_ROOT, "fixtures", "documents", "synthetic")
os.makedirs(OUT, exist_ok=True)
W, H = A4
INK, GREY, LIGHT = HexColor("#1a1a1a"), HexColor("#666666"), HexColor("#f2f2f2")
NAVY, TEAL, MAROON = HexColor("#1F3864"), HexColor("#0F766E"), HexColor("#7F1D1D")

# ------------------------------------------------------------------ helpers
def wrap(text, font, size, maxw, c):
    words, lines, cur = text.split(), [], ""
    for w_ in words:
        t = (cur + " " + w_).strip()
        if c.stringWidth(t, font, size) <= maxw: cur = t
        else: lines.append(cur); cur = w_
    if cur: lines.append(cur)
    return lines or [""]

def block(c, x, y, lines, font="Helvetica", size=9, leading=12, color=INK):
    c.setFont(font, size); c.setFillColor(color)
    for ln in lines:
        c.drawString(x, y, ln); y -= leading
    return y

def table(c, x, y, widths, rows, header_fill=NAVY, grid=True, font="Helvetica",
          size=8.5, row_h=16, head_h=18, align_right_from=1, alt_shade=True):
    total_w = sum(widths)
    c.setFont(font, size)
    # header
    c.setFillColor(header_fill); c.rect(x, y-head_h, total_w, head_h, fill=1, stroke=0)
    c.setFillColor(white)
    for i, cell in enumerate(rows[0]):
        tx = x + sum(widths[:i]) + 4
        c.drawString(tx, y-head_h+5, str(cell))
    y -= head_h
    for r_i, row in enumerate(rows[1:]):
        if alt_shade and r_i % 2 == 1:
            c.setFillColor(LIGHT); c.rect(x, y-row_h, total_w, row_h, fill=1, stroke=0)
        c.setFillColor(INK)
        for i, cell in enumerate(row):
            tx = x + sum(widths[:i]) + 4
            s = str(cell)
            if i >= align_right_from:
                c.drawRightString(x + sum(widths[:i+1]) - 4, y-row_h+5, s)
            else:
                c.drawString(tx, y-row_h+5, s)
        if grid:
            c.setStrokeColor(HexColor("#bbbbbb")); c.setLineWidth(0.5)
            c.rect(x, y-row_h, total_w, row_h, fill=0, stroke=1)
        y -= row_h
    if grid:
        c.setStrokeColor(HexColor("#888888")); c.setLineWidth(0.8)
        c.rect(x, y, total_w, head_h + row_h*(len(rows)-1), fill=0, stroke=1)
    return y

def totals_box(c, x, y, net, vat, gross, currency="EUR", label="TOTAL"):
    rows = [("Net", net), (f"VAT", vat), (f"{label} ({currency})", gross)]
    for i, (lab, amt) in enumerate(rows):
        bold = i == 2
        c.setFont("Helvetica-Bold" if bold else "Helvetica", 9.5)
        c.setFillColor(INK)
        c.drawString(x, y, lab)
        c.drawRightString(x + 150, y, amt if isinstance(amt, str) else f"{amt:,.2f}")
        if bold:
            c.setStrokeColor(INK); c.setLineWidth(1); c.line(x, y+4, x+150, y+4)
        y -= 14
    return y

def vat_block_ie(c, x, y, vat_no):
    return block(c, x, y, [f"VAT No: {vat_no}"], size=8, color=GREY)

# ------------------------------------------------------------------ templates
def t_classic(c, s):
    c.setStrokeColor(NAVY); c.setLineWidth(2); c.rect(15*mm, H-40*mm, W-30*mm, 25*mm)
    block(c, 20*mm, H-28*mm, [s["issuer"]["name"]], font="Helvetica-Bold", size=15, color=NAVY)
    block(c, 20*mm, H-35*mm, s["issuer"]["addr"], size=8, color=GREY, leading=10)
    vat_block_ie(c, W-70*mm, H-28*mm, s["issuer"]["vat"])
    c.setFont("Helvetica-Bold", 22); c.setFillColor(NAVY)
    c.drawRightString(W-20*mm, H-60*mm, s["doctitle"])
    y = block(c, 20*mm, H-60*mm, [f"No: {s['inv_no']}", f"Date: {s['date']}",
             f"Due: {s['due']}", f"Terms: {s.get('terms','30 days')}"], size=9, leading=13)
    y = block(c, 20*mm, H-78*mm, ["BILL TO:"], font="Helvetica-Bold", size=8, color=GREY)
    y = block(c, 20*mm, y, [s["recipient"]["name"]] + s["recipient"]["addr"], size=9, leading=12)
    if s["recipient"].get("vat"): block(c, 20*mm, y-2, [f"Customer VAT: {s['recipient']['vat']}"], size=8, color=GREY)
    y2 = block(c, W-90*mm, H-78*mm, ["FROM:"], font="Helvetica-Bold", size=8, color=GREY)
    block(c, W-90*mm, y2, [s["issuer"]["phone"], s["issuer"]["email"]], size=8, color=GREY, leading=11)
    rows = [["Description", "Qty", "Unit", "Net", "VAT%", "Gross"]] + s["rows"]
    y = table(c, 20*mm, H-105*mm, [70*mm, 15*mm, 22*mm, 25*mm, 15*mm, 25*mm], rows)
    y = totals_box(c, W-75*mm, y-12, s["net"], s["vat"], s["gross"], s["currency"], s.get("totlabel","TOTAL"))
    notes(c, 20*mm, min(y, H-150*mm) - 10, s)

def t_modern(c, s):
    c.setFillColor(s.get("band", TEAL)); c.rect(0, H-24*mm, W, 24*mm, fill=1, stroke=0)
    block(c, 20*mm, H-13*mm, [s["issuer"]["name"]], font="Helvetica-Bold", size=16, color=white)
    block(c, 20*mm, H-19*mm, [s["issuer"]["addr"][0]], size=8, color=white)
    c.setFillColor(white); c.setFont("Helvetica", 8)
    c.drawRightString(W-20*mm, H-13*mm, f"VAT {s['issuer']['vat']}")
    c.drawRightString(W-20*mm, H-17*mm, s["issuer"]["email"])
    c.setFillColor(s.get("band", TEAL)); c.setFont("Helvetica-Bold", 20)
    c.drawString(20*mm, H-45*mm, s["doctitle"])
    c.setFillColor(GREY); c.setFont("Helvetica", 9)
    c.drawRightString(W-20*mm, H-45*mm, f"{s['inv_no']}  |  {s['date']}  |  due {s['due']}")
    c.setStrokeColor(HexColor("#dddddd")); c.setLineWidth(1); c.line(20*mm, H-50*mm, W-20*mm, H-50*mm)
    y = block(c, 20*mm, H-58*mm, [s["recipient"]["name"]] + s["recipient"]["addr"], size=9, leading=12)
    rows = [["Description", "Qty", "Unit", "Net", "VAT%", "Gross"]] + [r for r in s["rows"]]
    y = table(c, 20*mm, H-85*mm, [66*mm, 14*mm, 22*mm, 26*mm, 16*mm, 26*mm], rows,
              header_fill=s.get("band", TEAL), grid=False, alt_shade=False)
    y = totals_box(c, W-70*mm, y-14, s["net"], s["vat"], s["gross"], s["currency"], s.get("totlabel","TOTAL"))
    notes(c, 20*mm, min(y, 150*mm) - 6, s)

def t_letterhead(c, s):
    c.setFillColor(s.get("band", MAROON)); c.rect(0, H-18*mm, W, 18*mm, fill=1, stroke=0)
    block(c, 20*mm, H-11*mm, [s["issuer"]["name"].upper()], font="Times-Bold", size=14, color=white)
    block(c, W-90*mm, H-11*mm, s["issuer"]["addr"], size=7.5, color=white, leading=9)
    c.setFont("Times-Bold", 18); c.setFillColor(INK)
    c.drawCentredString(W/2, H-40*mm, s["doctitle"])
    c.setFont("Times-Roman", 10)
    c.drawCentredString(W/2, H-48*mm, f"Number: {s['inv_no']}    Date: {s['date']}    Terms: {s.get('terms','30 days net')}")
    y = block(c, 20*mm, H-62*mm, [s["recipient"]["name"]] + s["recipient"]["addr"], font="Times-Roman", size=10, leading=12)
    rows = [["Item", "Description", "Qty", "Unit Price", "Amount"]] + s["rows5"]
    y = table(c, 20*mm, H-95*mm, [15*mm, 80*mm, 15*mm, 30*mm, 30*mm], rows,
              header_fill=s.get("band", MAROON), font="Times-Roman", size=9)
    y = totals_box(c, W-75*mm, y-14, s["net"], s["vat"], s["gross"], s["currency"], s.get("totlabel","TOTAL"))
    c.setFont("Times-Italic", 8.5); c.setFillColor(GREY)
    c.drawCentredString(W/2, 30*mm, f"{s['issuer']['name']} - Registered in Ireland - VAT {s['issuer']['vat']}")
    notes(c, 20*mm, min(y, 140*mm) - 8, s, font="Times-Italic")

def t_wholesale(c, s):
    c.setFont("Courier-Bold", 13)
    block(c, 20*mm, H-18*mm, [s["issuer"]["name"]], font="Courier-Bold", size=13)
    block(c, 20*mm, H-25*mm, s["issuer"]["addr"], size=7.5, color=GREY, leading=9)
    vat_block_ie(c, W-70*mm, H-18*mm, s["issuer"]["vat"])
    c.setFont("Courier-Bold", 11); c.drawRightString(W-20*mm, H-32*mm, s["doctitle"])
    c.setFont("Courier", 8.5)
    c.drawString(20*mm, H-38*mm, f"INVOICE NO: {s['inv_no']}   DATE: {s['date']}   DUE: {s['due']}   ACCOUNT: {s.get('acct','HP-2088')}")
    c.drawString(20*mm, H-44*mm, f"SOLD TO: {s['recipient']['name']}, {' '.join(s['recipient']['addr'][:2])}")
    rows = [["CODE", "DESCRIPTION", "QTY", "PRICE", "NET", "VAT%", "GROSS"]] + s["rows7"]
    y = table(c, 20*mm, H-55*mm, [18*mm, 60*mm, 12*mm, 22*mm, 24*mm, 14*mm, 24*mm], rows,
              header_fill=HexColor("#444444"), font="Courier", size=8, row_h=13, head_h=15)
    y = totals_box(c, W-75*mm, y-10, s["net"], s["vat"], s["gross"], s["currency"], s.get("totlabel","TOTAL"))
    notes(c, 20*mm, min(y, 120*mm) - 6, s, font="Courier", size=8)

def notes(c, x, y, s, font="Helvetica", size=8):
    c.setFont(font, size); c.setFillColor(GREY)
    for ln in s.get("notes", []):
        for wln in wrap(ln, font, size, W-40*mm, c):
            c.drawString(x, y, wln); y -= 10.5
    if s.get("paydetails"):
        y -= 4
        for ln in [f"Payment: {s['paydetails']}"]:
            c.drawString(x, y, ln); y -= 10.5

# ---- image-based "scanned" invoice (forces OCR path in the intake pipeline)
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONTB = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
def t_scan(path, s, skew=2.2, contrast=0.55, noise=14):
    img = Image.new("RGB", (1240, 1754), (250, 250, 246))
    d = ImageDraw.Draw(img)
    f, fb = ImageFont.truetype(FONT, 26), ImageFont.truetype(FONTB, 30)
    fs = ImageFont.truetype(FONT, 22)
    ink = (int(40*contrast)+60,)*3
    y = 120
    d.text((110, y), s["issuer"]["name"], font=fb, fill=ink); y += 70
    for ln in s["issuer"]["addr"]:
        d.text((110, y), ln, font=fs, fill=ink); y += 34
    d.text((110, y+10), f"VAT No: {s['issuer']['vat']}", font=fs, fill=ink)
    d.text((750, 120), s["doctitle"], font=fb, fill=ink)
    d.text((750, 170), f"No: {s['inv_no']}", font=fs, fill=ink)
    d.text((750, 205), f"Date: {s['date']}", font=fs, fill=ink)
    y += 90
    d.text((110, y), "To: " + s["recipient"]["name"], font=fs, fill=ink); y += 50
    for ln in s["recipient"]["addr"][:2]:
        d.text((140, y), ln, font=fs, fill=ink); y += 34
    y += 40
    d.line((110, y, 1130, y), fill=ink, width=2); y += 30
    tot_net = tot_gross = 0.0
    for desc, qty, unit, net, vrate, gross in s["rows"]:
        qty, unit, net, gross = int(qty), float(unit), float(net), float(gross)
        d.text((110, y), desc[:52], font=fs, fill=ink)
        d.text((700, y), f"{qty} x {unit:,.2f}", font=fs, fill=ink)
        d.text((980, y), f"{gross:,.2f}", font=fs, fill=ink)
        tot_net += net; tot_gross += gross; y += 36
    y += 20; d.line((110, y, 1130, y), fill=ink, width=2); y += 40
    d.text((800, y), f"Net:  {tot_net:,.2f}", font=fs, fill=ink); y += 36
    d.text((800, y), f"VAT:  {tot_gross-tot_net:,.2f}", font=fs, fill=ink); y += 36
    d.text((800, y), f"TOTAL:  {tot_gross:,.2f}", font=fb, fill=ink)
    if s.get("notes"):
        y += 90
        for ln in s["notes"]:
            d.text((110, y), ln[:95], font=fs, fill=ink); y += 34
    # degrade: rotate, blur slightly, add noise, save as image-only PDF
    img = img.rotate(skew, resample=Image.BICUBIC, expand=False, fillcolor=(250, 250, 246))
    px = img.load()
    for _ in range(7000):
        x_, y_ = random.randint(0, 1239), random.randint(0, 1753)
        r, g, b = px[x_, y_]
        n = random.randint(-noise, noise)
        px[x_, y_] = (max(0, min(255, r+n)), max(0, min(255, g+n)), max(0, min(255, b+n)))
    img = img.filter(ImageFilter.GaussianBlur(0.4))
    img.save(path, "PDF", resolution=150)

# ------------------------------------------------------------------ data
HP = {"name": "Harbour Paws Pet Care Ltd", "addr": ["12 George's Street Lower", "Dun Laoghaire, Co. Dublin, A96 TF12"],
      "vat": "IE3384127K", "phone": "+353 1 284 0091", "email": "accounts@harbourpaws.ie"}
WA = {"name": "Wild Atlantic Woodcraft Ltd", "addr": ["4 O'Connell Street", "Sligo, F91 AB12"],
      "vat": "IE9827334T", "phone": "+353 71 914 2230", "email": "hello@wildatlanticwoodcraft.ie"}

def issuer(name, addr, vat, phone, email): return {"name": name, "addr": addr, "vat": vat, "phone": phone, "email": email}

DOCS = [
 dict(file="01_hp_inv_vanguard_daycare.pdf", template="modern", doctitle="INVOICE", direction="sales",
      issuer=HP, recipient={"name":"Vanguard Tech Dublin Ltd","addr":["Block C, EastPoint Business Park","Dublin 3, D03 KX44"],"vat":"IE6401127A"},
      inv_no="INV-25-014", date="14/05/2025", due="28/05/2025", currency="EUR", terms="14 days",
      rows=[["Office dog-daycare contract (14 dogs) - May 2025", 1, "1,950.00", "1,950.00", "13.5%", "2,213.25"]],
      net=1950.00, vat=263.25, gross=2213.25, quirks="service_vat_13_5|b2b"),
 dict(file="02_hp_inv_keane_wholesale.pdf", template="classic", doctitle="INVOICE", direction="sales",
      issuer=HP, recipient={"name":"Keane Veterinary Ltd","addr":["15 Sandford Road","Ranelagh, Dublin 6, D06 X2H1"],"vat":"IE8133765C"},
      inv_no="INV-24-007", date="09/02/2024", due="10/03/2024", currency="EUR",
      rows=[["Hills Science Diet Canine 12kg (x8)", 8, "58.40", "467.20", "23%", "574.66"],
            ["Frontline Plus Flea Treatment (x24)", 24, "9.90", "237.60", "23%", "292.25"],
            ["Ancol Nylon Leash 1.2m (x30)", 30, "6.75", "202.50", "23%", "249.08"],
            ["Cardboard counter display (x1)", 1, "150.00", "150.00", "23%", "184.50"]],
      net=1057.30, vat=243.18, gross=1300.48, quirks="multi_line|goods_vat_23"),
 dict(file="03_hp_inv_ballsbridge_mixed.pdf", template="wholesale", doctitle="TAX INVOICE", direction="sales",
      issuer=HP, recipient={"name":"Ballsbridge Pet Hotel","addr":["18 Serpentine Avenue","Ballsbridge, Dublin 4, D04 W2F3"],"vat":"IE5560921L"},
      inv_no="INV-26-019", date="22/07/2026", due="21/08/2026", currency="EUR", acct="HP-2088",
      rows7=[["GR-001","Grooming - full clip large dog (hotel guests)", 22, "52.00", "1,144.00", "13.5%", "1,298.44"],
             ["PR-014","Canagan Salmon dry food 6kg", 12, "41.50", "498.00", "23%", "612.54"],
             ["PR-022","Antler chew large (natural)", 40, "7.25", "290.00", "23%", "356.70"]],
      rows=[["Grooming services large dogs (per contract rate card)", 22, "52.00", "1144.00", "13.5%", "1298.44"],
            ["Canagan Salmon dry food 6kg", 12, "41.50", "498.00", "23%", "612.54"],
            ["Antler chew large (natural)", 40, "7.25", "290.00", "23%", "356.70"]],
      net=1932.00, vat=335.68, gross=2267.68, quirks="mixed_vat_bands_13_5_and_23"),
 dict(file="04_hp_inv_coastal_aquatics.pdf", template="letterhead", doctitle="Invoice", direction="sales",
      issuer=HP, recipient={"name":"Coastal Aquatics Ltd","addr":["Unit 7, Harbour Road","Howth, Dublin 13, D13 P6Y2"],"vat":"IE9024158F"},
      inv_no="INV-25-031", date="03/10/2025", due="02/11/2025", currency="EUR",
      rows5=[["1","TetraMin tropical flake 1L tub", 20, "8.90", "178.00"],
             ["2","API Freshwater Master Test Kit", 10, "24.50", "245.00"],
             ["3","Marina LED aquarium kit 60L", 3, "129.00", "387.00"],
             ["4","Live aquatic plants assorted (trade pack)", 6, "11.25", "67.50"]],
      rows=[["TetraMin tropical flake 1L tub", 20, "8.90", "178.00", "23%", "218.94"],
            ["API Freshwater Master Test Kit", 10, "24.50", "245.00", "23%", "301.35"],
            ["Marina LED aquarium kit 60L", 3, "129.00", "387.00", "23%", "476.01"],
            ["Live aquatic plants assorted (trade pack)", 6, "11.25", "67.50", "23%", "83.03"]],
      net=877.50, vat=201.83, gross=1079.33, quirks="wrong_reference_in_books|goods_vat_23"),
 # ---- purchases ----
 dict(file="05_pi_harbour_retail_fitout.pdf", template="classic", doctitle="INVOICE", direction="purchase",
      issuer=issuer("Harbour Retail Fit-Out Ltd",["Unit 3, Cherry Orchard Industrial Estate","Dublin 10, D10 XA41"],"IE6341871B","+353 1 623 4480","accounts@hrfitout.ie"),
      recipient=HP, inv_no="PI-24-001", date="12/02/2024", due="13/03/2024", currency="EUR", terms="30 days net monthly",
      rows=[["Shop fit-out - George's St premises (labour & materials, per quote Q-1187)", 1, "28,000.00", "28,000.00", "23%", "34,440.00"]],
      net=28000.00, vat=6440.00, gross=34440.00, quirks="large_capex|single_line"),
 dict(file="06_pi_irish_grooming_equipment.pdf", template="letterhead", doctitle="Invoice", direction="purchase",
      issuer=issuer("Irish Grooming Equipment Ltd",["Kilbarrack Industrial Park","Dublin 5, D05 RY66"],"IE5529084E","+353 1 832 7719","sales@irishgroomingequip.ie"),
      recipient=HP, inv_no="PI-24-002", date="05/03/2024", due="04/04/2024", currency="EUR",
      rows5=[["1","Hydro bath professional stainless 110L", 1, "2,950.00", "2,950.00"],
             ["2","Variable-speed stand dryer (x2)", 2, "640.00", "1,280.00"],
             ["3","Hydraulic grooming table large", 2, "895.00", "1,790.00"],
             ["4","Clipper set Andis AGC2 + blades (x4)", 4, "345.00", "1,380.00"],
             ["5","Installation & commissioning on site", 1, "1,400.00", "1,400.00"],
             ["6","Grooming noose & loop kit (x12)", 12, "8.33", "99.96"],
             ["7","Disposal of packaging (environmental levy)", 1, "500.04", "500.04"]],
      rows=[["Hydro bath professional stainless 110L", 1, "2950.00", "2950.00", "23%", "3628.50"],
            ["Variable-speed stand dryer", 2, "640.00", "1280.00", "23%", "1574.40"],
            ["Hydraulic grooming table large", 2, "895.00", "1790.00", "23%", "2201.70"],
            ["Clipper set Andis AGC2 + blades", 4, "345.00", "1380.00", "23%", "1697.40"],
            ["Installation & commissioning", 1, "1400.00", "1400.00", "23%", "1722.00"],
            ["Grooming noose & loop kit", 12, "8.33", "99.96", "23%", "122.95"],
            ["Disposal of packaging (env. levy)", 1, "500.04", "500.04", "23%", "615.05"]],
      net=9400.00, vat=2162.00, gross=11562.00, quirks="capex|many_lines"),
 dict(file="07_pi_omalley_motors_van.pdf", template="letterhead", doctitle="Sales Invoice", direction="purchase",
      issuer=issuer("O'Malley Motors Ltd",["Riverside Motors, N11 Business Park","Bray, Co. Wicklow, A98 RD44"],"IE4892207M","+353 1 276 5540","fleet@omalleymotors.ie"),
      recipient=HP, inv_no="PI-25-003", date="15/07/2025", due="14/08/2025", currency="EUR",
      rows5=[["1","Citroen Berlingo Enterprise Pro 1.5 BlueHDi", 1, "26,500.00", "26,500.00"],
             ["2","Delivery & number plates", 1, "0.00", "0.00"]],
      rows=[["Citroen Berlingo Enterprise Pro 1.5 BlueHDi (VIN VF7******L014289)", 1, "26500.00", "26500.00", "23%", "32595.00"],
            ["Delivery & number plates", 1, "0.00", "0.00", "23%", "0.00"]],
      net=26500.00, vat=6095.00, gross=32595.00, terms="30 days",
      notes=["Vehicle registration: 252-D-88471. Road tax & plates included.", "Trade-in of existing vehicle agreed separately (see settlement letter)."],
      quirks="vehicle_capex|vin_in_description"),
 dict(file="08_cn_groompro_credit.pdf", template="modern", doctitle="CREDIT NOTE", direction="purchase",
      issuer=issuer("GroomPro Supplies Ireland",["Unit 12, Northwest Business Park","Ballycoolin, Dublin 15, D15 PP8W"],"IE7145529D","+353 1 820 6673","credit@groompro.ie"),
      recipient=HP, inv_no="CN-PI-26-002", date="30/04/2026", due="", currency="EUR", totlabel="CREDIT (EUR)",
      rows=[["Credit - 6 x Wahl ShowPro shampoo 5L (damaged in transit, returned 22/04)", 6, "-13.05", "-78.29", "23%", "-96.30"]],
      net=-78.29, vat=-18.01, gross=-96.30, quirks="credit_note|negative_amounts"),
 dict(file="09_pi_whiskers_dense.pdf", template="wholesale", doctitle="INVOICE", direction="purchase",
      issuer=issuer("Whiskers & Co Pet Foods Ltd",["The Old Granary, Mill Road","Naas, Co. Kildare, W91 HN30"],"IE6273105A","+353 45 879 320","invoices@whiskerspetfoods.ie"),
      recipient=HP, inv_no="PI-26-118", date="06/08/2026", due="05/09/2026", currency="EUR", acct="HP-2088",
      rows7=[[f"FD-{100+i}", f"SKU line {i+1} - assorted pet food & treats", random.randint(2,24), round(random.uniform(4,38),2), 0, "23%", 0] for i in range(18)],
      rows=None, net=1716.79, vat=394.86, gross=2111.65,
      notes=["Order ref: HP/2026/08-114. Delivered 06/08 via DPD, 3 pallets.",
             "E&OE. Goods remain property of Whiskers & Co until paid in full."],
      quirks="many_lines_18|goods_vat_23|retention_of_title_clause"),
 dict(file="10_pi_packright_no_vat_no.pdf", template="classic", doctitle="Invoice", direction="purchase",
      issuer=issuer("PackRight Ireland",["21C Greenmount Industrial Estate","Harold's Cross, Dublin 12, D12 EK67"],"","+353 1 405 8892","sales@packright.ie"),
      recipient=HP, inv_no="PI-26-120", date="10/08/2026", due="09/09/2026", currency="EUR",
      rows=[["Mailing boxes 300x200x150 (bundle of 100)", 3, "28.90", "86.70", "23%", "106.64"],
            ["Kraft tape 48mm x 66m (box of 36)", 1, "17.94", "17.94", "23%", "22.07"]],
      net=104.64, vat=24.07, gross=128.71, quirks="missing_supplier_vat_number|small_supplier"),
 dict(file="11_pi_groompro_565.pdf", template="classic", doctitle="INVOICE", direction="purchase",
      issuer=issuer("GroomPro Supplies Ireland",["Unit 12, Northwest Business Park","Ballycoolin, Dublin 15, D15 PP8W"],"IE7145529D","+353 1 820 6673","sales@groompro.ie"),
      recipient=HP, inv_no="PI-26-133", date="06/05/2026", due="05/06/2026", currency="EUR",
      rows=[["Wahl KM10 clipper (x2)", 2, "149.00", "298.00", "23%", "366.54"],
            ["ShowPro shampoo 5L (x6)", 6, "13.05", "78.30", "23%", "96.31"],
            ["Blade wash & coolant 400ml (x6)", 6, "8.35", "50.10", "23%", "61.62"],
            ["Slicker brush pro large (x2)", 2, "8.50", "17.00", "23%", "20.91"],
            ["Groomer starter combo pack (x1)", 1, "16.73", "16.73", "23%", "20.58"]],
      net=460.13, vat=105.83, gross=565.96,
      notes=["Credit note CN-PI-26-002 of EUR 96.30 applied to account on 06/05 - balance due EUR 469.66."],
      quirks="related_credit_note|payment_net_of_credit_note"),
 dict(file="12_pi_yorkshire_gbp_reverse.pdf", template="modern", doctitle="INVOICE", direction="purchase",
      issuer=issuer("Yorkshire Pet Supplies Ltd",["Unit 8, Doncaster Trade Park","Doncaster DN1 2NP, United Kingdom"],"GB 412 8856 39","+44 1302 745 811","accounts@yorkshirepet.co.uk"),
      recipient=HP, inv_no="YPS-88412", date="28/07/2026", due="27/08/2026", currency="GBP", totlabel="TOTAL (GBP)",
      rows=[["Burns Original Chicken & Rice 12kg (x10)", 10, "88.00", "880.00", "0%", "880.00"],
            ["James Wellbeloved Puppy 7.5kg (x8)", 8, "45.00", "360.00", "0%", "360.00"]],
      net=1240.00, vat=0.00, gross=1240.00,
      notes=["Export supply - zero-rated for UK VAT purposes. Irish VAT due under the reverse charge at the applicable rate.",
             "Pay by international transfer: Sort 20-44-11, Acct 55881244, ref YPS-88412."],
      quirks="foreign_currency_gbp|reverse_charge|zero_vat_band", band=NAVY),
 dict(file="13_pi_dublin_pet_wholesale.pdf", template="classic", doctitle="INVOICE", direction="purchase",
      issuer=issuer("Dublin Pet Wholesale Ltd",["Rosemount Business Park","Ballycoolin, Dublin 15, D15 X3K9"],"IE5881023G","+353 1 646 2095","accounts@dublinpetwholesale.ie"),
      recipient=HP, inv_no="PI-25-073", date="14/11/2025", due="14/12/2025", currency="EUR",
      rows=[["Flexi Classic tape lead 5m (x20)", 20, "9.65", "193.00", "23%", "237.39"],
            ["Kong Classic red large (x15)", 15, "11.85", "177.75", "23%", "218.63"],
            ["Grooming slicker twin pack (x8)", 8, "12.34", "98.72", "23%", "121.43"],
            ["Order short by 2 units of item 3 - credit pending", 1, "-66.33", "-66.33", "23%", "-81.59"]],
      net=403.14, vat=92.72, gross=495.86,
      notes=["Part-paid by EFT 14/12/2025 (80% of invoice). Balance disputed pending credit for short delivery."],
      quirks="part_paid_in_books|credit_pending|rounding"),
 dict(file="13b_pi_dublin_pet_wholesale_resent.pdf", template="classic", doctitle="INVOICE", direction="purchase",
      issuer=issuer("Dublin Pet Wholesale Ltd",["Rosemount Business Park","Ballycoolin, Dublin 15, D15 X3K9"],"IE5881023G","+353 1 646 2095","accounts@dublinpetwholesale.ie"),
      recipient=HP, inv_no="PI-25-073", date="14/11/2025", due="14/12/2025", currency="EUR",
      rows=[["Flexi Classic tape lead 5m (x20)", 20, "9.65", "193.00", "23%", "237.39"],
            ["Kong Classic red large (x15)", 15, "11.85", "177.75", "23%", "218.63"],
            ["Grooming slicker twin pack (x8)", 8, "12.34", "98.72", "23%", "121.43"],
            ["Order short by 2 units of item 3 - credit pending", 1, "-66.33", "-66.33", "23%", "-81.59"]],
      net=403.14, vat=92.72, gross=495.86, quirks="duplicate_resend|dedup_test"),
 dict(file="14_pf_atlantic_print_proforma.pdf", template="letterhead", doctitle="PRO-FORMA INVOICE", direction="purchase",
      issuer=issuer("Atlantic Print & Design",["4b Convent Lane","Dun Laoghaire, Co. Dublin, A96 FK21"],"IE7012298B","+353 1 280 4563","studio@atlanticprint.ie"),
      recipient=HP, inv_no="PF-2026-011", date="02/09/2026", due="", currency="EUR", totlabel="TOTAL DUE (EUR)",
      rows5=[["1","A-board pavement sign - design & print", 1, "220.00", "220.00"],
             ["2","Loyalty cards x1000 (350gsm, matt laminate)", 1, "130.00", "130.00"]],
      rows=[["A-board pavement sign - design & print", 1, "220.00", "220.00", "23%", "270.60"],
            ["Loyalty cards x1000 (350gsm, matt laminate)", 1, "130.00", "130.00", "23%", "159.90"]],
      net=350.00, vat=80.50, gross=430.50,
      notes=["PRO-FORMA: this is not a VAT invoice. Goods will follow on receipt of payment."],
      quirks="proforma_not_a_tax_invoice"),
 dict(file="15_stmt_whiskers_jul2026.pdf", template="classic", doctitle="STATEMENT OF ACCOUNT", direction="purchase",
      issuer=issuer("Whiskers & Co Pet Foods Ltd",["The Old Granary, Mill Road","Naas, Co. Kildare, W91 HN30"],"IE6273105A","+353 45 879 320","invoices@whiskerspetfoods.ie"),
      recipient=HP, inv_no="STMT-2026-07", date="31/07/2026", due="", currency="EUR", totlabel="BALANCE DUE (EUR)",
      rows=[["Opening balance 01/07/2026", "", "", "", "", ""],
            ["INV PI-26-104  04/07/2026", 1, "", "841.30", "", "1,034.80"],
            ["INV PI-26-118  06/08/2026", 1, "", "1,716.79", "", "2,111.65"],
            ["PAYMENT rcvd 08/07/2026 (EFT)", "", "", "-1,034.80", "", "-1,034.80"],
            ["CREDIT CN-PI-26-005 14/05/2026", "", "", "-172.68", "", "-212.40"],
            ["BALANCE DUE", "", "", "", "", "1,899.25"]],
      net=1899.25, vat="n/a (statement)", gross=1899.25,
      notes=["Please note this is a statement, not an invoice - remit per agreed terms (account HP-2088)."],
      quirks="statement_not_invoice|aggregation_risk"),
 dict(file="16_pi_vetmed_scan.pdf", template="scan", doctitle="INVOICE", direction="purchase",
      issuer=issuer("VetMed Products Ltd",["IDA Industrial Estate","Tullamore, Co. Offaly, R35 PT66"],"IE5518870K","+353 57 935 2210","orders@vetmed.ie"),
      recipient=HP, inv_no="PI-26-141", date="21/07/2026", due="20/08/2026", currency="EUR",
      rows=[["Profender spot-on cat (x24)", 24, "6.85", "164.40", "23%", "202.21"],
            ["Drontal Plus flavour bone (x40)", 40, "4.32", "172.80", "23%", "212.54"],
            ["Malaseb medicated shampoo 250ml (x12)", 12, "13.75", "165.00", "23%", "202.95"]],
      net=502.20, vat=115.51, gross=617.71, quirks="image_only_pdf_requires_ocr|skewed_scan"),
 dict(file="17_pi_topoil_photocopy.pdf", template="scan", doctitle="INVOICE", direction="purchase",
      issuer=issuer("Top Oil Fuels",["Top Oil House, 5 Red Cow Lane","Clondalkin, Dublin 22, D22 XF18"],"IE4830176E","+353 1 457 8820","credit@topoil.ie"),
      recipient=HP, inv_no="PI-26-150", date="29/07/2026", due="12/08/2026", currency="EUR",
      rows=[["Kerosene delivery 500L (account HP-14)", 1, "242.80", "242.80", "13.5%", "275.58"],
            ["Fuel delivery surcharge", 1, "20.34", "20.34", "13.5%", "23.09"]],
      net=263.14, vat=35.52, gross=298.66, quirks="image_only_pdf_requires_ocr|low_contrast|reduced_vat_13_5"),
 dict(file="18_pi_dublin_wholesale_no_number.pdf", template="classic", doctitle="INVOICE", direction="purchase",
      issuer=issuer("Dublin Pet Wholesale Ltd",["Rosemount Business Park","Ballycoolin, Dublin 15, D15 X3K9"],"IE5881023G","+353 1 646 2095","accounts@dublinpetwholesale.ie"),
      recipient=HP, inv_no="", date="18/08/2026", due="17/09/2026", currency="EUR",
      rows=[["Petmate water dispenser 4L (x24)", 24, "7.20", "172.80", "23%", "212.54"],
            ["Catit Senses play circuit (x12)", 12, "18.95", "227.40", "23%", "279.70"],
            ["Booda dome litter tray (x10)", 10, "12.60", "126.00", "23%", "154.98"]],
      net=526.20, vat=121.03, gross=647.23, quirks="missing_invoice_number|validation_needed"),
 dict(file="19_pi_sligo_safety_vat_inclusive.pdf", template="modern", doctitle="Invoice", direction="purchase",
      issuer=issuer("Sligo Safety Gear",["Finisklin Industrial Estate","Sligo, F91 RR42"],"IE6390042L","+353 71 915 6674","info@sligosafety.ie"),
      recipient=HP, inv_no="PI-26-160", date="11/08/2026", due="10/09/2026", currency="EUR",
      rows=[["Nitrile grooming gloves (x10) - price incl. VAT", 10, "6.13", "", "23%", "61.30"],
            ["FFP2 dust masks box 20 (x4) - price incl. VAT", 4, "22.15", "", "23%", "88.60"]],
      net=121.87, vat=28.03, gross=149.90,
      notes=["All prices shown are VAT inclusive; VAT breakdown available on request."],
      quirks="no_vat_breakdownpvat_inclusive_prices"),
 dict(file="20_pi_murphys_timber_cross_recipient.pdf", template="letterhead", doctitle="INVOICE", direction="purchase",
      issuer=issuer("Murphy's Timber Ltd",["Finisklin Business Park","Sligo, F91 W2X5"],"IE4781209C","+353 71 916 3345","sales@murphystimber.ie"),
      recipient=WA, inv_no="MT-88314", date="05/08/2026", due="04/09/2026", currency="EUR",
      rows5=[["1","American white oak plank 50mm, kiln dried (x12)", 12, "68.50", "822.00"],
             ["2","Walnut strip 25mm (x8)", 8, "35.12", "280.96"]],
      rows=[["American white oak plank 50mm, kiln dried (x12)", 12, "68.50", "822.00", "23%", "1011.06"],
            ["Walnut strip 25mm (x8)", 8, "35.12", "280.96", "23%", "345.58"]],
      net=1102.96, vat=253.68, gross=1356.64, quirks="recipient_is_other_company|routing_test"),
]

# ------------------------------------------------------------------ render
INDEX = []
for s in DOCS:
    path = os.path.join(OUT, s["file"])
    if s.get("rows7"):
        tn = tg = 0.0
        for r in s["rows7"]:
            r[2] = int(r[2]); r[3] = float(r[3])
            r[4] = round(r[2]*r[3], 2)
            r[6] = round(r[4]*(1+float(str(r[5]).rstrip('%'))/100),2)
            tn += r[4]; tg += r[6]
        s["net"], s["gross"] = round(tn,2), round(tg,2)
        s["vat"] = round(s["gross"]-s["net"],2)
    if s["template"] == "scan":
        t_scan(path, s, skew=2.4 if "skewed" in s["quirks"] else 1.2,
               contrast=0.45 if "low_contrast" in s["quirks"] else 0.8)
    else:
        c = canvas.Canvas(path, pagesize=A4)
        {"classic": t_classic, "modern": t_modern, "letterhead": t_letterhead,
         "wholesale": t_wholesale}[s["template"]](c, s)
        c.showPage(); c.save()
    INDEX.append(dict(file=s["file"], doc_type=s["doctitle"], direction=s["direction"],
        issuer=s["issuer"]["name"], recipient=s["recipient"]["name"], invoice_no=s["inv_no"],
        date=s["date"], currency=s["currency"], net=s["net"], vat=s["vat"], gross=s["gross"],
        quirks=s["quirks"]))

with open(os.path.join(OUT, "invoice_index.csv"), "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(INDEX[0].keys())); w.writeheader(); w.writerows(INDEX)
print(f"Wrote {len(INDEX)} PDFs to {OUT}")
