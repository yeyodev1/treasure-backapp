"""
Limpia los valores por defecto que traen los PDF oficiales (solicitud de
cambios ISM, 27-oct-2026):

- Casillas: ninguna viene marcada (un chequeo de seguridad nunca se da por
  bueno de antemano). El servidor además ignora cualquier default de casilla.
- Nombres de personas fijos (R-06, R-10, R-13, R-18, R-26): se quitan; los
  llena quien hace el registro.
- Textos de conclusión precargados del R-19 ("sin novedades..."): se quitan.
- Caducidades del R-28: dejan de ser respuesta y pasan a "reference"
  (se muestran como dato conocido, la revisión física la confirma).

Se aplica al final de build.py y se puede correr sola sobre los assets:
    python defaults.py <assets_ism>
"""
import json
import os
import sys

# Campos con nombres de personas precargados (nombre del campo → valor visto).
PERSON_FIELDS = {
    "R-06": {"Text Field 21"},
    "R-10": {"Text Field 94", "Text Field 95"},
    "R-13": {"Text Field 1058"},
    "R-18_Cubierta": {"Text Field 1030"},
    "R-18_Maquinas": {"Text Field 1030"},
    "R-26": {"Text Field 1092"},
}

# Conclusiones y recomendaciones redactadas de antemano.
PRESET_TEXT_FIELDS = {
    "R-19": {"Text Field 101015", "Text Field 101018", "Text Field 101022", "Text Field 101025"},
}

# Formatos cuyos defaults de texto son caducidades conocidas (referencia).
REFERENCE_FORMS = {"R-28"}


def clean(code, fields):
    """Devuelve la lista de cambios aplicados (para el log)."""
    changes = []
    people = PERSON_FIELDS.get(code, set())
    presets = PRESET_TEXT_FIELDS.get(code, set())
    for f in fields:
        if "default" not in f:
            continue
        if f["type"] in ("checkbox", "radio"):
            changes.append(f"{f['name']}: casilla sin default")
            f.pop("default")
        elif f["name"] in people or f["name"] in presets:
            changes.append(f"{f['name']}: quitado '{str(f['default'])[:40]}'")
            f.pop("default")
        elif code in REFERENCE_FORMS and f["type"] == "text":
            f["reference"] = f.pop("default")
            changes.append(f"{f['name']}: referencia '{f['reference']}'")
    return changes


if __name__ == "__main__":
    assets = sys.argv[1]
    defs_dir = os.path.join(assets, "defs")
    for name in sorted(os.listdir(defs_dir)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(defs_dir, name)
        with open(path, encoding="utf-8") as fh:
            definition = json.load(fh)
        changes = clean(definition["code"], definition["fields"])
        if changes:
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(definition, fh, ensure_ascii=False)
            print(f"{definition['code']:14} {len(changes)} cambios · " + "; ".join(changes[:3]))
