#!/usr/bin/env python3
"""Genera miniaturas WebP ligeras de las fotos de productos guardadas en Backblaze B2.

Original: <clave>                       (p. ej. textil/producto_pluma_23_03.webp)
Miniatura: media/thumbs/<clave>.webp    (máx. 560 px, WebP calidad 78)

Solo procesa fotos nuevas o reemplazadas (compara la fecha de subida del original,
guardada en la miniatura como src_ts). Nunca borra ni modifica los originales.
Las fotos se descargan por el Worker público, así la llave de B2 solo necesita
listar y escribir.
"""
import io
import os
import sys
import time
import urllib.parse
import urllib.request

from b2sdk.v2 import B2Api, InMemoryAccountInfo
from PIL import Image, ImageOps

PREFIJOS = ["textil/", "jarros/", "imp-general/", "packs/", "media/migrated/productos/"]
THUMBS = "media/thumbs/"
EXTENSIONES = (".webp", ".jpg", ".jpeg", ".png", ".gif", ".avif")
LADO_MAX = 560
CALIDAD = 78
PUBLICO = os.environ.get("PUBLIC_BASE_URL", "https://b2.multiprintt.workers.dev").rstrip("/")
LIMITE = int(os.environ.get("MAX_MINIATURAS", "400"))


def listar(bucket, prefijo):
    for fv, _ in bucket.ls(prefijo, recursive=True):
        yield fv


def descargar(clave, version):
    url = f"{PUBLICO}/{urllib.parse.quote(clave)}?v=thumb-{version}"
    req = urllib.request.Request(url, headers={"User-Agent": "multiprintt-miniaturas"})
    for intento in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if intento == 2:
                raise
            print(f"  reintento {clave}: {e}")
            time.sleep(2 * (intento + 1))


def miniatura(datos):
    im = Image.open(io.BytesIO(datos))
    im = ImageOps.exif_transpose(im)
    if getattr(im, "is_animated", False):
        im.seek(0)
    im = im.convert("RGBA") if im.mode in ("RGBA", "LA", "P") else im.convert("RGB")
    im.thumbnail((LADO_MAX, LADO_MAX), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, "WEBP", quality=CALIDAD, method=6)
    return out.getvalue()


def main():
    kid = os.environ["B2_APPLICATION_KEY_ID"]
    key = os.environ["B2_APPLICATION_KEY"]
    api = B2Api(InMemoryAccountInfo())
    api.authorize_account("production", kid, key)
    bucket = api.get_bucket_by_name(os.environ["B2_BUCKET"])

    existentes = {fv.file_name: (fv.file_info or {}).get("src_ts", "") for fv in listar(bucket, THUMBS)}
    print(f"Miniaturas existentes: {len(existentes)}")

    hechas = errores = ahorro = 0
    for prefijo in PREFIJOS:
        for fv in listar(bucket, prefijo):
            nombre = fv.file_name
            if not nombre.lower().endswith(EXTENSIONES) or nombre.startswith(THUMBS):
                continue
            destino = f"{THUMBS}{nombre}.webp"
            ts = str(fv.upload_timestamp)
            if existentes.get(destino) == ts:
                continue
            if hechas >= LIMITE:
                print(f"Límite de {LIMITE} por ejecución alcanzado; el resto en la próxima.")
                break
            try:
                original = descargar(nombre, ts)
                thumb = miniatura(original)
                bucket.upload_bytes(thumb, destino, content_type="image/webp", file_info={"src_ts": ts})
                hechas += 1
                ahorro += max(0, len(original) - len(thumb))
                print(f"  {nombre}: {len(original)//1024} KB -> {len(thumb)//1024} KB")
            except Exception as e:  # noqa: BLE001
                errores += 1
                print(f"::warning::No se pudo crear la miniatura de {nombre}: {e}")

    print(f"Listo: {hechas} miniaturas nuevas, {errores} errores, {ahorro // 1024} KB menos por visita completa.")
    return 1 if errores and not hechas else 0


if __name__ == "__main__":
    sys.exit(main())
