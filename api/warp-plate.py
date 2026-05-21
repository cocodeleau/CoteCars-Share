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
# Renvoie : { "result": "base64 JPEG", "method": "polygon|contour|bbox" }
#        ou { "error":  "message" }
#
# Ordre de priorité pour les 4 coins destination :
#   1. polygon    fourni par PlateRecognizer (mmc=true)  — le plus précis
#   2. contour    détecté par OpenCV sur le ROI          — détection locale
#   3. bbox       bounding box droite                    — fallback garanti

import json
import base64
import numpy as np
import cv2
from http.server import BaseHTTPRequestHandler


# ─────────────────────────────────────────────────────────────────────────────
# TEMPLATE AUTOEASY
# Généré en mémoire — retourne ndarray BGRA (height, width, 4)
# ─────────────────────────────────────────────────────────────────────────────
def build_autoeasy_template(width: int = 520, height: int = 110) -> np.ndarray:
    tpl = np.zeros((height, width, 4), dtype=np.uint8)

    # Fond #111111 opaque
    tpl[:, :] = [17, 17, 17, 255]

    # Dégradé vertical : +20 brightness en haut → 0 en bas
    for y in range(height):
        b = int(20 * (1.0 - y / height))
        tpl[y, :, 0] = min(255, 17 + b)
        tpl[y, :, 1] = min(255, 17 + b)
        tpl[y, :, 2] = min(255, 17 + b)

    # Ombre interne sur les 15% inférieurs
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
# DÉTECTION DE CONTOURS — cœur de la nouveauté
#
# Stratégie :
#   1. Découpe le ROI avec marge de 15px autour de la bbox
#   2. Grayscale → blur léger → Canny edge detection
#   3. findContours → cherche le plus grand contour à 4 côtés
#   4. Réajuste les coordonnées dans l'espace de l'image globale
#   5. Retourne les 4 coins triés (haut-gauche, haut-droit, bas-droit, bas-gauche)
#      ou None si aucun quadrilatère propre trouvé
# ─────────────────────────────────────────────────────────────────────────────
def detect_plate_corners_from_contour(
    car_bgr: np.ndarray,
    bbox: dict,
    margin: int = 15,
) -> np.ndarray | None:

    car_h, car_w = car_bgr.shape[:2]

    # ── 1. Découpe ROI avec marge ────────────────────────────────
    x1 = max(0,     bbox["xmin"] - margin)
    y1 = max(0,     bbox["ymin"] - margin)
    x2 = min(car_w, bbox["xmax"] + margin)
    y2 = min(car_h, bbox["ymax"] + margin)

    roi = car_bgr[y1:y2, x1:x2]
    if roi.size == 0:
        return None

    roi_h, roi_w = roi.shape[:2]

    # ── 2. Preprocessing edge detection ─────────────────────────
    gray    = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)

    # Blur léger pour supprimer le bruit de compression JPEG
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)

    # Canny adaptatif : seuils calculés depuis la médiane
    median   = float(np.median(blurred))
    sigma    = 0.33
    low      = int(max(0,   (1.0 - sigma) * median))
    high     = int(min(255, (1.0 + sigma) * median))
    edges    = cv2.Canny(blurred, low, high)

    # Dilatation légère pour fermer les contours ouverts
    kernel   = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    edges    = cv2.dilate(edges, kernel, iterations=1)

    # ── 3. findContours ──────────────────────────────────────────
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    if not contours:
        return None

    # Trie par aire décroissante — la plaque est généralement le plus grand
    # contour rectangulaire dans le ROI
    contours_sorted = sorted(contours, key=cv2.contourArea, reverse=True)

    best_quad = None
    best_area = 0

    for cnt in contours_sorted[:8]:  # on teste seulement les 8 plus grands
        area = cv2.contourArea(cnt)

        # Ignore les contours trop petits (bruit)
        if area < (roi_w * roi_h * 0.05):
            continue

        # Approximation polygonale — epsilon = 2% du périmètre
        peri   = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.02 * peri, True)

        # On cherche un quadrilatère (4 côtés)
        if len(approx) == 4 and area > best_area:
            best_quad = approx
            best_area = area

    if best_quad is None:
        return None

    # ── 4. Réajustement dans l'espace global ─────────────────────
    # Les coordonnées du contour sont relatives au ROI → on remet dans l'image
    pts_global = best_quad.reshape(4, 2).astype(np.float32)
    pts_global[:, 0] += x1   # offset X
    pts_global[:, 1] += y1   # offset Y

    # ── 5. Tri des 4 coins : haut-gauche, haut-droit, bas-droit, bas-gauche
    pts = sort_quad_points(pts_global)
    return pts


def sort_quad_points(pts: np.ndarray) -> np.ndarray:
    """
    Trie 4 points dans l'ordre : haut-gauche, haut-droit, bas-droit, bas-gauche.
    Méthode : somme et différence des coordonnées.
    """
    s    = pts.sum(axis=1)       # x+y : min = haut-gauche, max = bas-droit
    diff = np.diff(pts, axis=1)  # y-x : min = haut-droit,  max = bas-gauche

    tl = pts[np.argmin(s)]    # haut-gauche
    br = pts[np.argmax(s)]    # bas-droit
    tr = pts[np.argmin(diff)] # haut-droit
    bl = pts[np.argmax(diff)] # bas-gauche

    return np.float32([tl, tr, br, bl])


# ─────────────────────────────────────────────────────────────────────────────
# WARP + ALPHA COMPOSITING
# ─────────────────────────────────────────────────────────────────────────────
def warp_and_composite(
    car_b64:  str,
    logo_b64: str | None,
    polygon:  list | None,
    bbox:     dict,
) -> tuple[str, str]:
    """
    Retourne (base64_jpeg, method) où method = "polygon" | "contour" | "bbox"
    """

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

    # ── 4 coins source (template plat) ───────────────────────────
    src_pts = np.float32([
        [0,     0    ],
        [tpl_w, 0    ],
        [tpl_w, tpl_h],
        [0,     tpl_h],
    ])

    # ── Détermination des 4 coins destination ────────────────────
    # Priorité 1 : polygon fourni par PlateRecognizer (mmc=true)
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

    # Priorité 2 : détection de contours OpenCV sur le ROI
    if dst_pts is None:
        try:
            contour_pts = detect_plate_corners_from_contour(car_bgr, bbox)
            if contour_pts is not None:
                dst_pts = contour_pts
                method  = "contour"
                print("[warp-plate] Méthode : contour OpenCV")
            else:
                print("[warp-plate] Contour introuvable — fallback bbox")
        except Exception as e:
            print(f"[warp-plate] Erreur contour : {e} — fallback bbox")

    # Priorité 3 : bounding box droite (fallback garanti)
    if dst_pts is None:
        xmin = bbox["xmin"]; ymin = bbox["ymin"]
        xmax = bbox["xmax"]; ymax = bbox["ymax"]
        dst_pts = np.float32([
            [xmin, ymin], [xmax, ymin],
            [xmax, ymax], [xmin, ymax],
        ])
        method = "bbox"
        print("[warp-plate] Méthode : fallback bbox")

    # ── Matrice d'homographie ────────────────────────────────────
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