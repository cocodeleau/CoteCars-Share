# api/warp-plate.py
#
# Serverless Function Python — Vercel Pro
#
# Pipeline de détection des 4 coins (ordre de priorité) :
#   1. polygon      fourni par PlateRecognizer (mmc=true)
#   2. hough        lignes de fuite HoughLinesP → intersections avec bbox
#   3. fake3d       trapèze mathématique basé sur le ratio bbox vs ratio réel plaque FR
#   4. bbox         fallback plat garanti (ne doit jamais être atteint en pratique)
#
# Reçoit : POST JSON {
#   "car_image":  "base64 JPEG",
#   "logo_image": "base64 PNG transparent"  (optionnel),
#   "polygon":    [{"x":…,"y":…}, …4 points…]  (optionnel),
#   "bbox":       {"xmin":…,"ymin":…,"xmax":…,"ymax":…}  (requis)
# }
# Renvoie : {
#   "result": "base64 JPEG",
#   "method": "polygon|hough|fake3d|bbox"
# }

import json
import base64
import math
import numpy as np
import cv2
from http.server import BaseHTTPRequestHandler

# Ratio réel d'une plaque SIV française : 520mm / 110mm
PLATE_REAL_RATIO = 520.0 / 110.0   # ≈ 4.727
# En dessous de ce ratio bbox, on considère que la plaque est vue de biais
PERSPECTIVE_RATIO_THRESHOLD = 4.2
# Réduction de hauteur du côté vers le point de fuite (15%)
FAKE3D_SHRINK = 0.15


# ─────────────────────────────────────────────────────────────────────────────
# TEMPLATE AUTOEASY — généré en mémoire, BGRA
# ─────────────────────────────────────────────────────────────────────────────
def build_autoeasy_template(width: int = 520, height: int = 110) -> np.ndarray:
    tpl = np.zeros((height, width, 4), dtype=np.uint8)
    tpl[:, :] = [17, 17, 17, 255]

    # Dégradé lumineux vertical (effet 3D)
    for y in range(height):
        b = int(20 * (1.0 - y / height))
        tpl[y, :, 0] = min(255, 17 + b)
        tpl[y, :, 1] = min(255, 17 + b)
        tpl[y, :, 2] = min(255, 17 + b)

    # Ombre interne basse
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
# MÉTHODE 2 — HOUGH LINES
#
# Stratégie :
#   1. ROI + Canny
#   2. HoughLinesP → segments quasi-horizontaux seulement
#   3. Clustering : 2 groupes (haut / bas) par médiane Y
#   4. Régression linéaire sur chaque groupe → droite ax + b
#   5. Intersection de chaque droite avec x=xmin et x=xmax de la bbox
#      → 4 coins en perspective
# ─────────────────────────────────────────────────────────────────────────────
def detect_corners_hough(
    car_bgr: np.ndarray,
    bbox: dict,
    margin: int = 20,
) -> np.ndarray | None:

    car_h, car_w = car_bgr.shape[:2]

    x1 = max(0,     bbox["xmin"] - margin)
    y1 = max(0,     bbox["ymin"] - margin)
    x2 = min(car_w, bbox["xmax"] + margin)
    y2 = min(car_h, bbox["ymax"] + margin)

    roi = car_bgr[y1:y2, x1:x2]
    if roi.size == 0:
        return None

    roi_h, roi_w = roi.shape[:2]

    # Preprocessing Canny
    gray    = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    median  = float(np.median(blurred))
    sigma   = 0.4
    edges   = cv2.Canny(
        blurred,
        int(max(0,   (1.0 - sigma) * median)),
        int(min(255, (1.0 + sigma) * median)),
    )

    # HoughLinesP — paramètres calibrés pour des plaques ~100-500px de large
    min_length = max(roi_w * 0.25, 20)
    lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 180,
        threshold=25,
        minLineLength=min_length,
        maxLineGap=roi_w * 0.15,
    )

    if lines is None:
        print("[Hough] Aucune ligne détectée")
        return None

    # Filtre : on garde uniquement les lignes quasi-horizontales
    # angle ≤ 25° par rapport à l'horizontale
    horizontal = []
    for line in lines:
        x_a, y_a, x_b, y_b = line[0]
        angle = abs(math.degrees(math.atan2(y_b - y_a, x_b - x_a)))
        if angle <= 25 or angle >= 155:
            horizontal.append((x_a, y_a, x_b, y_b))

    if len(horizontal) < 2:
        print(f"[Hough] Trop peu de lignes horizontales : {len(horizontal)}")
        return None

    # Coordonnées dans l'espace global
    segs_global = []
    for (x_a, y_a, x_b, y_b) in horizontal:
        segs_global.append((x_a + x1, y_a + y1, x_b + x1, y_b + y1))

    # Clustering haut/bas par médiane Y du segment
    ys = [(s[1] + s[3]) / 2 for s in segs_global]
    y_median = float(np.median(ys))

    top_segs = [s for s, y in zip(segs_global, ys) if y <= y_median]
    bot_segs = [s for s, y in zip(segs_global, ys) if y >  y_median]

    if not top_segs or not bot_segs:
        print("[Hough] Impossible de séparer haut/bas")
        return None

    # Régression linéaire sur chaque groupe → droite y = a*x + b
    def fit_line(segs):
        pts = []
        for (x_a, y_a, x_b, y_b) in segs:
            pts.append((x_a, y_a))
            pts.append((x_b, y_b))
        pts = np.array(pts, dtype=np.float32)
        # np.polyfit : y = a*x + b
        if len(pts) < 2 or np.ptp(pts[:, 0]) < 1:
            return None
        a, b = np.polyfit(pts[:, 0], pts[:, 1], 1)
        return float(a), float(b)

    top_line = fit_line(top_segs)
    bot_line = fit_line(bot_segs)

    if top_line is None or bot_line is None:
        print("[Hough] Régression linéaire échouée")
        return None

    a_top, b_top = top_line
    a_bot, b_bot = bot_line

    # Intersections avec x = xmin et x = xmax de la bbox
    xl = float(bbox["xmin"])
    xr = float(bbox["xmax"])

    tl = [xl, a_top * xl + b_top]  # haut-gauche
    tr = [xr, a_top * xr + b_top]  # haut-droit
    br = [xr, a_bot * xr + b_bot]  # bas-droit
    bl = [xl, a_bot * xl + b_bot]  # bas-gauche

    # Sanity check : les coins doivent rester proches de la bbox
    margin_sanity = max(roi_h, roi_w) * 0.5
    for pt in [tl, tr, br, bl]:
        if (pt[1] < bbox["ymin"] - margin_sanity or
                pt[1] > bbox["ymax"] + margin_sanity):
            print(f"[Hough] Coin hors limites {pt} — annulé")
            return None

    print(f"[Hough] OK — top: a={a_top:.3f} | bot: a={a_bot:.3f}")
    return np.float32([tl, tr, br, bl])


