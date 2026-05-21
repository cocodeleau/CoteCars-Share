# api/warp-plate.py
#
# Serverless Function Python — Vercel Pro
#
# Reçoit : POST JSON {
#   "car_image":   "base64 JPEG",
#   "logo_image":  "base64 PNG transparent"  (optionnel),
#   "logo_url":    "https://..."             (optionnel, alternatif à logo_image),
#   "polygon":     [{"x":…,"y":…}, …4 pts…] (optionnel),
#   "bbox":        {"xmin":…,"ymin":…,"xmax":…,"ymax":…},
#   "img_width":   int
# }
# Renvoie : { "result": "base64 JPEG", "method": "polygon|fake3d" }

import json
import base64
import urllib.request
import numpy as np
import cv2
from http.server import BaseHTTPRequestHandler

# ── Constantes ───────────────────────────────────────────────────────────────
INSET_RATIO    = 0.02   # retrait 2% — cache proche des dimensions réelles
FEATHER_PX     = 2      # flou bords (pixels)
OVERLAY_ALPHA  = 0.96   # opacité globale du cache
SHRINK_3D      = 0.28   # déformation trapèze — légèrement réduite pour éviter l'excès
LOGO_MARGIN    = 0.10   # marge interne logo (10%) — logo plus grand et lisible

# Couleurs dégradé fond : #D9D9D9 → #F5F5F5 (gauche → droite)
BG_LEFT  = np.array([217, 217, 217], dtype=np.float32)  # BGR
BG_RIGHT = np.array([245, 245, 245], dtype=np.float32)  # BGR


