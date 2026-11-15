"""
make_highres_tiles.py - cuts the 16k colour map into tiles for the "High resolution" tick box.

UI/tif/lroc_color_16bit_srgb_16k.tif (16384 x 8192, 16-bit, ~950 MB) is far too big for a browser,
so it is cut once into 32 x 16 JPEG tiles of 512 x 512 px (11.25 degrees each), 8 bits per colour
like the 4k map: UI/tif/lroc_16k_tiles/<row>/<col>.jpg, row 0 at the north pole, col 0 at 180 W.
The page then loads only the tiles of the area it zooms into (highres.js).

It reads the file one band of 512 rows at a time, so it needs little memory.
Run from anywhere:  python tools/make_highres_tiles.py
"""
from pathlib import Path

import numpy as np
import tifffile
from PIL import Image

UI = Path(__file__).resolve().parent.parent / "UI"
SOURCE = UI / "tif" / "lroc_color_16bit_srgb_16k.tif"
OUT = UI / "tif" / "lroc_16k_tiles"
TILE = 512
QUALITY = 90


def main():
    with tifffile.TiffFile(SOURCE) as tif:
        page = tif.pages[0]
        height, width, _ = page.shape
        assert width % TILE == 0 and height % TILE == 0, page.shape
        rows_per_strip = page.rowsperstrip
        fh = tif.filehandle
        for row in range(height // TILE):
            band = np.empty((TILE, width, 3), np.uint16)
            first = row * TILE // rows_per_strip
            for s in range(TILE // rows_per_strip):
                index = first + s
                fh.seek(page.dataoffsets[index])
                strip = page.decode(fh.read(page.databytecounts[index]), index)[0]
                band[s * rows_per_strip:(s + 1) * rows_per_strip] = strip.reshape(rows_per_strip, width, 3)
            band8 = ((band.astype(np.uint32) + 128) // 257).astype(np.uint8)  # same rounding as main.js
            (OUT / str(row)).mkdir(parents=True, exist_ok=True)
            for col in range(width // TILE):
                Image.fromarray(band8[:, col * TILE:(col + 1) * TILE]).save(
                    OUT / str(row) / f"{col}.jpg", quality=QUALITY, subsampling=0)
            print(f"row {row + 1} / {height // TILE}")
    size = sum(f.stat().st_size for f in OUT.rglob("*.jpg"))
    print(f"{OUT}: {size / 1e6:.0f} MB")


if __name__ == "__main__":
    main()
