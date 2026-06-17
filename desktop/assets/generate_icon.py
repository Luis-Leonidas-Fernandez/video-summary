from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent
SOURCE_IMAGE = ROOT / 'icon_source.png'
BASE_PNG = ROOT / 'icon_1024.png'
ICNS_PATH = ROOT / 'icon.icns'
SIZE = 1024


def render_icon():
    source = Image.open(SOURCE_IMAGE).convert('RGBA')
    icon = ImageOps.fit(source, (SIZE, SIZE), method=Image.LANCZOS, centering=(0.5, 0.5))
    icon.save(BASE_PNG)
    icon.save(ICNS_PATH)
    return icon


if __name__ == '__main__':
    image = render_icon()
    print(f'saved {BASE_PNG} and {ICNS_PATH} ({image.size[0]}x{image.size[1]}) from {SOURCE_IMAGE.name}')