# ─────────────────────────────────────────────────────────────────────────────
# TEMPLATE COMPOSITE — fond dégradé + logo centré
# Si pas de logo → texte AUTOEASY gris foncé
# Retourne BGRA (height, width, 4)
# ─────────────────────────────────────────────────────────────────────────────
def build_template(
    logo_bgra: np.ndarray | None,
    width:     int = 520,
    height:    int = 110,
) -> np.ndarray:

    tpl = np.zeros((height, width, 4), dtype=np.uint8)

    # ── Fond dégradé horizontal ───────────────────────────────────
    for x in range(width):
        t   = x / max(width - 1, 1)
        col = (BG_LEFT * (1 - t) + BG_RIGHT * t).astype(np.uint8)
        tpl[:, x, 0] = col[0]
        tpl[:, x, 1] = col[1]
        tpl[:, x, 2] = col[2]

    tpl[:, :, 3] = int(255 * OVERLAY_ALPHA)

    if logo_bgra is not None:
        # ── Zone disponible pour le logo (avec marge 15%) ─────────
        pad_x  = int(width  * LOGO_MARGIN)
        pad_y  = int(height * LOGO_MARGIN)
        avail_w = width  - 2 * pad_x
        avail_h = height - 2 * pad_y

        if avail_w > 4 and avail_h > 4:
            logo_h, logo_w = logo_bgra.shape[:2]

            # Redimensionne le logo pour tenir dans la zone disponible
            scale   = min(avail_w / logo_w, avail_h / logo_h)
            new_w   = max(1, int(logo_w * scale))
            new_h   = max(1, int(logo_h * scale))
            resized = cv2.resize(logo_bgra, (new_w, new_h), interpolation=cv2.INTER_AREA)

            # Centrage parfait dans le template
            ox = pad_x + (avail_w - new_w) // 2
            oy = pad_y + (avail_h - new_h) // 2

            # Alpha compositing logo sur le fond dégradé
            logo_alpha = resized[:, :, 3].astype(np.float32) / 255.0
            for c in range(3):
                tpl[oy:oy+new_h, ox:ox+new_w, c] = np.clip(
                    resized[:, :, c].astype(np.float32) * logo_alpha
                    + tpl[oy:oy+new_h, ox:ox+new_w, c].astype(np.float32) * (1 - logo_alpha),
                    0, 255
                ).astype(np.uint8)
            # Alpha résultant = max des deux (logo opaque sur fond opaque)
            tpl[oy:oy+new_h, ox:ox+new_w, 3] = np.clip(
                (logo_alpha + tpl[oy:oy+new_h, ox:ox+new_w, 3].astype(np.float32) / 255.0
                 * (1 - logo_alpha)) * 255,
                0, 255
            ).astype(np.uint8)

    else:
        # ── Fallback texte AUTOEASY ───────────────────────────────
        font      = cv2.FONT_HERSHEY_DUPLEX
        text      = "AUTOEASY"
        pad_x     = int(width  * LOGO_MARGIN)
        pad_y     = int(height * LOGO_MARGIN)
        max_tw    = width  - 2 * pad_x
        max_th    = height - 2 * pad_y
        scale     = 1.0
        for s in np.arange(3.0, 0.1, -0.05):
            (tw, th), _ = cv2.getTextSize(text, font, s, 2)
            if tw <= max_tw and th <= max_th:
                scale = s
                break
        thickness  = max(1, int(height / 28))
        (tw, th), _ = cv2.getTextSize(text, font, scale, thickness)
        cv2.putText(tpl, text,
                    ((width - tw) // 2, (height + th) // 2),
                    font, scale,
                    (85, 85, 85, int(255 * OVERLAY_ALPHA)),
                    thickness, cv2.LINE_AA)

    return tpl


# ─────────────────────────────────────────────────────────────────────────────
# DECODE LOGO — depuis base64 ou URL publique
# ─────────────────────────────────────────────────────────────────────────────
def decode_logo(logo_b64: str | None, logo_url: str | None) -> np.ndarray | None:
    raw = None

    if logo_b64:
        raw = base64.b64decode(logo_b64)
    elif logo_url:
        try:
            with urllib.request.urlopen(logo_url, timeout=5) as r:
                raw = r.read()
        except Exception as e:
            print(f"[warp-plate] Logo URL inaccessible : {e}")
            return None

    if raw is None:
        return None

    arr  = np.frombuffer(raw, dtype=np.uint8)
    logo = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)

    if logo is None:
        print("[warp-plate] Logo : impossible de décoder l'image")
        return None

    # Normalise en BGRA
    if logo.ndim == 2:
        logo = cv2.cvtColor(logo, cv2.COLOR_GRAY2BGRA)
    elif logo.shape[2] == 3:
        alpha = np.full((logo.shape[0], logo.shape[1], 1), 255, dtype=np.uint8)
        logo  = np.concatenate([logo, alpha], axis=2)
    else:
        logo = logo.copy()

    # Suppression du fond noir résiduel
    # Pixels très sombres (B<20, G<20, R<20) → transparents
    mask_black = (
        (logo[:, :, 0].astype(np.int32) < 20) &
        (logo[:, :, 1].astype(np.int32) < 20) &
        (logo[:, :, 2].astype(np.int32) < 20)
    )
    logo[mask_black, 3] = 0

    # Pixels presque noirs mais pas complètement (20-40) → semi-transparents
    mask_near = (
        (logo[:, :, 0].astype(np.int32) < 40) &
        (logo[:, :, 1].astype(np.int32) < 40) &
        (logo[:, :, 2].astype(np.int32) < 40) &
        (logo[:, :, 3] > 0)
    )
    # Réduction progressive : plus c'est sombre, plus c'est transparent
    darkness = np.max(logo[mask_near, :3], axis=1).astype(np.float32)
    logo[mask_near, 3] = (darkness / 40.0 * 255).astype(np.uint8)

    transparent_pct = 100 * np.sum(logo[:, :, 3] == 0) / (logo.shape[0] * logo.shape[1])
    print(f"[warp-plate] Logo chargé — {logo.shape[1]}×{logo.shape[0]}px | transparent: {transparent_pct:.0f}%")
    return logo


# ─────────────────────────────────────────────────────────────────────────────
# FEATHERING — flou gaussien sur le canal alpha uniquement
# ─────────────────────────────────────────────────────────────────────────────
def apply_feathering(warped_bgra: np.ndarray, radius: int = FEATHER_PX) -> np.ndarray:
    if radius < 1:
        return warped_bgra
    result  = warped_bgra.copy()
    alpha   = warped_bgra[:, :, 3].astype(np.float32)
    k       = radius * 2 + 1
    result[:, :, 3] = cv2.GaussianBlur(alpha, (k, k), 0).astype(np.uint8)
    return result


# ─────────────────────────────────────────────────────────────────────────────
# COMPUTE DST — inset + trapèze Fake3D
# ─────────────────────────────────────────────────────────────────────────────
def compute_dst(bbox: dict, img_width: int) -> tuple[np.ndarray, str]:
    xmin = float(bbox["xmin"]); ymin = float(bbox["ymin"])
    xmax = float(bbox["xmax"]); ymax = float(bbox["ymax"])
    bw   = xmax - xmin;         bh   = ymax - ymin

    ix = bw * INSET_RATIO
    iy = bh * INSET_RATIO
    x1 = xmin + ix; x2 = xmax - ix
    y1 = ymin + iy; y2 = ymax - iy
    h  = y2 - y1;   d  = h * SHRINK_3D

    cx  = (xmin + xmax) / 2.0
    mid = img_width / 2.0

    if cx < mid:
        dst  = np.float32([[x1,y1],[x2,y1+d],[x2,y2-d],[x1,y2]])
        side = "gauche→droit écrasé"
    else:
        dst  = np.float32([[x1,y1+d],[x2,y1],[x2,y2],[x1,y2-d]])
        side = "droite→gauche écrasé"

    print(f"[warp-plate] inset={ix:.1f}×{iy:.1f}px | d={d:.1f}px | {side}")
    return dst, side


