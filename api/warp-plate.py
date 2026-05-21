# api/warp-plate.py
#
# Serverless Function Python — Vercel Pro
# Rendu raffiné : padding négatif, feathering, dégradé, opacité 92%

import json
import base64
import numpy as np
import cv2
from http.server import BaseHTTPRequestHandler

# ── Constantes de raffinement ────────────────────────────────────────────────
INSET_RATIO   = 0.07   # 7% de retrait sur chaque bord (padding négatif)
FEATHER_PX    = 2      # rayon de flou sur les bords du cache (pixels)
OVERLAY_ALPHA = 0.92   # opacité globale du cache (92%)
SHRINK_3D     = 0.22   # déformation trapèze pour les vues de biais


# ─────────────────────────────────────────────────────────────────────────────
# TEMPLATE AUTOEASY RAFFINÉ
# Dégradé #D9D9D9 → #F5F5F5 + texte centré avec marge interne 18%
# Retourne BGRA (height, width, 4)
# ─────────────────────────────────────────────────────────────────────────────
def build_autoeasy_template(width: int = 520, height: int = 110) -> np.ndarray:
    tpl = np.zeros((height, width, 4), dtype=np.uint8)

    # Dégradé horizontal #D9D9D9 (gauche) → #F5F5F5 (droite)
    # Simule une légère réflexion de lumière studio
    c_left  = np.array([217, 217, 217], dtype=np.float32)  # #D9D9D9 BGR
    c_right = np.array([245, 245, 245], dtype=np.float32)  # #F5F5F5 BGR

    for x in range(width):
        t   = x / max(width - 1, 1)
        col = (c_left * (1 - t) + c_right * t).astype(np.uint8)
        tpl[:, x, 0] = col[0]
        tpl[:, x, 1] = col[1]
        tpl[:, x, 2] = col[2]

    # Canal alpha : opacité globale OVERLAY_ALPHA
    # Le feathering sera appliqué après warp via masque gaussien
    tpl[:, :, 3] = int(255 * OVERLAY_ALPHA)

    # ── Texte AUTOEASY ───────────────────────────────────────────
    # Couleur texte : gris foncé #555555 pour rester lisible sans être agressif
    font       = cv2.FONT_HERSHEY_DUPLEX
    text       = "AUTOEASY"
    margin_x   = int(width  * 0.18)   # marge interne 18%
    margin_y   = int(height * 0.18)
    max_tw     = width  - 2 * margin_x
    max_th     = height - 2 * margin_y

    # Calcule font_scale pour tenir dans la zone avec marge
    scale = 1.0
    for s in np.arange(3.0, 0.1, -0.05):
        (tw, th), _ = cv2.getTextSize(text, font, s, 2)
        if tw <= max_tw and th <= max_th:
            scale = s
            break

    thickness  = max(1, int(height / 28))
    (tw, th), _ = cv2.getTextSize(text, font, scale, thickness)
    tx = (width  - tw) // 2
    ty = (height + th) // 2

    cv2.putText(tpl, text, (tx, ty), font, scale,
                (85, 85, 85, int(255 * OVERLAY_ALPHA)),  # #555555
                thickness, cv2.LINE_AA)

    return tpl


# ─────────────────────────────────────────────────────────────────────────────
# FEATHERING — adoucit les bords du cache après warp
# Applique un flou gaussien uniquement sur le canal alpha
# ─────────────────────────────────────────────────────────────────────────────
def apply_feathering(warped_bgra: np.ndarray, radius: int = FEATHER_PX) -> np.ndarray:
    if radius < 1:
        return warped_bgra
    result   = warped_bgra.copy()
    alpha    = warped_bgra[:, :, 3].astype(np.float32)
    k        = radius * 2 + 1        # kernel impair
    blurred  = cv2.GaussianBlur(alpha, (k, k), 0)
    # On applique le flou uniquement sur les pixels de bordure
    # (là où l'alpha original est > 0 mais < 255)
    result[:, :, 3] = blurred.astype(np.uint8)
    return result


# ─────────────────────────────────────────────────────────────────────────────
# COMPUTE DST — trapèze avec padding négatif intégré
#
# 1. Applique INSET_RATIO sur la bbox → zone réduite
# 2. Applique le trapèze Fake3D sur cette zone réduite
# ─────────────────────────────────────────────────────────────────────────────
def compute_dst(bbox: dict, img_width: int) -> tuple[np.ndarray, str]:
    xmin = float(bbox["xmin"])
    ymin = float(bbox["ymin"])
    xmax = float(bbox["xmax"])
    ymax = float(bbox["ymax"])

    bw = xmax - xmin
    bh = ymax - ymin

    # ── Padding négatif (inset) ───────────────────────────────────
    ix = bw * INSET_RATIO   # retrait horizontal
    iy = bh * INSET_RATIO   # retrait vertical

    x1 = xmin + ix
    x2 = xmax - ix
    y1 = ymin + iy
    y2 = ymax - iy
    h  = y2 - y1

    # ── Trapèze Fake3D ────────────────────────────────────────────
    cx  = (xmin + xmax) / 2.0
    mid = img_width / 2.0
    d   = h * SHRINK_3D

    if cx < mid:
        # Plaque à gauche → côté droit écrasé
        dst = np.float32([
            [x1, y1    ],   # tl
            [x2, y1 + d],   # tr
            [x2, y2 - d],   # br
            [x1, y2    ],   # bl
        ])
        side = "gauche→droit écrasé"
    else:
        # Plaque à droite → côté gauche écrasé
        dst = np.float32([
            [x1, y1 + d],   # tl
            [x2, y1    ],   # tr
            [x2, y2    ],   # br
            [x1, y2 - d],   # bl
        ])
        side = "droite→gauche écrasé"

    print(f"[warp-plate] inset={ix:.1f}×{iy:.1f}px | d={d:.1f}px | {side}")
    return dst, side


