"""Build selective title font chunks. Requires fonttools[woff] and brotli."""
import base64
import io
import json
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont

root = Path(__file__).resolve().parent.parent
source = root / "assets/public-scoreboard/SmileySans-Oblique.ttf"
points = sorted(TTFont(source).getBestCmap())
groups = [[point for point in points if point < 256]]
cjk = [point for point in points if point >= 256]
groups += [cjk[start:start + 32] for start in range(0, len(cjk), 32)]
chunks = []
for group in groups:
    font = TTFont(source)
    options = subset.Options()
    options.flavor = "woff2"
    worker = subset.Subsetter(options=options)
    worker.populate(unicodes=group)
    worker.subset(font)
    # Subset derivatives use a new internal name (the OFL reserves the original).
    for record in font["name"].names:
        if record.nameID in (1, 3, 4, 6, 16):
            record.string = "BallanceBroadcastTitle".encode(record.getEncoding())
    font.flavor = "woff2"
    output = io.BytesIO()
    font.save(output)
    chunks.append({"points": group, "url": "data:font/woff2;base64," + base64.b64encode(output.getvalue()).decode("ascii")})
(root / "apps/server/src/public-title-font.json").write_text(json.dumps(chunks, separators=(",", ":")) + "\n", encoding="utf-8")
print(f"Built {len(chunks)} title font chunks")
