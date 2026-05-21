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
# Renvoie : {
#   "result":    "base64 JPEG",
#   "method":    "polygon|contour|bbox",
#   "debug_roi": "base64 PNG"  (seulement si method == "bbox" — image binarisée pour diagnostic)
# }

import json
import base64
import numpy as np
import cv2
from http.server import BaseHTTPRequestHandler


# ─────────────────────────────────────────────────────────────────────────────
# TEMPLATE AUTOEASY
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
    tx = (width  - tw) // 2
    ty = (height + th) // 2
    cv2.putText(tpl, text, (tx, ty), font, font_scale,
                (255, 255, 255, 255), thickness, cv2.LINE_AA)
    return tpl


# ─────────────────────────────────────────────────────────────────────────────
# DÉTECTION DE CONTOURS — pipeline renforcé
#
# Retourne (pts_4coins, debug_stages) où :
#   pts_4coins  = np.float32[4,2] ou None
#   debug_stages = dict d'images intermédiaires base64 PNG pour diagnostic
# ─────────────────────────────────────────────────────────────────────────────
def detect_plate_corners_from_contour(
    car_bgr: np.ndarray,
    bbox: dict,
    margin: int = 15,
) -> tuple[np.ndarray | None, dict]:

    car_h, car_w = car_bgr.shape[:2]
    debug = {}

    # ── 1. Découpe ROI avec marge ────────────────────────────────
    x1 = max(0,     bbox["xmin"] - margin)
    y1 = max(0,     bbox["ymin"] - margin)
    x2 = min(car_w, bbox["xmax"] + margin)
    y2 = min(car_h, bbox["ymax"] + margin)

    roi = car_bgr[y1:y2, x1:x2]
    if roi.size == 0:
        return None, debug

    # ── 2. Grayscale ─────────────────────────────────────────────
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    debug["1_gray"] = _b64png(gray)

    # ── 3. Flou puissant — kernel 7×7 pour gommer le texte ───────
    blurred = cv2.GaussianBlur(gray, (7, 7), 0)
    debug["2_blurred"] = _b64png(blurred)

    # ── 4. Fermeture morphologique — fusionne la plaque en bloc ──
    # Kernel rectangulaire large pour combler lettres + visserie
    roi_h, roi_w = roi.shape[:2]
    kw = max(5, roi_w // 8)   # ~12% de la largeur du ROI
    kh = max(3, roi_h // 4)   # ~25% de la hauteur du ROI
    kernel  = cv2.getStructuringElement(cv2.MORPH_RECT, (kw, kh))
    closed  = cv2.morphologyEx(blurred, cv2.MORPH_CLOSE, kernel, iterations=2)
    debug["3_closed"] = _b64png(closed)

    # ── 5. Seuillage binaire Otsu ────────────────────────────────
    _, binary = cv2.threshold(closed, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    debug["4_binary"] = _b64png(binary)

    # ── 6. Dilatation finale pour souder les bords fragmentés ────
    kernel2 = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    dilated = cv2.dilate(binary, kernel2, iterations=2)
    debug["5_dilated"] = _b64png(dilated)

    # ── 7. findContours — on garde le plus grand ─────────────────
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        print("[warp-plate] findContours : aucun contour trouvé")
        return None, debug

    largest = max(contours, key=cv2.contourArea)
    area    = cv2.contourArea(largest)
    print(f"[warp-plate] Plus grand contour : {area:.0f}px²  (ROI {roi_w}×{roi_h})")

    # Sanity check : le contour doit couvrir au moins 20% du ROI
    if area < roi_w * roi_h * 0.20:
        print("[warp-plate] Contour trop petit — fallback bbox")
        return None, debug

    # ── 8. approxPolyDP — epsilon souple à 5% du périmètre ───────
    peri   = cv2.arcLength(largest, True)
    approx = cv2.approxPolyDP(largest, 0.05 * peri, True)
    print(f"[warp-plate] approxPolyDP : {len(approx)} côtés")

    # Debug : contour dessiné sur le ROI original
    roi_debug = roi.copy()
    cv2.drawContours(roi_debug, [approx], -1, (0, 255, 0), 2)
    debug["6_contour"] = _b64png(roi_debug)

    if len(approx) != 4:
        print(f"[warp-plate] Polygone à {len(approx)} côtés (attendu 4) — fallback bbox")
        return None, debug

    # ── 9. Réajustement + tri dans l'espace global ───────────────
    pts_global = approx.reshape(4, 2).astype(np.float32)
    pts_global[:, 0] += x1
    pts_global[:, 1] += y1

    pts_sorted = sort_quad_points(pts_global)
    return pts_sorted, debug


def sort_quad_points(pts: np.ndarray) -> np.ndarray:
    """Trie 4 points : haut-gauche, haut-droit, bas-droit, bas-gauche."""
    s    = pts.sum(axis=1)
    diff = np.diff(pts, axis=1)
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(diff)]
    bl = pts[np.argmax(diff)]
    return np.float32([tl, tr, br, bl])


def _b64png(img: np.ndarray) -> str:
    """Encode un ndarray OpenCV en base64 PNG."""
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        return ""
    return base64.b64encode(buf.tobytes()).decode("utf-8")


# ─────────────────────────────────────────────────────────────────────────────
# WARP + ALPHA COMPOSITING
# ─────────────────────────────────────────────────────────────────────────────
def warp_and_composite(
    car_b64:  str,
    logo_b64: str | None,
    polygon:  list | None,
    bbox:     dict,
) -> tuple[str, str, dict]:
    """Retourne (base64_jpeg, method, debug_dict)"""

    # ── Décode voiture ───────────────────────────────────────────
    car_bytes = base64.b64decode(car_b64)
    car_arr   = np.frombuffer(car_bytes, dtype=np.uint8)
    car_bgr   = cv2.imdecode(car_arr, cv2.IMREAD_COLOR)
    if car_bgr is None:
        raise ValueError("Impossible de décoder l'image voiture")
    car_h, car_w = car_bgr.shape[:2]

    # ── Template ─────────────────────────────────────────────────
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

    # ── Détermination des 4 coins destination ────────────────────
    method    = "bbox"
    dst_pts   = None
    debug_out = {}

    # Priorité 1 : polygon PlateRecognizer (mmc=true)
    if polygon and len(polygon) == 4:
        dst_pts = np.float32([
            [polygon[0]["x"], polygon[0]["y"]],
            [polygon[1]["x"], polygon[1]["y"]],
            [polygon[2]["x"], polygon[2]["y"]],
            [polygon[3]["x"], polygon[3]["y"]],
        ])
        method = "polygon"
        print("[warp-plate] Méthode : polygon PlateRecognizer")

    # Priorité 2 : détection contours OpenCV
    if dst_pts is None:
        try:
            contour_pts, debug_stages = detect_plate_corners_from_contour(car_bgr, bbox)
            if contour_pts is not None:
                dst_pts    = contour_pts
                method     = "contour"
                print("[warp-plate] Méthode : contour OpenCV")
            else:
                # Retourne les images de debug pour diagnostic
                debug_out  = debug_stages
                print("[warp-plate] Contour introuvable — fallback bbox + debug envoyé")
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
    composite = warped[:, :, :3].astype(np.float32) * alpha_3ch \
              + car_bgr.astype(np.float32)             * (1.0 - alpha_3ch)
    composite = np.clip(composite, 0, 255).astype(np.uint8)

    ok, buf = cv2.imencode(".jpg", composite, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        raise ValueError("Échec encodage JPEG")

    return base64.b64encode(buf.tobytes()).decode("utf-8"), method, debug_out


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

            result_b64, method, debug_out = warp_and_composite(
                car_b64, logo_b64, polygon, bbox
            )

            response = {"result": result_b64, "method": method}

            # Renvoie les étapes de debug uniquement si fallback bbox
            if method == "bbox" and debug_out:
                response["debug"] = debug_out

            self._json(200, response)

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