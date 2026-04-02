#!/usr/bin/env python3

from pathlib import Path


PAGE_WIDTH = 612
PAGE_HEIGHT = 792
MARGIN_X = 48

NAVY = (0.11, 0.17, 0.28)
TEAL = (0.16, 0.47, 0.53)
INK = (0.13, 0.15, 0.19)
MUTED = (0.38, 0.42, 0.46)
PANEL = (0.95, 0.97, 0.99)
WHITE = (1.0, 1.0, 1.0)
PAGE_BG = (0.985, 0.985, 0.975)


def rgb(color):
    return f"{color[0]:.3f} {color[1]:.3f} {color[2]:.3f}"


def escape_pdf_text(value):
    cleaned = "".join(ch if 32 <= ord(ch) <= 126 else "?" for ch in str(value))
    return cleaned.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


class Canvas:
    def __init__(self):
        self.pages = []
        self.commands = []

    def new_page(self):
        if self.commands:
            self.pages.append("\n".join(self.commands))
        self.commands = []

    def rect(self, x, y, width, height, fill=None, stroke=None, line_width=1):
        if fill:
            self.commands.append(f"{rgb(fill)} rg")
        if stroke:
            self.commands.append(f"{rgb(stroke)} RG")
        self.commands.append(f"{line_width:.2f} w")
        op = "B" if fill and stroke else "f" if fill else "S"
        self.commands.append(f"{x:.2f} {y:.2f} {width:.2f} {height:.2f} re {op}")

    def line(self, x1, y1, x2, y2, color, line_width=1):
        self.commands.append(f"{rgb(color)} RG")
        self.commands.append(f"{line_width:.2f} w")
        self.commands.append(f"{x1:.2f} {y1:.2f} m {x2:.2f} {y2:.2f} l S")

    def text(self, x, y, value, *, font="F1", size=10, color=INK):
        self.commands.append(
            f"BT /{font} {size:.2f} Tf {rgb(color)} rg 1 0 0 1 {x:.2f} {y:.2f} Tm ({escape_pdf_text(value)}) Tj ET"
        )

    def finalize(self):
        if self.commands:
            self.pages.append("\n".join(self.commands))
            self.commands = []
        return self.pages


def add_header(canvas, page_number):
    canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=PAGE_BG)
    canvas.rect(0, PAGE_HEIGHT - 92, PAGE_WIDTH, 92, fill=NAVY)
    canvas.text(MARGIN_X, PAGE_HEIGHT - 48, "Lumiere", font="F2", size=26, color=WHITE)
    canvas.text(
        MARGIN_X,
        PAGE_HEIGHT - 70,
        "Evidence-based app summary from the current repository",
        size=10,
        color=(0.88, 0.92, 0.98),
    )
    canvas.rect(PAGE_WIDTH - 118, PAGE_HEIGHT - 66, 70, 24, fill=(0.19, 0.55, 0.60))
    canvas.text(PAGE_WIDTH - 101, PAGE_HEIGHT - 58, f"Page {page_number}", font="F2", size=10, color=WHITE)


def add_section(canvas, y, heading, lines, *, bullet=False):
    canvas.text(MARGIN_X, y, heading, font="F2", size=12, color=TEAL)
    canvas.line(MARGIN_X, y - 5, PAGE_WIDTH - MARGIN_X, y - 5, PANEL, line_width=1.2)
    y -= 26
    for line in lines:
        prefix = "- " if bullet else ""
        canvas.text(MARGIN_X + (0 if not bullet else 8), y, f"{prefix}{line}", size=10.5, color=INK)
        y -= 16
    return y - 8


