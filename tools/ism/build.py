"""
Arma las definiciones finales de los registros ISM a partir de lo extraído
de los PDF oficiales: etapa de cada firma (tripulación, capitán, oficina),
etiquetas legibles, recuadros de foto, frecuencia y títulos.

Uso: python build.py <defs_extraidas> <csv_equipos> <salida_assets>
"""
import csv
import json
import os
import re
import shutil
import sys

from defaults import clean as clean_defaults

DEFS, CSV_PATH, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(os.path.join(OUT, "defs"), exist_ok=True)

META = {
    "R-04": ("Datos personales, competencias y estado físico de la tripulación", "Tripulación", "evento"),
    "R-05": ("Familiarización del personal de tripulación", "Tripulación", "evento"),
    "R-06": ("Capacitación para el personal", "Tripulación", "evento"),
    "R-07": ("Acta entrega – recepción de cargo", "Tripulación", "por_cargo"),
    "R-08": ("Reporte de incumplimiento", "Seguridad", "evento"),
    "R-09": ("Reporte de accidente, cuasi accidente o condición peligrosa", "Seguridad", "evento"),
    "R-10": ("Acta del comité de seguridad de a bordo", "Comités y gestión", "evento"),
    "R-11": ("Acta del comité de revisión general", "Comités y gestión", "evento"),
    "R-12": ("Registro de cambios", "Comités y gestión", "evento"),
    "R-13": ("Lista de chequeo de combustible", "Operación", "evento"),
    "R-14": ("Chequeo previo al zarpe y rondas de seguridad", "Operación", "por_salida"),
    "R-15": ("Autorización de trabajos especiales", "Operación", "evento"),
    "R-16": ("Mantenimiento preventivo de cubierta y máquinas", "Mantenimiento", "por_equipo"),
    "R-17": ("Orden de trabajo", "Mantenimiento", "evento"),
    "R-18_Cubierta": ("Orden de requisición · Cubierta", "Mantenimiento", "evento"),
    "R-18_Maquinas": ("Orden de requisición · Máquinas", "Mantenimiento", "evento"),
    "R-19": ("Reporte de cumplimiento de zafarrancho", "Seguridad", "evento"),
    "R-20": ("Registro de entrega de medicinas", "Tripulación", "evento"),
    "R-21": ("Entrega de EPP", "Tripulación", "evento"),
    "R-22": ("Evaluación de desempeño", "Tripulación", "por_cargo"),
    "R-23": ("Registro de horas de descanso", "Tripulación", "por_cargo_mensual"),
    "R-24": ("Acta de eliminación de documentos", "Comités y gestión", "evento"),
    "R-25_Alcohol": ("Control mensual de alcohol", "Seguridad", "mensual"),
    "R-25_Drogas": ("Control mensual de drogas", "Seguridad", "mensual"),
    "R-26": ("Reporte semanal de crucero", "Operación", "semanal"),
    "R-27": ("Matriz de evaluación de riesgo", "Seguridad", "evento"),
    "R-28": ("Chequeo mensual de equipos contraincendios y salvamento", "Seguridad", "mensual"),
    "R-29": ("Registro de informe", "Comités y gestión", "evento"),
    "R-30": ("Registro de toma de conocimiento", "Comités y gestión", "evento"),
}

# Registros que llena y firma solo la oficina.
OFFICE_ONLY = {"R-11", "R-24"}

# Correcciones revisadas a ojo sobre el PDF (la etiqueta cercana era ambigua).
OVERRIDES = {
    "R-06": {
        "Signature Field 4": ("capitan", "Capitán"),
        "Signature Field 7": ("oficina", "Persona Designada"),
        "Signature Field 8": ("tripulacion", "Expositor"),
        "Signature Field 9": ("tripulacion", "Asistente 1"),
    },
    "R-08": {"Signature Field 8": ("capitan", "Capitán (análisis de causa)")},
    "R-09": {"Signature Field 8": ("capitan", "Capitán (análisis de causa)")},
    "R-10": {"Signature Field 23": ("oficina", "Persona Designada")},
    "R-18_Cubierta": {
        "Signature Field 29": ("capitan", "Capitán (solicitante)"),
        "Signature Field 28": ("tripulacion", "Responsable de despacho"),
        "Signature Field 21": ("tripulacion", "Responsable de recepción"),
    },
    "R-26": {
        "Firma_Charla_PNG": ("tripulacion", "Responsable charla PNG"),
        "Firma_Charla_Induccion": ("tripulacion", "Responsable inducción"),
    },
}
OVERRIDES["R-18_Maquinas"] = OVERRIDES["R-18_Cubierta"]

# En el anexo del R-18 los recuadros "de firma" son espacios para fotos.
PHOTOS = {
    "R-18_Cubierta": {"Signature Field 23", "Signature Field 24", "Signature Field 25", "Signature Field 26"},
}
PHOTOS["R-18_Maquinas"] = PHOTOS["R-18_Cubierta"]

