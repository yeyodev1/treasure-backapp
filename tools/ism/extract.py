"""
Extrae la definición de cada formulario ISM desde su PDF interactivo oficial:
páginas (tamaño), campos (tipo, nombre, posición normalizada, valor por
defecto, multilínea, tamaño de letra) y, para cada firma, el texto impreso
cercano para saber a quién corresponde.

Uso: python extract.py <carpeta_pdfs> <salida_json_dir>
"""
import json
import os
import re
import sys

import pdfplumber
from pypdf import PdfReader
from pypdf.generic import NameObject

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)


def full_name(annot):
    parts = []
    node = annot
    while node is not None:
        t = node.get("/T")
        if t is not None:
            parts.append(str(t))
        parent = node.get("/Parent")
        node = parent.get_object() if parent is not None else None
    return ".".join(reversed(parts))


def inherited(annot, key):
    node = annot
    while node is not None:
        if key in node:
            return node[key]
        parent = node.get("/Parent")
        node = parent.get_object() if parent is not None else None
    return None


def font_size(da):
    if not da:
        return 0
    m = re.search(r"([\d.]+)\s+Tf", str(da))
    return float(m.group(1)) if m else 0


def nearby_text(words, rect, page_h):
    """Texto impreso debajo, encima o a la izquierda del recuadro (coordenadas pdfplumber)."""
    x0, y0, x1, y1 = rect  # coordenadas PDF (origen abajo-izquierda)
    top = page_h - y1
    bottom = page_h - y0
    cands = []
    for w in words:
        cx = (w["x0"] + w["x1"]) / 2
        # debajo (hasta 40pt) y dentro del ancho ampliado
        if x0 - 20 <= cx <= x1 + 20 and bottom - 4 <= w["top"] <= bottom + 40:
            cands.append((0, w["top"] - bottom, w))
        # encima (hasta 30pt)
        elif x0 - 20 <= cx <= x1 + 20 and top - 30 <= w["bottom"] <= top + 4:
            cands.append((1, top - w["bottom"], w))
        # izquierda en la misma franja
        elif w["x1"] <= x0 + 4 and x0 - 160 <= w["x1"] and top - 6 <= w["top"] <= bottom + 6:
            cands.append((2, x0 - w["x1"], w))
    cands.sort(key=lambda c: (c[0], c[1]))
    if not cands:
        return ""
    best_group = cands[0][0]
    text = " ".join(c[2]["text"] for c in cands if c[0] == best_group)
    return text[:120]


for fname in sorted(os.listdir(SRC)):
    if not fname.lower().endswith(".pdf"):
        continue
    path = os.path.join(SRC, fname)
    code = os.path.splitext(fname)[0]
    reader = PdfReader(path)
    plumber = pdfplumber.open(path)
    pages = []
    fields = []
    for pidx, page in enumerate(reader.pages):
        mb = page.mediabox
        pw, ph = float(mb.width), float(mb.height)
        pages.append({"width": pw, "height": ph})
        words = plumber.pages[pidx].extract_words(keep_blank_chars=False, use_text_flow=True)
        for a in page.get("/Annots") or []:
            annot = a.get_object()
            if annot.get("/Subtype") != "/Widget":
                continue
            ft = inherited(annot, "/FT")
            if ft is None:
                continue
            rect = [float(v) for v in annot["/Rect"]]
            x0, y0, x1, y1 = min(rect[0], rect[2]), min(rect[1], rect[3]), max(rect[0], rect[2]), max(rect[1], rect[3])
            name = full_name(annot)
            ff = int(inherited(annot, "/Ff") or 0)
            entry = {
                "name": name,
                "page": pidx,
                # normalizado 0..1 con origen arriba-izquierda (para superponer en la imagen)
                "x": round(x0 / pw, 5),
                "y": round((ph - y1) / ph, 5),
                "w": round((x1 - x0) / pw, 5),
                "h": round((y1 - y0) / ph, 5),
            }
            if ft == "/Tx":
                entry["type"] = "text"
                entry["multiline"] = bool(ff & 4096)
                fs = font_size(inherited(annot, "/DA"))
                entry["fontSize"] = fs
                v = inherited(annot, "/V")
                if v is not None and str(v).strip():
                    entry["default"] = str(v)
                ml = inherited(annot, "/MaxLen")
                if ml is not None:
                    entry["maxLength"] = int(ml)
            elif ft == "/Btn":
                if ff & 65536:  # pushbutton
                    continue
                ap = annot.get("/AP")
                on = None
                if ap is not None and "/N" in ap:
                    for k in ap["/N"].keys():
                        if k != "/Off":
                            on = k[1:]
                entry["type"] = "radio" if ff & 32768 else "checkbox"
                entry["onValue"] = on or "Yes"
                v = annot.get("/AS") or inherited(annot, "/V")
                if v is not None and str(v) not in ("/Off", "Off"):
                    entry["default"] = True
            elif ft == "/Sig":
                entry["type"] = "signature"
                entry["label"] = nearby_text(words, (x0, y0, x1, y1), ph)
            elif ft == "/Ch":
                entry["type"] = "text"
                entry["multiline"] = False
                entry["fontSize"] = font_size(inherited(annot, "/DA"))
            else:
                continue
            fields.append(entry)
    title_words = plumber.pages[0].extract_words()
    plumber.close()
    with open(os.path.join(OUT, f"{code}.json"), "w", encoding="utf-8") as fh:
        json.dump({"code": code, "pages": pages, "fields": fields}, fh, ensure_ascii=False)
    sigs = [f for f in fields if f["type"] == "signature"]
    print(f"{code}: {len(pages)} pág, {len(fields)} campos, {len(sigs)} firmas")
    for s in sigs:
        print(f"    {s['name']:24} → {s['label']}")