# ─────────────────────────────────────────────────────────────────────────────
# WARP + ALPHA COMPOSITING
# ─────────────────────────────────────────────────────────────────────────────
def warp_and_composite(
    car_b64:   str,
    logo_bgra: np.ndarray | None,
    polygon:   list | None,
    bbox:      dict,
    img_width: int | None,
) -> tuple[str, str]:

    car_bytes = base64.b64decode(car_b64)
    car_arr   = np.frombuffer(car_bytes, dtype=np.uint8)
    car_bgr   = cv2.imdecode(car_arr, cv2.IMREAD_COLOR)
    if car_bgr is None:
        raise ValueError("Impossible de décoder l'image voiture")
    car_h, car_w = car_bgr.shape[:2]
    iw = img_width if img_width else car_w

    # Template composite : fond + logo (avant warp)
    template     = build_template(logo_bgra, width=520, height=110)
    tpl_h, tpl_w = template.shape[:2]

    src_pts = np.float32([
        [0,     0    ],
        [tpl_w, 0    ],
        [tpl_w, tpl_h],
        [0,     tpl_h],
    ])

    # Priorité 1 : polygon PlateRecognizer avec inset
    method  = None
    dst_pts = None

    if polygon and len(polygon) == 4:
        pts   = np.float32([[p["x"], p["y"]] for p in polygon])
        ctr   = pts.mean(axis=0)
        dst_pts = pts + (ctr - pts) * INSET_RATIO
        method  = "polygon"
        print("[warp-plate] Méthode : polygon (inset appliqué)")

    # Priorité 2 : Fake3D + inset
    if dst_pts is None:
        dst_pts, _ = compute_dst(bbox, iw)
        method = "fake3d"
        print("[warp-plate] Méthode : fake3d")

    # Homographie + warp BGRA
    H      = cv2.getPerspectiveTransform(src_pts, dst_pts)
    warped = cv2.warpPerspective(
        template, H, (car_w, car_h),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(0, 0, 0, 0),
    )
    warped = apply_feathering(warped, radius=FEATHER_PX)

    # Alpha compositing
    alpha_raw = warped[:, :, 3].astype(np.float32) / 255.0
    alpha_3ch = np.stack([alpha_raw] * 3, axis=-1)
    composite = (warped[:, :, :3].astype(np.float32) * alpha_3ch
                 + car_bgr.astype(np.float32)         * (1.0 - alpha_3ch))
    composite = np.clip(composite, 0, 255).astype(np.uint8)

    ok, buf = cv2.imencode(".jpg", composite, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        raise ValueError("Échec encodage JPEG")

    print(f"[warp-plate] OK — {len(buf)} octets | méthode: {method}")
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
            logo_b64  = payload.get("logo_image")   # base64 PNG
            logo_url  = payload.get("logo_url")      # URL publique PNG
            polygon   = payload.get("polygon")
            bbox      = payload.get("bbox")
            img_width = payload.get("img_width")

            if not car_b64 or not bbox:
                self._json(400, {"error": "car_image et bbox sont requis"})
                return

            logo_bgra = decode_logo(logo_b64, logo_url)
            result_b64, method = warp_and_composite(
                car_b64, logo_bgra, polygon, bbox, img_width
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


# ─────────────────────────────────────────────────────────────────────────────
# POINT D'ENTRÉE CLI — appelé via child_process depuis partner-photo.js
# Lit le payload JSON depuis stdin, écrit le résultat JSON sur stdout
# ─────────────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import sys
    try:
        payload    = json.loads(sys.stdin.read())
        car_b64    = payload.get("car_image")
        logo_b64   = payload.get("logo_image")
        logo_url   = payload.get("logo_url")
        polygon    = payload.get("polygon")
        bbox       = payload.get("bbox")
        img_width  = payload.get("img_width")

        if not car_b64 or not bbox:
            print(json.dumps({"error": "car_image et bbox sont requis"}))
            sys.exit(1)

        logo_bgra  = decode_logo(logo_b64, logo_url)
        result_b64, method = warp_and_composite(
            car_b64, logo_bgra, polygon, bbox, img_width
        )
        print(json.dumps({"result": result_b64, "method": method}))

    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"error": str(e)}))
        sys.exit(1)