LABELS = [
    ("PERSONA DESIGNADA", "Persona Designada"),
    ("GERENTE GENERAL", "Gerente General"),
    ("GERENCIA GENERAL", "Gerencia General"),
    ("GERENTE OPERACIONES", "Gerente de Operaciones"),
    ("LOGISTICA", "Logística y Mantenimiento"),
    ("RESPONSABLE OFICINA", "Responsable de oficina"),
    ("DIRECTOR", "Director de Crucero"),
    ("CAPIT", "Capitán"),
    ("TALLER", "Taller encargado"),
    ("PRIMERA PUENTE", "Marinero de Primera Puente"),
    ("PRIMERA DE PUENTE", "Marinero de Primera Puente"),
    ("MAQUINAS", "Marinero de Primera Máquinas"),
    ("MÁQUINAS", "Marinero de Primera Máquinas"),
    ("EVALUADOR DE RIESGOS", "Evaluador de riesgos"),
    ("EVALUADOR", "Evaluador"),
    ("EVALUADO", "Evaluado"),
    ("EMPLEADO", "Empleado que recibe"),
    ("ENCARGADO", "Encargado"),
    ("SALIENTE", "Saliente"),
    ("ENTRANTE", "Entrante"),
    ("PRESTADOR", "Prestador del servicio"),
    ("TRIPULANTE", "Tripulante"),
    ("RESPONSABLE DEL INFORME", "Responsable del informe"),
]


# Nombre de las firmas repetidas por formulario (asistentes, tripulantes…).
CREW_PREFIX = {
    "R-06": ("Asistente", 1),
    "R-12": ("Responsable del cambio", 0),
    "R-20": ("Tripulante que recibe", 0),
    "R-26": ("Responsable", 0),
    "R-30": ("Tripulante", 0),
}


def classify(label):
    up = label.upper()
    if any(k in up for k in ("GERENTE", "GERENCIA", "LOGISTICA", "OFICINA", "DESIGNADA")):
        return "oficina"
    if "CAPIT" in up:
        return "capitan"
    return "tripulacion"


def nice_label(label):
    up = label.upper()
    for key, text in LABELS:
        if key in up:
            return text
    return None


equipment = []
with open(CSV_PATH, encoding="utf-8-sig") as fh:
    for row in csv.DictReader(fh, delimiter=";"):
        equipment.append(
            {
                "category": row["Categoría"],
                "folder": row["Carpeta SharePoint"],
                "name": row["Equipo"],
                "brand": row["Marca"],
                "model": row["Modelo"],
                "serial": row["Serie"],
                "owner": row["Encargado (cargo)"],
            }
        )

catalog = []
for code, (title, group, frequency) in META.items():
    src = json.load(open(os.path.join(DEFS, f"{code}.json"), encoding="utf-8"))
    overrides = OVERRIDES.get(code, {})
    photos = PHOTOS.get(code, set())
    prefix, crew_counter = CREW_PREFIX.get(code, ("Firma", 0))
    stages = {"tripulacion": 0, "capitan": 0, "oficina": 0}
    for f in src["fields"]:
        if f["type"] != "signature":
            continue
        if f["name"] in photos:
            f["type"] = "photo"
            f.pop("label", None)
            continue
        raw = f.get("label", "")
        stage, label = overrides.get(f["name"], (None, None))
        stage = stage or classify(raw)
        if code in OFFICE_ONLY:
            stage = "oficina"
        label = label or nice_label(raw)
        if not label:
            crew_counter += 1
            label = f"{prefix} {crew_counter}" if stage == "tripulacion" else "Firma"
        f["stage"] = stage
        f["label"] = label
        f.pop("raw", None)
        stages[stage] += 1

    clean_defaults(code, src["fields"])

    definition = {
        "code": code,
        "title": title,
        "group": group,
        "frequency": frequency,
        "officeOnly": code in OFFICE_ONLY,
        "stages": stages,
        "pages": src["pages"],
        "fields": src["fields"],
    }
    if code == "R-16":
        definition["equipmentFields"] = {
            "name": "Text Field 41",
            "brand": "Marca",
            "model": "Text Field 42",
            "serial": "Text Field 43",
            "owner": "Text Field 44",
        }
    json.dump(definition, open(os.path.join(OUT, "defs", f"{code}.json"), "w", encoding="utf-8"), ensure_ascii=False)
    catalog.append(
        {
            "code": code,
            "title": title,
            "group": group,
            "frequency": frequency,
            "officeOnly": code in OFFICE_ONLY,
            "pages": len(src["pages"]),
            "fieldCount": len(src["fields"]),
            "stages": stages,
        }
    )
    sig = [f for f in src["fields"] if f["type"] == "signature"]
    print(f"{code:14} trip {stages['tripulacion']:2}  cap {stages['capitan']}  of {stages['oficina']}  | " + ", ".join(f"{s['label']}[{s['stage'][0]}]" for s in sig)[:150])

json.dump(catalog, open(os.path.join(OUT, "catalog.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
json.dump(equipment, open(os.path.join(OUT, "equipment.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"{len(catalog)} formularios · {len(equipment)} equipos")
