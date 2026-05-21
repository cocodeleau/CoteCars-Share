# api/warp-plate.py
#
# Serverless Function Python — Vercel Pro
#
# Logique unique : Fake3D déterministe basé sur la bounding box.
# Zéro détection OpenCV (Canny, Hough, findContours supprimés).
#
# Cascade :
#   1. polygon  — fourni par PlateRecognizer (mmc=true)  → warp direct
#   2. fake3d   — ratio bbox < seuil → trapèze mathématique
#   3. bbox     — plaque frontale (ratio OK) → rectangle plat
#
# Reçoit : POST JSON {
#   "car_image":  "base64 JPEG",
#   "logo_image": "base64 PNG transparent"  (optionnel),
#   "polygon":    [{"x":…,"y":…}, …4 points…]  (optionnel),
#   "bbox":       {"xmin":…,"ymin":…,"xmax":…,"ymax":…}  (requis),
#   "img_width":  int  (optionnel — largeur image pour calcul côté fuyant)
# }
# Renvoie : { "result": "base64 JPEG", "method": "polygon|fake3d|bbox" }

import json
import base64
import numpy as np
import cv2
from http.server import BaseHTTPRequestHandler

# ── Constantes ───────────────────────────────────────────────────────────────
PLATE_REAL_RATIO  = 520.0 / 110.0  # 4.727 — ratio SIV français
BIAIS_THRESHOLD   = 4.20           # en dessous → plaque vue de biais
SHRINK_NEAR_SIDE  = 0.18           # réduction hauteur côté fuyant (18%)


