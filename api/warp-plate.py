# api/warp-plate.py
#
# Serverless Function Python — Vercel Pro
# Fake3D FORCÉ — trapèze 30% sans condition, pour validation visuelle.

import json
import base64
import numpy as np
import cv2
from http.server import BaseHTTPRequestHandler


# ─────────────────────────────────────────────────────────────────────────────
# TEMPLATE AUTOEASY — BGRA (height, width, 4)
# ─────────────────────────────────────────────────────────────────────────────
def build_autoeasy_template(width: int = 520, height: int = 110) -> np.ndarray:
    tpl = np.zeros((height, width, 4), dtype=np.uint8)
    tpl[:, :] = [17, 17, 17, 255]

    for y in range(height):
        b = int(20 * (1.0 - y / height))
        tpl[y, :, 0] = min(255, 17 + b)
        tpl[y, :, 1] = min(255, 17 + b)
        tpl[y, :, 2] = min(255, 17 + b)

    shadow_h = max(2, height // 7)
    for y in range(height - shadow_h, height):
        factor   = (y - (height - shadow_h)) / shadow_h
        darkness = int(12 * factor)
        tpl[y, :, 0] = max(0, int(tpl[y, 0, 0]) - darkness)
        tpl[y, :, 1] = max(0, int(tpl[y, 0, 1]) - darkness)
        tpl[y, :, 2] = max(0, int(tpl[y, 0, 2]) - darkness)

    font       = cv2.FONT_HERSHEY_DUPLEX
    text       = "AUTOEASY"
    font_scale = height / 45.0
    thickness  = max(1, int(height / 22))
    (tw, th), _ = cv2.getTextSize(text, font, font_scale, thickness)
    cv2.putText(tpl, text,
                ((width - tw) // 2, (height + th) // 2),
                font, font_scale, (255, 255, 255, 255), thickness, cv2.LINE_AA)
    return tpl


# ─────────────────────────────────────────────────────────────────────────────
# COMPUTE DST — trapèze 30% FORCÉ, sans condition
#
# Centre image → détermine quel côté de la plaque est le point de fuite.
#
# CAS A — plaque à GAUCHE du centre (côté droit = point de fuite) :
#   tl = [xmin, ymin]                        tr = [xmax, ymin + h*0.3]
#   bl = [xmin, ymax]                        br = [xmax, ymax - h*0.3]
#
# CAS B — plaque à DROITE du centre (côté gauche = point de fuite) :
#   tl = [xmin, ymin + h*0.3]               tr = [xmax, ymin]
#   bl = [xmin, ymax - h*0.3]               br = [xmax, ymax]
# ─────────────────────────────────────────────────────────────────────────────
def compute_dst(bbox: dict, img_width: int, shrink: float = 0.30) -> tuple[np.ndarray, str]:
    xmin = float(bbox["xmin"])
    ymin = float(bbox["ymin"])
    xmax = float(bbox["xmax"])
    ymax = float(bbox["ymax"])
    h    = ymax - ymin
    cx   = (xmin + xmax) / 2.0
    mid  = img_width / 2.0
    d    = h * shrink

    if cx < mid:
        # CAS A — plaque à gauche → côté droit écrasé
        dst = np.float32([
            [xmin, ymin      ],   # tl — inchangé
            [xmax, ymin + d  ],   # tr — descendu
            [xmax, ymax - d  ],   # br — remonté
            [xmin, ymax      ],   # bl — inchangé
        ])
        side = "A (plaque gauche, côté droit écrasé)"
    else:
        # CAS B — plaque à droite → côté gauche écrasé
        dst = np.float32([
            [xmin, ymin + d  ],   # tl — descendu
            [xmax, ymin      ],   # tr — inchangé
            [xmax, ymax      ],   # br — inchangé
            [xmin, ymax - d  ],   # bl — remonté
        ])
        side = "B (plaque droite, côté gauche écrasé)"

    print(f"[warp-plate] CAS {side} | h={h:.1f} | d={d:.1f} | cx={cx:.1f} | mid={mid:.1f}")
    print(f"[warp-plate] dst_pts = {dst.tolist()}")
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
            alpha    = np.full((template.shape[0], template.shape[1], 1), 255, dtype=np.uint8)
            template = np.concatenate([template, alpha], axis=2)
    else:
        template = build_autoeasy_template(520, 110)

    tpl_h, tpl_w = template.shape[:2]

    # Coins source — template plat rectangulaire
    # Ordre : tl, tr, br, bl  (sens horaire)
    src_pts = np.float32([
        [0,     0    ],   # tl
        [tpl_w, 0    ],   # tr
        [tpl_w, tpl_h],   # br
        [0,     tpl_h],   # bl
    ])

    # ── Priorité 1 : polygon PlateRecognizer ─────────────────────
    method  = None
    dst_pts = None

    if polygon and len(polygon) == 4:
        # PlateRecognizer retourne : tl, tr, br, bl (sens horaire)
        dst_pts = np.float32([
            [polygon[0]["x"], polygon[0]["y"]],
            [polygon[1]["x"], polygon[1]["y"]],
            [polygon[2]["x"], polygon[2]["y"]],
            [polygon[3]["x"], polygon[3]["y"]],
        ])
        method = "polygon"
        print("[warp-plate] Méthode : polygon PlateRecognizer")

    # ── Priorité 2 : Fake3D FORCÉ ────────────────────────────────
    if dst_pts is None:
        dst_pts, side = compute_dst(bbox, iw, shrink=0.30)
        method = "fake3d"

    # ── Homographie ───────────────────────────────────────────────
    H = cv2.getPerspectiveTransform(src_pts, dst_pts)

    # Warp BGRA sur canvas pleine taille
    # BORDER_CONSTANT + borderValue=(0,0,0,0) → alpha=0 hors zone = transparent
    warped_bgra = cv2.warpPerspective(
        template,
        H,
        (car_w, car_h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0, 0),   # ← BGRA : transparent hors trapèze
    )

    # ── Alpha compositing propre ──────────────────────────────────
    # Canal alpha du template warpé (0 = transparent, 255 = opaque)
    alpha_raw = warped_bgra[:, :, 3].astype(np.float32) / 255.0  # [0.0, 1.0]
    alpha_3ch = np.stack([alpha_raw] * 3, axis=-1)                # broadcast RGB

    warped_rgb = warped_bgra[:, :, :3].astype(np.float32)
    car_float  = car_bgr.astype(np.float32)

    # out = alpha * template + (1 - alpha) * voiture
    composite  = warped_rgb * alpha_3ch + car_float * (1.0 - alpha_3ch)
    composite  = np.clip(composite, 0, 255).astype(np.uint8)

    # Encode JPEG
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