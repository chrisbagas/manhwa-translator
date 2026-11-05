"""Write test images as raw RGBA (+ .json size) for the browser engine's Node tests."""
import json, sys
from pathlib import Path
from PIL import Image

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
for p in sys.argv[2:]:
    im = Image.open(p).convert("RGBA")
    (out / (Path(p).stem + ".rgba")).write_bytes(im.tobytes())
    (out / (Path(p).stem + ".size.json")).write_text(json.dumps({"w": im.width, "h": im.height}))
    print(Path(p).stem, im.size)
