"""
Verarbeitet das Server-Icon:
- Entfernt das ins PNG gerenderte Schachbrett-Pseudo-Transparenz-Muster
- Erkennt die abgerundete Ecken-Maske des Icons und macht alles ausserhalb echt transparent
- Rendert mehrere Groessen fuer Favicon (16/32/48 ICO) + Unraid (256x256 PNG)

Annahme: Das Icon ist quadratisch mit einem dunklen Squircle/Rounded-Rect-Hintergrund.
Strategie zur Maskenermittlung: Pixel-Helligkeit < Schwelle = Icon. Helligkeit ueber
Schwelle (= Schachbrett-Grau) = Hintergrund -> transparent.
"""

from PIL import Image
from pathlib import Path

SRC = Path(r"C:/Users/patri/Downloads/iconserver.png")
OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "icons"
OUT_DIR.mkdir(parents=True, exist_ok=True)


def is_checkerboard_pixel(r: int, g: int, b: int) -> bool:
    """
    Schachbrett besteht aus mittelgrauen Pixeln. Genauer:
    - hellgrau ~ (200-210, 200-210, 200-210)
    - dunkelgrau ~ (180-190, 180-190, 180-190)
    Beide sind annaehernd farbneutral und im mittleren Helligkeitsbereich.
    Pixel im Icon selbst sind entweder dunkel (Schwarz, Dunkelblau)
    oder leuchtende Akzente (Orange, Cyan, hellblau) - alle stark gesaettigt
    oder sehr dunkel.
    """
    grey_neutral = abs(r - g) < 8 and abs(g - b) < 8 and abs(r - b) < 8
    in_checker_range = 170 <= r <= 220
    return grey_neutral and in_checker_range


def build_alpha_mask(img: Image.Image) -> Image.Image:
    """Erzeugt eine Alpha-Maske: 0 fuer Schachbrett-Pixel, 255 sonst."""
    w, h = img.size
    src = img.convert("RGB")
    alpha = Image.new("L", (w, h), 255)
    src_pixels = src.load()
    alpha_pixels = alpha.load()

    for y in range(h):
        for x in range(w):
            r, g, b = src_pixels[x, y]
            if is_checkerboard_pixel(r, g, b):
                alpha_pixels[x, y] = 0

    return alpha


def flood_fill_corners_transparent(rgba: Image.Image) -> Image.Image:
    """
    Falls die Schachbrett-Erkennung Luecken hat, gehen wir per Flood-Fill
    von den 4 Ecken aus rein: solange ein Nachbar transparent ist ODER
    Schachbrett-Farbe hat, wird er auch transparent.
    """
    w, h = rgba.size
    pixels = rgba.load()
    visited = [[False] * h for _ in range(w)]
    stack = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]

    while stack:
        x, y = stack.pop()
        if x < 0 or x >= w or y < 0 or y >= h:
            continue
        if visited[x][y]:
            continue
        visited[x][y] = True
        r, g, b, a = pixels[x, y]
        if a == 0 or is_checkerboard_pixel(r, g, b):
            pixels[x, y] = (0, 0, 0, 0)
            stack.extend([(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)])

    return rgba


def main():
    print(f"Lese Quelle: {SRC}")
    img = Image.open(SRC).convert("RGBA")
    print(f"Originalgroesse: {img.size}, Mode: {img.mode}")

    print("Erzeuge Alpha-Maske (Schachbrett-Erkennung)...")
    alpha = build_alpha_mask(img)
    rgba = img.copy()
    rgba.putalpha(alpha)

    print("Flood-Fill ab den Ecken, um Restpixel zu eliminieren...")
    rgba = flood_fill_corners_transparent(rgba)

    print("Speichere bereinigtes Master-PNG...")
    master_path = OUT_DIR / "icon-master.png"
    rgba.save(master_path, "PNG", optimize=True)
    print(f"  -> {master_path} ({master_path.stat().st_size:,} bytes)")

    print("Erzeuge Unraid-Icon (256x256, PNG, Transparenz)...")
    unraid = rgba.resize((256, 256), Image.LANCZOS)
    unraid_path = OUT_DIR / "icon.png"
    unraid.save(unraid_path, "PNG", optimize=True)
    print(f"  -> {unraid_path} ({unraid_path.stat().st_size:,} bytes)")

    print("Erzeuge Apple-Touch-Icon (180x180)...")
    apple = rgba.resize((180, 180), Image.LANCZOS)
    apple_path = OUT_DIR / "apple-touch-icon.png"
    apple.save(apple_path, "PNG", optimize=True)
    print(f"  -> {apple_path} ({apple_path.stat().st_size:,} bytes)")

    print("Erzeuge Favicon (Multi-Resolution ICO 16/32/48)...")
    favicon_path = OUT_DIR / "favicon.ico"
    rgba.save(
        favicon_path,
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48)],
    )
    print(f"  -> {favicon_path} ({favicon_path.stat().st_size:,} bytes)")

    print("Erzeuge Favicon-PNG (32x32) als Fallback...")
    fav32 = rgba.resize((32, 32), Image.LANCZOS)
    fav32_path = OUT_DIR / "favicon-32.png"
    fav32.save(fav32_path, "PNG", optimize=True)
    print(f"  -> {fav32_path} ({fav32_path.stat().st_size:,} bytes)")

    print("Fertig.")


if __name__ == "__main__":
    main()
