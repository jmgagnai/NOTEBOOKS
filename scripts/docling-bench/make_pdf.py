# Writes an N-page PDF with two ruled tables per page (4 columns, 6-10 rows,
# fixed seed) plus paragraphs, built by hand so it needs only the stdlib.
# Usage: python3 make_pdf.py <out.pdf> <pages>
import sys, random
out, npages = sys.argv[1], int(sys.argv[2])
random.seed(42)
fruits = ["Apples","Oranges","Pears","Plums","Kiwis","Grapes","Cherries","Lemons","Mangos","Figs"]
regions = ["North","South","East","West","Centre","Coast","Hills","Valley"]
def esc(s): return s.replace("\\","\\\\").replace("(","\\(").replace(")","\\)")
pages = []
for p in range(npages):
    ops = []
    def text(x, y, s, size=10, font="F1"): ops.append(f"BT /{font} {size} Tf {x} {y} Td ({esc(s)}) Tj ET")
    y = 760
    text(72, y, f"Section {p+1}: Regional sales", 14, "F2"); y -= 22
    for t in range(2):
        text(72, y, f"Paragraph {p+1}.{t+1}: the following table lists units and revenue for batch {p*2+t+1}."); y -= 13
        text(72, y, "Figures are provisional and subject to revision after the audit closes."); y -= 16
        nrow = random.randint(6, 10)
        rows = [["Region","Fruit","Units","Revenue"]] + [[random.choice(regions), random.choice(fruits), str(random.randint(100,5000)), f"{random.randint(300,20000)} EUR"] for _ in range(nrow-1)]
        cw, rh, x0, y0 = 110, 18, 72, y
        ops.append("0.8 w")
        for r in range(nrow+1): ops.append(f"{x0} {y0-r*rh} m {x0+4*cw} {y0-r*rh} l S")
        for c in range(5): ops.append(f"{x0+c*cw} {y0} m {x0+c*cw} {y0-nrow*rh} l S")
        for r,row in enumerate(rows):
            for c,cell in enumerate(row): text(x0+c*cw+5, y0-r*rh-13, cell, 10, "F2" if r==0 else "F1")
        y = y0 - nrow*rh - 22
    text(72, y, f"End of section {p+1}. Totals are carried forward to the next section.")
    pages.append("\n".join(ops).encode())
objs = {1: b"<< /Type /Catalog /Pages 2 0 R >>", 3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>", 4: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"}
kids = []
n = 5
for c in pages:
    objs[n] = b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents %d 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>" % (n+1)
    objs[n+1] = b"<< /Length %d >>\nstream\n" % len(c) + c + b"\nendstream"
    kids.append(f"{n} 0 R"); n += 2
objs[2] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (" ".join(kids).encode(), len(pages))
buf = bytearray(b"%PDF-1.4\n"); offs = {}
for i in sorted(objs): offs[i] = len(buf); buf += b"%d 0 obj\n" % i + objs[i] + b"\nendobj\n"
xref = len(buf); size = max(objs)+1
buf += b"xref\n0 %d\n0000000000 65535 f \n" % size
for i in range(1, size): buf += b"%010d 00000 n \n" % offs[i]
buf += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (size, xref)
open(out, "wb").write(buf)