# ─────────────────────────────────────────────────────────────────────────────
# MÉTHODE 3 — FAKE 3D MATHÉMATIQUE
#
# Si ratio(bbox) < PERSPECTIVE_RATIO_THRESHOLD  → plaque vue de biais.
# On crée un trapèze en réduisant la hauteur du côté vers le point de fuite.
# Le point de fuite est le côté (gauche ou droit) le plus proche du centre
# de l'image — c'est le côté qui s'éloigne vers l'horizon.
# ─────────────────────────────────────────────────────────────────────────────
def fake3d_trapeze(
    car_w: int,
    car_h: int,
    bbox: dict,
) -> tuple[np.ndarray | None, str]:
    """
    Retourne (pts_4coins, raison) ou (None, raison)
    """
    xmin = float(bbox["xmin"])
    ymin = float(bbox["ymin"])
    xmax = float(bbox["xmax"])
    ymax = float(bbox["ymax"])

    bbox_w = xmax - xmin
    bbox_h = ymax - ymin

    if bbox_h < 1:
        return None, "bbox_h nul"

    ratio = bbox_w / bbox_h
    print(f"[Fake3D] ratio bbox={ratio:.2f} | seuil={PERSPECTIVE_RATIO_THRESHOLD}")

    if ratio >= PERSPECTIVE_RATIO_THRESHOLD:
        # Plaque quasi-frontale → rectangle plat suffisant, pas de trapèze
        return None, f"ratio {ratio:.2f} ≥ {PERSPECTIVE_RATIO_THRESHOLD} (plaque frontale)"

    # Détermine le côté vers le point de fuite :
    # C'est le côté (xmin ou xmax) le plus proche du centre horizontal
    cx_img   = car_w / 2.0
    dist_left  = abs(xmin - cx_img)
    dist_right = abs(xmax - cx_img)

    shrink_px = bbox_h * FAKE3D_SHRINK  # pixels à retirer en haut ET en bas du côté fuyant

    if dist_left < dist_right:
        # Le côté gauche est vers le point de fuite → on rétrécit à gauche
        tl = [xmin, ymin + shrink_px]
        bl = [xmin, ymax - shrink_px]
        tr = [xmax, ymin]
        br = [xmax, ymax]
        side = "gauche"
    else:
        # Le côté droit est vers le point de fuite → on rétrécit à droite
        tl = [xmin, ymin]
        bl = [xmin, ymax]
        tr = [xmax, ymin + shrink_px]
        br = [xmax, ymax - shrink_px]
        side = "droit"

    print(f"[Fake3D] trapèze — côté fuyant: {side} | shrink: {shrink_px:.1f}px")
    return np.float32([tl, tr, br, bl]), f"trapèze côté {side}"


