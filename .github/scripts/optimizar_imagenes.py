"""Optimiza imágenes de una carpeta sin cambiar sus nombres públicos.

- .jpg/.jpeg/.png/.gif -> .webp (el original se elimina solo si la conversión salió bien).
- .webp de más de 1600 px o de más de 250 KB -> se reduce a 1600 px máx. y calidad 80,
  solo si el resultado pesa al menos 10 % menos.
Uso: python optimizar_imagenes.py <carpeta> [--no-recursivo] [--excluir nombre1,nombre2]
"""
import io, os, sys
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 400_000_000  # fotos de cámara muy grandes
MAX_LADO = 1600
MAX_BYTES = 250_000
CALIDAD = 80
CONVERTIR = ('.jpg', '.jpeg', '.png', '.gif')


def preparar(im):
    im = ImageOps.exif_transpose(im)
    if im.mode in ('P', 'LA') or (im.mode == 'RGBA'):
        im = im.convert('RGBA')
    elif im.mode != 'RGB':
        im = im.convert('RGB')
    if max(im.size) > MAX_LADO:
        im.thumbnail((MAX_LADO, MAX_LADO), Image.LANCZOS)
    return im


def a_webp(im):
    buf = io.BytesIO()
    im.save(buf, 'WEBP', quality=CALIDAD, method=6)
    return buf.getvalue()


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__); return 1
    carpeta = args[0]
    recursivo = '--no-recursivo' not in args
    excluir = set()
    if '--excluir' in args:
        excluir = {x.strip().lower() for x in args[args.index('--excluir') + 1].split(',') if x.strip()}
    cambios = 0
    for raiz, dirs, files in os.walk(carpeta):
        if not recursivo and raiz != carpeta:
            continue
        for nombre in sorted(files):
            ruta = os.path.join(raiz, nombre)
            base, ext = os.path.splitext(nombre)
            ext = ext.lower()
            if nombre.lower() in excluir:
                continue
            try:
                if ext in CONVERTIR:
                    destino = os.path.join(raiz, base + '.webp')
                    if os.path.exists(destino):
                        print(f'= {ruta}: ya existe {destino}, se deja igual'); continue
                    with Image.open(ruta) as im:
                        datos = a_webp(preparar(im))
                    with open(destino, 'wb') as f:
                        f.write(datos)
                    os.remove(ruta)
                    cambios += 1
                    print(f'+ {ruta} -> {destino} ({len(datos)//1024} KB)')
                elif ext == '.webp':
                    peso = os.path.getsize(ruta)
                    with Image.open(ruta) as im:
                        grande = max(im.size) > MAX_LADO
                        if not grande and peso <= MAX_BYTES:
                            continue
                        datos = a_webp(preparar(im))
                    if len(datos) < peso * 0.9:
                        with open(ruta, 'wb') as f:
                            f.write(datos)
                        cambios += 1
                        print(f'~ {ruta}: {peso//1024} KB -> {len(datos)//1024} KB')
            except Exception as e:  # una imagen dañada no debe frenar al resto
                print(f'! {ruta}: {e}')
    print(f'Imágenes optimizadas: {cambios}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
