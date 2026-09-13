from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

root = Path(__file__).resolve().parent.parent
im = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
d.rounded_rectangle((8, 8, 248, 248), radius=52, fill='#ff8c42')
font = ImageFont.truetype('C:/Windows/Fonts/arialbi.ttf', 215)
d.text((39, -3), 'D', font=font, fill='#19191b', stroke_width=1)
d.line([(218,168),(178,208)], fill='#ffe3cc', width=17)
d.line([(175,178),(175,211),(208,211)], fill='#ffe3cc', width=14)
(root/'src'/'assets').mkdir(exist_ok=True)
im.save(root/'src'/'assets'/'icon.png')
im.save(root/'src'/'assets'/'icon.ico',sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
