# api/warp-plate.py
#
# Serverless Function Python — Vercel Pro
#
# Reçoit : POST JSON {
#   "car_image":  "base64 JPEG",
#   "logo_image": "base64 PNG transparent"  (optionnel),
#   "polygon":    [{"x":…,"y":…}, …4 points…]  (optionnel — prioritaire),
#   "bbox":       {"xmin":…,"ymin":…,"xmax":…,"ymax":…}  (requis)
# }
# Renvoie : { "result": "base64 JPEG" }
#        ou { "error":  "message" }

import json
import base64
import numpy as np
import cv2
from http.server import BaseHTTPRequestHandler


# ─────────────────────────────────────────────────────────────────────────────
# TEMPLATE AUTOEASY
# Généré en mémoire — pas de fichier externe requis.
# Retourne un ndarray BGRA (height, width, 4).
# ─────────────────────────────────────────────────────────────────────────────
def build_autoeasy_template(width: int = 520, height: int = 110) -> np.ndarray:
    tpl = np.zeros((height, width, 4), dtype=np.uint8)

    # Fond de base #111111 opaque
    tpl[:, :] = [17, 17, 17, 255]

    # Dégradé vertical : +20 brightness en haut → 0 en bas
    # Simule la lumière studio venant du haut
    for y in range(height):
        b = int(20 * (1.0 - y / height))
        tpl[y, :, 0] = min(255, 17 + b)
        tpl[y, :, 1] = min(255, 17 + b)
        tpl[y, :, 2] = min(255, 17 + b)

    # Ombre interne sur les 15% inférieurs (renforce la profondeur)
    shadow_h = max(2, height // 7)
    for y in range(height - shadow_h, height):
        factor   = (y - (height - shadow_h)) / shadow_h
        darkness = int(12 * factor)
        tpl[y, :, 0] = max(0, int(tpl[y, 0, 0]) - darkness)
        tpl[y, :, 1] = max(0, int(tpl[y, 0, 1]) - darkness)
        tpl[y, :, 2] = max(0, int(tpl[y, 0, 2]) - darkness)

    # Texte AUTOEASY centré
    font       = cv2.FONT_HERSHEY_DUPLEX
    text       = "AUTOEASY"
    font_scale = height / 45.0
    thickness  = max(1, int(height / 22))

    (tw, th), _ = cv2.getTextSize(text, font, font_scale, thickness)
    tx = (width  - tw) // 2
    ty = (height + th) // 2

    cv2.putText(tpl, text, (tx, ty), font, font_scale,
                (255, 255, 255, 255), thickness, cv2.LINE_AA)

    return tpl


# ─────────────────────────────────────────────────────────────────────────────
# WARP + ALPHA COMPOSITING
# ─────────────────────────────────────────────────────────────────────────────
def warp_and_composite(
    car_b64:  str,
    logo_b64: str | None,
    polygon:  list | None,
    bbox:     dict,
) -> str:
    # ── Décode l'image voiture ───────────────────────────────────
    car_bytes = base64.b64decode(car_b64)
    car_arr   = np.frombuffer(car_bytes, dtype=np.uint8)
    car_bgr   = cv2.imdecode(car_arr, cv2.IMREAD_COLOR)
    if car_bgr is None:
        raise ValueError("Impossible de décoder l'image voiture")
    car_h, car_w = car_bgr.shape[:2]

    # ── Template : logo fourni ou généré en mémoire ──────────────
    if logo_b64:
        logo_bytes = base64.b64decode(logo_b64)
        logo_arr   = np.frombuffer(logo_bytes, dtype=np.uint8)
        template   = cv2.imdecode(logo_arr, cv2.IMREAD_UNCHANGED)
        if template is None:
            raise ValueError("Impossible de décoder le logo")
        if template.shape[2] == 3:
            alpha    = np.full((template.shape[0], template.shape[1], 1),
                               255, dtype=np.uint8)
            template = np.concatenate([template, alpha], axis=2)
    else:
        template = build_autoeasy_template(520, 110)

    tpl_h, tpl_w = template.shape[:2]

    # ── 4 coins source (template plat 520×110) ───────────────────
    src_pts = np.float32([
        [0,     0    ],   # haut-gauche
        [tpl_w, 0    ],   # haut-droit
        [tpl_w, tpl_h],   # bas-droit
        [0,     tpl_h],   # bas-gauche
    ])

    # ── 4 coins destination (plaque sur la voiture) ──────────────
    if polygon and len(polygon) == 4:
        dst_pts = np.float32([
            [polygon[0]["x"], polygon[0]["y"]],
            [polygon[1]["x"], polygon[1]["y"]],
            [polygon[2]["x"], polygon[2]["y"]],
            [polygon[3]["x"], polygon[3]["y"]],
        ])
    else:
        # Fallback bounding box droite
        xmin = bbox["xmin"]; ymin = bbox["ymin"]
        xmax = bbox["xmax"]; ymax = bbox["ymax"]
        dst_pts = np.float32([
            [xmin, ymin], [xmax, ymin],
            [xmax, ymax], [xmin, ymax],
        ])

    # ── Matrice d'homographie 3×3 ────────────────────────────────
    H = cv2.getPerspectiveTransform(src_pts, dst_pts)

    # ── Warp sur canvas pleine taille ────────────────────────────
    warped = cv2.warpPerspective(
        template,
        H,
        (car_w, car_h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0, 0),
    )

    # ── Alpha compositing ─────────────────────────────────────────
    alpha_ch  = warped[:, :, 3].astype(np.float32) / 255.0
    alpha_3ch = np.stack([alpha_ch] * 3, axis=-1)

    warped_bgr = warped[:, :, :3].astype(np.float32)
    car_float  = car_bgr.astype(np.float32)

    composite = warped_bgr * alpha_3ch + car_float * (1.0 - alpha_3ch)
    composite = np.clip(composite, 0, 255).astype(np.uint8)

    # ── Encode JPEG base64 ────────────────────────────────────────
    ok, buf = cv2.imencode(".jpg", composite, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        raise ValueError("Échec encodage JPEG")

    return base64.b64encode(buf.tobytes()).decode("utf-8")


# ─────────────────────────────────────────────────────────────────────────────
# HANDLER VERCEL
# ─────────────────────────────────────────────────────────────────────────────
class handler(BaseHTTPRequestHandler):

    def do_POST(self):
        try:
            length  = int(self.headers.get("Content-Length", 0))
            body    = self.rfile.read(length)
            payload = json.loads(body)

            car_b64  = payload.get("car_image")
            logo_b64 = payload.get("logo_image")
            polygon  = payload.get("polygon")
            bbox     = payload.get("bbox")

            if not car_b64 or not bbox:
                self._json(400, {"error": "car_image et bbox sont requis"})
                return

            result_b64 = warp_and_composite(car_b64, logo_b64, polygon, bbox)
            self._json(200, {"result": result_b64})

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
