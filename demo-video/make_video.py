from PIL import Image, ImageDraw, ImageFont
import subprocess, os, textwrap

W, H = 1280, 720
OUT = os.path.dirname(os.path.abspath(__file__))
FRAMES = os.path.join(OUT, "frames")
os.makedirs(FRAMES, exist_ok=True)

def font(size, bold=False):
    for p in ["/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]:
        if os.path.exists(p): return ImageFont.truetype(p, size)
    return ImageFont.load_default()

def title_card(title, subtitle, filename, bg=(13, 17, 23), fg=(88, 166, 255), dur=3):
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)
    d.text((W//2, H//2 - 40), title, font=font(48, True), fill=fg, anchor="mm")
    d.text((W//2, H//2 + 40), subtitle, font=font(24), fill=(200, 200, 200), anchor="mm")
    for i in range(dur * 30):
        img.save(f"{FRAMES}/{filename}_{i:04d}.png")

def terminal_video(lines, filename, bg=(13, 17, 23)):
    fnt = font(20); fnt_b = font(20, True)
    frame_idx = 0
    def save(img, n=2):
        nonlocal frame_idx
        for _ in range(n):
            img.save(f"{FRAMES}/{filename}_{frame_idx:04d}.png"); frame_idx += 1
    # type out lines progressively
    shown = []
    for line in lines:
        shown.append(line)
        # typing effect for command lines
        img = Image.new("RGB", (W, H), bg); d = ImageDraw.Draw(img)
        y = 40
        for l in shown[:-1]:
            d.text((40, y), l[:110], font=fnt, fill=(200, 200, 200)); y += 30
        # type last line char by char
        cur = shown[-1]
        for c in range(0, len(cur) + 1, 4):
            img2 = Image.new("RGB", (W, H), bg); d2 = ImageDraw.Draw(img2)
            y2 = 40
            for l in shown[:-1]:
                d2.text((40, y2), l[:110], font=fnt, fill=(200, 200, 200)); y2 += 30
            d2.text((40, y2), cur[:c][:110], font=fnt_b, fill=(255, 255, 255))
            save(img2, 1)
        save(img, 6)
    return frame_idx

# Title
title_card("x402-Paid CRE Workflows", "AI agents pay per query in USDC to consume Chainlink CRE workflows", "t1")
# Demo output (captured from real run)
lines = [
    "$ ./demo.sh",
    "==> starting x402 gateway on port 4021",
    "==> running the demo buyer agent",
    "",
    "--- step 1: unpaid request, expect 402 ---",
    "status: 402",
    "challenge: pay 50000 USDC-wei to 0xFa0f...192d on eip155:84532",
    "",
    "--- step 2: sign EIP-3009 authorization ---",
    "signed by 0xF57C809dB537C818d6BB4f27C087E2902Eb33c7F",
    "",
    "--- step 3: paid request, expect the oracle report ---",
    "status: 200",
    '{"paid":true,"priceUsdc":"0.05",',
    ' "report":{"feed":"ETH/USD","price":"2424.14",',
    '  "updatedAt":"2026-10-17T04:28:14.000Z"}}',
    "",
    "==> demo complete",
]
terminal_video(lines, "t2")
title_card("Built with Chainlink CRE + x402 v2", "github.com/Evoarislan/cre-x402-agent-payments", "t3", dur=4)

# Assemble
import glob
frames = sorted(glob.glob(f"{FRAMES}/*.png"))
print(f"total frames: {len(frames)}")
# write concat list
with open(f"{OUT}/list.txt", "w") as f:
    for fr in frames:
        f.write(f"file '{fr}'\n")
subprocess.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-r", "30", "-i", f"{OUT}/list.txt",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", f"{OUT}/demo.mp4"],
               capture_output=True)
print("video done:", os.path.getsize(f"{OUT}/demo.mp4"), "bytes")