# ─────────────────────────────────────────────────────────────────────────────
# TEMPLATE AUTOEASY — généré en mémoire, BGRA (height, width, 4)
# ─────────────────────────────────────────────────────────────────────────────
def build_autoeasy_template(width: int = 520, height: int = 110) -> np.ndarray:
    tpl = np.zeros((height, width, 4), dtype=np.uint8)
    tpl[:, :] = [17, 17, 17, 255]

    # Dégradé vertical : +20 brightness en haut → 0 en bas
    for y in range(height):
        b = int(20 * (1.0 - y / height))
        tpl[y, :, 0] = min(255, 17 + b)
        tpl[y, :, 1] = min(255, 17 + b)
        tpl[y, :, 2] = min(255, 17 + b)

    # Ombre interne basse (15% inférieurs)
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
    cv2.putText(tpl, text,
                ((width - tw) // 2, (height + th) // 2),
                font, font_scale, (255, 255, 255, 255), thickness, cv2.LINE_AA)
    return tpl


# ─────────────────────────────────────────────────────────────────────────────
# FAKE 3D — trapèze déterministe
#
# Principe :
#   - ratio bbox = largeur / hauteur
#   - si ratio < BIAIS_THRESHOLD → plaque de biais → trapèze
#   - le côté "fuyant" (vers le point de fuite) est le côté
#     le plus proche du centre horizontal de l'image
#   - on réduit l'écartement vertical de ce côté de SHRINK_NEAR_SIDE
#
#  Vue de 3/4 gauche :          Vue de 3/4 droit :
#
#   tl ──────────── tr            tl ──────────── tr
#   |                |             |                |
#   bl ──────────── br            bl ──────────── br
#   ↑ côté gauche = fuyant         côté droit = fuyant ↑
#   (proche centre)                (proche centre)
#
#  Résultat (trapèze) :          Résultat (trapèze) :
#
#   tl' ─────────── tr            tl ──────────── tr'
#    |               |             |                |
#   bl' ─────────── br            bl ──────────── br'
#
# ─────────────────────────────────────────────────────────────────────────────
def compute_destination_points(
    bbox:      dict,
    img_width: int,
) -> tuple[np.ndarray, str]:
    """
    Retourne (dst_pts [4,2] float32, method_label).
    Garantit toujours un résultat — jamais None.
    """
    xmin = float(bbox["xmin"])
    ymin = float(bbox["ymin"])
    xmax = float(bbox["xmax"])
    ymax = float(bbox["ymax"])

    bbox_w = xmax - xmin
    bbox_h = ymax - ymin

    if bbox_h < 1:
        # Dégénéré → rectangle plat
        return np.float32([
            [xmin, ymin], [xmax, ymin],
            [xmax, ymax], [xmin, ymax],
        ]), "bbox"

    ratio = bbox_w / bbox_h
    print(f"[Fake3D] ratio bbox = {ratio:.3f} | seuil = {BIAIS_THRESHOLD}")

    if ratio >= BIAIS_THRESHOLD:
        # Plaque quasi-frontale → rectangle plat correct
        print("[Fake3D] Plaque frontale — rectangle plat")
        return np.float32([
            [xmin, ymin], [xmax, ymin],
            [xmax, ymax], [xmin, ymax],
        ]), "bbox"

    # ── Plaque de biais → trapèze ────────────────────────────────
    shrink = bbox_h * SHRINK_NEAR_SIDE   # pixels à retirer de chaque côté

    # Le côté fuyant est le plus proche du centre de l'image
    cx_img     = img_width / 2.0
    dist_left  = abs(xmin - cx_img)
    dist_right = abs(xmax - cx_img)

    if dist_left <= dist_right:
        # Côté GAUCHE vers le point de fuite → on rétrécit à gauche
        tl = [xmin, ymin + shrink]   # haut-gauche remonté
        bl = [xmin, ymax - shrink]   # bas-gauche  descendu
        tr = [xmax, ymin]            # haut-droit  inchangé
        br = [xmax, ymax]            # bas-droit   inchangé
        side = "gauche"
    else:
        # Côté DROIT vers le point de fuite → on rétrécit à droite
        tl = [xmin, ymin]            # haut-gauche inchangé
        bl = [xmin, ymax]            # bas-gauche  inchangé
        tr = [xmax, ymin + shrink]   # haut-droit  remonté
        br = [xmax, ymax - shrink]   # bas-droit   descendu
        side = "droit"

    print(f"[Fake3D] trapèze — côté fuyant: {side} | shrink: {shrink:.1f}px")
    # Ordre : haut-gauche, haut-droit, bas-droit, bas-gauche
    return np.float32([tl, tr, br, bl]), "fake3d"


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
    """Retourne (base64_jpeg, method)"""

    # ── Décode l'image voiture ───────────────────────────────────
    car_bytes = base64.b64decode(car_b64)
    car_arr   = np.frombuffer(car_bytes, dtype=np.uint8)
    car_bgr   = cv2.imdecode(car_arr, cv2.IMREAD_COLOR)
    if car_bgr is None:
        raise ValueError("Impossible de décoder l'image voiture")
    car_h, car_w = car_bgr.shape[:2]

    # img_width fourni par Node.js (plus fiable que de le déduire)
    iw = img_width if img_width else car_w

    # ── Template ─────────────────────────────────────────────────
    if logo_b64:
        logo_bytes = base64.b64decode(logo_b64)
        logo_arr   = np.frombuffer(logo_bytes, dtype=np.uint8)
        template   = cv2.imdecode(logo_arr, cv2.IMREAD_UNCHANGED)
        if template is None:
            raise ValueError("Impossible de décoder le logo")
        if template.shape[2] == 3:
            alpha    = np.full(
                (template.shape[0], template.shape[1], 1), 255, dtype=np.uint8)
            template = np.concatenate([template, alpha], axis=2)
    else:
        template = build_autoeasy_template(520, 110)

    tpl_h, tpl_w = template.shape[:2]

    # Coins source (template plat 520×110)
    src_pts = np.float32([
        [0,     0    ],   # haut-gauche
        [tpl_w, 0    ],   # haut-droit
        [tpl_w, tpl_h],   # bas-droit
        [0,     tpl_h],   # bas-gauche
    ])

    # ── Priorité 1 : polygon PlateRecognizer ─────────────────────
    method  = "bbox"
    dst_pts = None

    if polygon and len(polygon) == 4:
        dst_pts = np.float32([
            [polygon[0]["x"], polygon[0]["y"]],
            [polygon[1]["x"], polygon[1]["y"]],
            [polygon[2]["x"], polygon[2]["y"]],
            [polygon[3]["x"], polygon[3]["y"]],
        ])
        method = "polygon"
        print("[warp-plate] Méthode : polygon PlateRecognizer")

    # ── Priorités 2 & 3 : Fake3D ou bbox (garanti non-None) ──────
    if dst_pts is None:
        dst_pts, method = compute_destination_points(bbox, iw)
        print(f"[warp-plate] Méthode : {method}")

    # ── Homographie ───────────────────────────────────────────────
    H = cv2.getPerspectiveTransform(src_pts, dst_pts)

    # Warp sur canvas pleine taille (transparent hors plaque)
    warped = cv2.warpPerspective(
        template, H, (car_w, car_h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0, 0),
    )

    # ── Alpha compositing ─────────────────────────────────────────
    alpha_ch  = warped[:, :, 3].astype(np.float32) / 255.0
    alpha_3ch = np.stack([alpha_ch] * 3, axis=-1)

    composite = (warped[:, :, :3].astype(np.float32) * alpha_3ch
                 + car_bgr.astype(np.float32)         * (1.0 - alpha_3ch))
    composite = np.clip(composite, 0, 255).astype(np.uint8)

    # ── Encode JPEG ───────────────────────────────────────────────
    ok, buf = cv2.imencode(".jpg", composite, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        raise ValueError("Échec encodage JPEG")

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