def write_pdf(output_path, page_streams):
    objects = [None]

    def add_object(payload):
        objects.append(payload)
        return len(objects) - 1

    catalog_id = add_object(b"")
    pages_id = add_object(b"")
    font_regular_id = add_object(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    font_bold_id = add_object(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")
    font_oblique_id = add_object(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>")

    page_ids = []
    content_ids = []
    for stream in page_streams:
        page_ids.append(add_object(b""))
        stream_bytes = stream.encode("latin-1")
        content_ids.append(add_object(
            f"<< /Length {len(stream_bytes)} >>\nstream\n".encode("latin-1") + stream_bytes + b"\nendstream"
        ))

    for page_id, content_id in zip(page_ids, content_ids):
        objects[page_id] = (
            f"<< /Type /Page /Parent {pages_id} 0 R "
            f"/MediaBox [0 0 {PAGE_WIDTH} {PAGE_HEIGHT}] "
            f"/Resources << /Font << /F1 {font_regular_id} 0 R /F2 {font_bold_id} 0 R /F3 {font_oblique_id} 0 R >> >> "
            f"/Contents {content_id} 0 R >>"
        ).encode("latin-1")

    kids = " ".join(f"{page_id} 0 R" for page_id in page_ids)
    objects[pages_id] = f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>".encode("latin-1")
    objects[catalog_id] = f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode("latin-1")

    pdf = bytearray()
    pdf.extend(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")

    offsets = [0]
    for obj_id in range(1, len(objects)):
        offsets.append(len(pdf))
        pdf.extend(f"{obj_id} 0 obj\n".encode("latin-1"))
        pdf.extend(objects[obj_id])
        pdf.extend(b"\nendobj\n")

    xref_start = len(pdf)
    pdf.extend(f"xref\n0 {len(objects)}\n".encode("latin-1"))
    pdf.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        pdf.extend(f"{offset:010d} 00000 n \n".encode("latin-1"))

    pdf.extend(
        (
            f"trailer\n<< /Size {len(objects)} /Root {catalog_id} 0 R >>\n"
            f"startxref\n{xref_start}\n%%EOF\n"
        ).encode("latin-1")
    )

    output_path.write_bytes(pdf)


def build_pdf(output_path):
    canvas = Canvas()

    canvas.new_page()
    add_header(canvas, 1)
    canvas.rect(MARGIN_X, 640, PAGE_WIDTH - (MARGIN_X * 2), 56, fill=PANEL)
    canvas.text(MARGIN_X + 14, 673, "Room types in repo: duo, friends, family", font="F2", size=11, color=NAVY)
    canvas.text(
        MARGIN_X + 14,
        655,
        "Session modes in repo: watch, music, podcast, reading, study",
        size=10,
        color=MUTED,
    )

    y = 614
    y = add_section(
        canvas,
        y,
        "WHAT IT IS",
        [
            "A synchronized shared-media app for private rooms.",
            "Users can watch, listen, co-read PDFs, or run study sessions while chatting live.",
        ],
    )
    y = add_section(
        canvas,
        y,
        "WHO IT IS FOR",
        [
            "Primary persona: a signed-in host inviting a partner, friend, family member,",
            "or small group into a shared room for media plus social interaction.",
        ],
    )
    y = add_section(
        canvas,
        y,
        "WHAT IT DOES",
        [
            "Private room types for couple, friend, and family sessions.",
            "Five modes: watch, music, podcast, co-reading, and study.",
            "Playback or page sync across participants.",
            "Live chat, emoji reactions, bookmarks, and host-aware controls.",
            "WebRTC voice/video call signaling inside rooms.",
            "Social layer with friends, notifications, memories, insights, and couple watchlists.",
        ],
        bullet=True,
    )

    canvas.text(MARGIN_X, 78, "Summary grounded in repo source only.", font="F3", size=9, color=MUTED)
    canvas.text(PAGE_WIDTH - 210, 78, "Core files continue on page 2.", font="F3", size=9, color=MUTED)

    canvas.new_page()
    add_header(canvas, 2)

    y = 666
    y = add_section(
        canvas,
        y,
        "HOW IT WORKS",
        [
            "React + Vite frontend boots App, DashboardView, and per-mode session engines.",
            "Firebase Auth signs users in; the frontend sends ID tokens in REST and Socket.IO auth.",
            "Express REST + Socket.IO verify tokens with Firebase Admin and power rooms, sync,",
            "chat, reactions, invites, temporary PDF sharing, and WebRTC signaling.",
            "MongoDB via Mongoose stores profiles, relationships, rooms, sessions, reactions,",
            "milestones, and yearly insights; the server falls back to in-memory data if Mongo is absent.",
            "Active room state, sync clocks, presence, and expiring document uploads also live in memory.",
        ],
        bullet=True,
    )
    y = add_section(
        canvas,
        y,
        "HOW TO RUN",
        [
            "1. Install dependencies in the repo root, backend, and frontend.",
            "2. Provide Firebase Admin credentials with FIREBASE_SERVICE_ACCOUNT or",
            "   FIREBASE_SERVICE_ACCOUNT_PATH. Set MONGODB_URI if you want persistence.",
            "3. From the repo root, run npm start.",
            "4. Defaults in code: backend port 5001, frontend Vite port 5173, and",
            "   VITE_SERVER_URL can override the frontend-to-backend target.",
        ],
    )
    y = add_section(
        canvas,
        y,
        "NOT FOUND IN REPO",
        [
            "Top-level setup README.",
            "Deployment or production runbook.",
        ],
        bullet=True,
    )

    canvas.rect(MARGIN_X, 116, PAGE_WIDTH - (MARGIN_X * 2), 76, fill=PANEL, stroke=(0.86, 0.90, 0.94))
    canvas.text(MARGIN_X + 14, 170, "KEY EVIDENCE", font="F2", size=11, color=NAVY)
    canvas.text(
        MARGIN_X + 14,
        152,
        "package.json, backend/server.js, backend/DB_ARCHITECTURE.md,",
        size=10,
        color=INK,
    )
    canvas.text(
        MARGIN_X + 14,
        136,
        "frontend/src/App.jsx, frontend/src/DashboardView.jsx, frontend/src/firebase.js,",
        size=10,
        color=INK,
    )
    canvas.text(
        MARGIN_X + 14,
        120,
        "frontend/src/engines/*, and frontend/vite.config.js",
        size=10,
        color=INK,
    )

    canvas.text(MARGIN_X, 74, "Generated locally from repository evidence.", font="F3", size=9, color=MUTED)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    write_pdf(output_path, canvas.finalize())


def main():
    output_path = Path("output/pdf/lumiere-app-summary.pdf")
    build_pdf(output_path)
    print(output_path.resolve())


if __name__ == "__main__":
    main()