# ─────────────────────────────────────────────────────────────────────────────
# WARP + ALPHA COMPOSITING
# ─────────────────────────────────────────────────────────────────────────────
def warp_and_composite(
    car_b64:  str,
    logo_b64: str | None,
    polygon:  list | None,
    bbox:     dict,
) -> tuple[str, str]:

    # Décode voiture
    car_bytes = base64.b64decode(car_b64)
    car_arr   = np.frombuffer(car_bytes, dtype=np.uint8)
    car_bgr   = cv2.imdecode(car_arr, cv2.IMREAD_COLOR)
    if car_bgr is None:
        raise ValueError("Impossible de décoder l'image voiture")
    car_h, car_w = car_bgr.shape[:2]

    # Template
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

    src_pts = np.float32([
        [0,     0    ],
        [tpl_w, 0    ],
        [tpl_w, tpl_h],
        [0,     tpl_h],
    ])

    # ── Cascade de détection ─────────────────────────────────────
    method  = "bbox"
    dst_pts = None

    # 1. Polygon PlateRecognizer
    if polygon and len(polygon) == 4:
        dst_pts = np.float32([
            [polygon[0]["x"], polygon[0]["y"]],
            [polygon[1]["x"], polygon[1]["y"]],
            [polygon[2]["x"], polygon[2]["y"]],
            [polygon[3]["x"], polygon[3]["y"]],
        ])
        method = "polygon"
        print("[warp-plate] Méthode : polygon PlateRecognizer")

    # 2. Hough Lines
    if dst_pts is None:
        try:
            hough_pts = detect_corners_hough(car_bgr, bbox)
            if hough_pts is not None:
                dst_pts = hough_pts
                method  = "hough"
                print("[warp-plate] Méthode : Hough Lines")
        except Exception as e:
            print(f"[warp-plate] Hough erreur : {e}")

    # 3. Fake 3D trapèze mathématique
    if dst_pts is None:
        try:
            fake_pts, reason = fake3d_trapeze(car_w, car_h, bbox)
            if fake_pts is not None:
                dst_pts = fake_pts
                method  = "fake3d"
                print(f"[warp-plate] Méthode : Fake3D ({reason})")
            else:
                print(f"[warp-plate] Fake3D non applicable : {reason} → bbox plat")
        except Exception as e:
            print(f"[warp-plate] Fake3D erreur : {e}")

    # 4. Fallback bbox plat (plaque frontale ou tous échouent)
    if dst_pts is None:
        xmin = bbox["xmin"]; ymin = bbox["ymin"]
        xmax = bbox["xmax"]; ymax = bbox["ymax"]
        dst_pts = np.float32([
            [xmin, ymin], [xmax, ymin],
            [xmax, ymax], [xmin, ymax],
        ])
        method = "bbox"
        print("[warp-plate] Méthode : bbox plat (plaque frontale)")

    # ── Homographie + Warp ───────────────────────────────────────
    H = cv2.getPerspectiveTransform(src_pts, dst_pts)

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

            car_b64  = payload.get("car_image")
            logo_b64 = payload.get("logo_image")
            polygon  = payload.get("polygon")
            bbox     = payload.get("bbox")

            if not car_b64 or not bbox:
                self._json(400, {"error": "car_image et bbox sont requis"})
                return

            result_b64, method = warp_and_composite(car_b64, logo_b64, polygon, bbox)
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