# ─────────────────────────────────────────────────────────────────────────────
# WARP + ALPHA COMPOSITING
# ─────────────────────────────────────────────────────────────────────────────
def warp_and_composite(
    car_b64:   str,
    logo_b64:  str | None,
    polygon:   list | None,
    bbox:      dict,
    img_width: int | None,
) -> tuple[str, str]:

    # Décode voiture
    car_bytes = base64.b64decode(car_b64)
    car_arr   = np.frombuffer(car_bytes, dtype=np.uint8)
    car_bgr   = cv2.imdecode(car_arr, cv2.IMREAD_COLOR)
    if car_bgr is None:
        raise ValueError("Impossible de décoder l'image voiture")
    car_h, car_w = car_bgr.shape[:2]
    iw = img_width if img_width else car_w

    # Template BGRA
    if logo_b64:
        logo_bytes = base64.b64decode(logo_b64)
        logo_arr   = np.frombuffer(logo_bytes, dtype=np.uint8)
        template   = cv2.imdecode(logo_arr, cv2.IMREAD_UNCHANGED)
        if template is None:
            raise ValueError("Impossible de décoder le logo")
        if template.shape[2] == 3:
            a_ch     = np.full((template.shape[0], template.shape[1], 1),
                               int(255 * OVERLAY_ALPHA), dtype=np.uint8)
            template = np.concatenate([template, a_ch], axis=2)
        else:
            # Applique l'opacité globale sur le logo fourni
            template = template.copy()
            template[:, :, 3] = (
                template[:, :, 3].astype(np.float32) * OVERLAY_ALPHA
            ).astype(np.uint8)
    else:
        template = build_autoeasy_template(520, 110)

    tpl_h, tpl_w = template.shape[:2]

    # Coins source (tl, tr, br, bl sens horaire)
    src_pts = np.float32([
        [0,     0    ],
        [tpl_w, 0    ],
        [tpl_w, tpl_h],
        [0,     tpl_h],
    ])

    # ── Priorité 1 : polygon PlateRecognizer ─────────────────────
    method  = None
    dst_pts = None

    if polygon and len(polygon) == 4:
        # Applique quand même l'inset sur le polygon pour la finesse
        pts = np.float32([
            [polygon[0]["x"], polygon[0]["y"]],
            [polygon[1]["x"], polygon[1]["y"]],
            [polygon[2]["x"], polygon[2]["y"]],
            [polygon[3]["x"], polygon[3]["y"]],
        ])
        # Centre du polygon
        cx_p = float(np.mean(pts[:, 0]))
        cy_p = float(np.mean(pts[:, 1]))
        # Réduit chaque coin vers le centre de INSET_RATIO
        inset_pts = pts + (np.array([[cx_p, cy_p]] * 4, dtype=np.float32) - pts) * INSET_RATIO
        dst_pts = inset_pts
        method  = "polygon"
        print("[warp-plate] Méthode : polygon PlateRecognizer (inset appliqué)")

    # ── Priorité 2 : Fake3D + inset ──────────────────────────────
    if dst_pts is None:
        dst_pts, side = compute_dst(bbox, iw)
        method = "fake3d"

    # ── Homographie ───────────────────────────────────────────────
    H = cv2.getPerspectiveTransform(src_pts, dst_pts)

    # Warp BGRA — bordures transparentes garanties
    warped = cv2.warpPerspective(
        template, H, (car_w, car_h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0, 0),
    )

    # ── Feathering sur les bords ──────────────────────────────────
    warped = apply_feathering(warped, radius=FEATHER_PX)

    # ── Alpha compositing ─────────────────────────────────────────
    alpha_raw = warped[:, :, 3].astype(np.float32) / 255.0
    alpha_3ch = np.stack([alpha_raw] * 3, axis=-1)

    composite = (warped[:, :, :3].astype(np.float32) * alpha_3ch
                 + car_bgr.astype(np.float32)         * (1.0 - alpha_3ch))
    composite = np.clip(composite, 0, 255).astype(np.uint8)

    ok, buf = cv2.imencode(".jpg", composite, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        raise ValueError("Échec encodage JPEG")

    print(f"[warp-plate] Rendu OK — {len(buf)} octets | méthode: {method}")
    return base64.b64encode(buf.tobytes()).decode("utf-8"), method


# ─────────────────────────────────────────────────────────────────────────────
# HANDLER VERCEL
# ─────────────────────────────────────────────────────────────────────────────
class handler(BaseHTTPRequestHandler):

    def do_POST(self):
        try:
            length  = int(self.headers.get("Content-Length", 0))
            body    = self.rfile.read(length)
            payload = json.loads(body)

            car_b64   = payload.get("car_image")
            logo_b64  = payload.get("logo_image")
            polygon   = payload.get("polygon")
            bbox      = payload.get("bbox")
            img_width = payload.get("img_width")

            if not car_b64 or not bbox:
                self._json(400, {"error": "car_image et bbox sont requis"})
                return

            result_b64, method = warp_and_composite(
                car_b64, logo_b64, polygon, bbox, img_width
            )
            self._json(200, {"result": result_b64, "method": method})

        except Exception as e:
            import traceback
            print("[warp-plate] Erreur :", traceback.format_exc())
            self._json(200, {"error": str(e)})

    def do_GET(self):
        self._json(200, {"status": "warp-plate OK"})

    def _json(self, code: int, data: dict):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type",   "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass