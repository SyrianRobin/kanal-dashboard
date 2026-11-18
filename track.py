"""Kanal-Tracker (läuft automatisch auf GitHub, alle 20 Minuten).

Holt die Zahlen aller Kanäle aus config.json und speichert sie VERSCHLÜSSELT
in data/. Entschlüsseln kann nur dein persönlicher Link (der Schlüssel steht
nur im Link hinter dem #, nie im Repo). Der Bot selbst kann alte Daten nicht
lesen – er legt nur neue Schnappschüsse ab, die Website setzt alles zusammen.

    python track.py fetch   -> holt alles, speichert fetched.json (Klartext, wird NICHT hochgeladen)
    python track.py write   -> verschlüsselt fetched.json nach data/ und räumt alte Dateien auf
    python track.py         -> beides

YouTube: mit Secret YT_API_KEY über die offizielle API, sonst ohne Schlüssel
(Kanalseite + RSS). TikTok: alle Videos des Profils über yt-dlp.
"""
import base64
import gzip
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(ROOT, "config.json")
PUBKEY = os.path.join(ROOT, "pubkey.json")
DATA_DIR = os.path.join(ROOT, "data")
INDEX = os.path.join(DATA_DIR, "index.json")
FETCHED = os.path.join(ROOT, "fetched.json")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
INFO = b"kanal-dashboard v1"


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def get(url, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", "Cookie": "SOCS=CAI; CONSENT=YES+1"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            last = RuntimeError(f"HTTP {e.code}")
            if e.code in (400, 401, 403, 404):
                break
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(3 * (i + 1))
    raise last


# ---------------------------------------------------------------- YouTube
def yt_api(path, **params):
    params["key"] = os.environ["YT_API_KEY"]
    return json.loads(get("https://www.googleapis.com/youtube/v3/" + path + "?" + urllib.parse.urlencode(params)))


def iso_duration(s):
    m = re.match(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", s or "")
    d, h, mi, se = (int(x or 0) for x in m.groups()) if m else (0, 0, 0, 0)
    return d * 86400 + h * 3600 + mi * 60 + se


def youtube_api(acc):
    src = acc.get("handle") or acc.get("url") or ""
    m = re.search(r"UC[\w-]{22}", src)
    param = {"id": m.group(0)} if m else {"forHandle": "@" + re.search(r"@([\w.\-]+)", src).group(1)}
    ch = yt_api("channels", part="statistics,contentDetails", **param).get("items") or []
    if not ch:
        raise RuntimeError("Kanal nicht gefunden")
    st = ch[0]["statistics"]
    uploads = ch[0]["contentDetails"]["relatedPlaylists"]["uploads"]
    videos, token = [], ""
    for _ in range(20):
        p = {"part": "contentDetails", "playlistId": uploads, "maxResults": 50}
        if token:
            p["pageToken"] = token
        pl = yt_api("playlistItems", **p)
        ids = [i["contentDetails"]["videoId"] for i in pl.get("items", [])]
        if ids:
            for v in yt_api("videos", part="snippet,statistics,contentDetails", id=",".join(ids)).get("items", []):
                s, sn = v.get("statistics", {}), v.get("snippet", {})
                th = sn.get("thumbnails", {})
                videos.append({
                    "id": v["id"], "title": sn.get("title", ""), "published": sn.get("publishedAt", ""),
                    "thumb": (th.get("medium") or th.get("default") or {}).get("url", ""),
                    "duration": iso_duration(v.get("contentDetails", {}).get("duration")),
                    "url": f"https://www.youtube.com/watch?v={v['id']}",
                    "views": int(s.get("viewCount", 0)), "likes": int(s.get("likeCount", 0)),
                    "comments": int(s.get("commentCount", 0))})
        token = pl.get("nextPageToken")
        if not token:
            break
    comments = []
    for v in sorted((v for v in videos if v["comments"]), key=lambda v: v["published"], reverse=True)[:15]:
        try:
            ct = yt_api("commentThreads", part="snippet", videoId=v["id"], maxResults=20, order="time", textFormat="plainText")
        except Exception:  # noqa: BLE001
            continue
        for t in ct.get("items", []):
            c = t["snippet"]["topLevelComment"]["snippet"]
            comments.append({"id": t["id"], "videoId": v["id"], "videoTitle": v["title"],
                             "author": c.get("authorDisplayName", ""), "avatar": c.get("authorProfileImageUrl", ""),
                             "text": c.get("textDisplay") or c.get("textOriginal", ""), "published": c.get("publishedAt", ""),
                             "likes": int(c.get("likeCount", 0)), "replies": int(t["snippet"].get("totalReplyCount", 0))})
    comments.sort(key=lambda c: c["published"], reverse=True)
    return {"stats": {"followers": int(st.get("subscriberCount", 0)), "views": int(st.get("viewCount", 0)),
                      "videos": int(st.get("videoCount", 0)), "likes": sum(v["likes"] for v in videos),
                      "comments": sum(v["comments"] for v in videos)},
            "videos": videos, "comments": comments[:100], "complete": True}


def parse_count(txt):
    m = re.match(r"([\d.,]+)\s*([KkMm]?)", txt or "")
    if not m:
        return 0
    n = float(m.group(1).replace(",", ""))
    return int(n * {"k": 1e3, "m": 1e6}.get(m.group(2).lower(), 1))


def youtube_nokey(acc):
    """Ohne API-Schlüssel: Abos von der Kanalseite, Videos (die neuesten 15) aus dem RSS-Feed."""
    src = acc.get("handle") or acc.get("url") or ""
    cid = re.search(r"UC[\w-]{22}", src)
    page = get(acc.get("url") or ("https://www.youtube.com/" + src))
    if not cid:
        cid = re.search(r'"externalId":"(UC[\w-]{22})"', page) or re.search(r'"channelId":"(UC[\w-]{22})"', page)
    if not cid:
        raise RuntimeError("Kanal nicht gefunden")
    cid = cid.group(1) if cid.lastindex else cid.group(0)
    subs = re.search(r'"content":"([\d.,]+[KMkm]?) subscribers?"', page) or re.search(r'([\d.,]+[KMkm]?) subscribers', page)
    xml = get(f"https://www.youtube.com/feeds/videos.xml?channel_id={cid}")
    videos = []
    for e in re.findall(r"<entry>(.*?)</entry>", xml, re.S):
        vid = re.search(r"<yt:videoId>([^<]+)", e).group(1)
        f = lambda p, d="": (re.search(p, e) or [None, d])[1]  # noqa: E731
        import html  # noqa: PLC0415
        videos.append({
            "id": vid, "title": html.unescape(f(r"<media:title>([^<]*)")), "published": f(r"<published>([^<]+)"),
            "thumb": f'https://i.ytimg.com/vi/{vid}/mqdefault.jpg', "duration": 0,
            "url": f"https://www.youtube.com/watch?v={vid}" if "/shorts/" not in e else f"https://www.youtube.com/shorts/{vid}",
            "views": int(f(r'<media:statistics views="(\d+)"', "0")), "likes": int(f(r'<media:starRating count="(\d+)"', "0")),
            "comments": 0})
    if not videos and not subs:
        raise RuntimeError("YouTube hat nichts geliefert")
    stats = {}
    if subs:
        stats["followers"] = parse_count(subs.group(1))
    return {"stats": stats, "videos": videos, "complete": False, "partial": True,
            "warning": "" if subs else "Abos nicht geladen"}


def fetch_youtube(acc):
    if os.environ.get("YT_API_KEY"):
        try:
            return youtube_api(acc)
        except Exception as e:  # noqa: BLE001
            r = youtube_nokey(acc)
            r["warning"] = f"API-Fehler ({e}), ohne Schlüssel geladen"
            return r
    return youtube_nokey(acc)


# ---------------------------------------------------------------- TikTok
def tt_handle(acc):
    src = acc.get("handle") or (re.search(r"@([\w.]+)", acc.get("url") or "") or [None, ""])[1]
    return src.lstrip("@")


def tiktok_profile(handle):
    html = get(f"https://www.tiktok.com/@{handle}", tries=2)
    m = re.search(r'<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        raise RuntimeError("Profilseite blockiert")
    d = json.loads(m.group(1)).get("__DEFAULT_SCOPE__", {}).get("webapp.user-detail") or {}
    if d.get("statusCode", 0) != 0 or "userInfo" not in d:
        raise RuntimeError("Profil nicht gefunden")
    s = d["userInfo"]["stats"]
    return {"followers": int(s.get("followerCount", 0)), "likes": int(s.get("heartCount") or s.get("heart") or 0),
            "videos": int(s.get("videoCount", 0))}


def tiktok_videos(handle):
    import yt_dlp  # noqa: PLC0415
    with yt_dlp.YoutubeDL({"extract_flat": True, "quiet": True, "no_warnings": True, "skip_download": True}) as ydl:
        info = ydl.extract_info(f"https://www.tiktok.com/@{handle}", download=False)
    out = []
    for e in info.get("entries") or []:
        if not e or not e.get("id"):
            continue
        thumbs = e.get("thumbnails") or []
        cover = next((t.get("url") for t in thumbs if t.get("id") == "cover"), None) or (thumbs[0].get("url") if thumbs else "")
        ts = int(e.get("timestamp") or 0)
        desc = re.sub(r"(\s*#\S+)+\s*$", "", (e.get("description") or e.get("title") or "").strip()).strip()
        out.append({"id": str(e["id"]), "title": desc,
                    "published": datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z") if ts else "",
                    "thumb": cover, "duration": int(e.get("duration") or 0),
                    "url": f"https://www.tiktok.com/@{handle}/video/{e['id']}",
                    "views": int(e.get("view_count") or 0), "likes": int(e.get("like_count") or 0),
                    "comments": int(e.get("comment_count") or 0), "shares": int(e.get("repost_count") or 0)})
    return out


def fetch_tiktok(acc):
    handle = tt_handle(acc)
    videos, verr = None, None
    for i in range(3):
        try:
            videos = tiktok_videos(handle)
            if videos:
                break
        except Exception as e:  # noqa: BLE001
            verr = e
        time.sleep(5 * (i + 1))
    prof, perr = None, None
    try:
        prof = tiktok_profile(handle)
    except Exception as e:  # noqa: BLE001
        perr = e
    if not videos and not prof:
        raise RuntimeError(f"TikTok nicht erreichbar ({verr or perr})")
    stats = dict(prof or {})
    warn = ([f"Videoliste nicht geladen ({verr})"] if not videos else []) + ([f"Follower nicht geladen ({perr})"] if not prof else [])
    return {"stats": stats, "videos": videos or [], "complete": bool(videos), "warning": " · ".join(warn)}


def fetch_all():
    cfg = json.load(open(CONFIG, encoding="utf-8"))
    result = {"at": now_iso(), "accounts": {}}
    for a in cfg["accounts"]:
        try:
            fn = {"youtube": fetch_youtube, "tiktok": fetch_tiktok}.get(a["platform"])
            if not fn:
                continue
            r = fn(a)
            result["accounts"][a["id"]] = {"ok": True, **r}
            print(f"OK   {a['name']} ({a['platform']}): {len(r['videos'])} Videos {r['stats']} {r.get('warning', '')}")
        except Exception as e:  # noqa: BLE001
            result["accounts"][a["id"]] = {"ok": False, "error": str(e)[:300]}
            print(f"FEHL {a['name']} ({a['platform']}): {e}")
    with open(FETCHED, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)


# ---------------------------------------------------------------- Verschlüsseln + ablegen
def b64u(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def b64u_dec(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def encrypt(obj):
    """ECDH (P-256) mit deinem öffentlichen Schlüssel + AES-GCM. Nur dein Link kann es öffnen."""
    from cryptography.hazmat.primitives import hashes, serialization  # noqa: PLC0415
    from cryptography.hazmat.primitives.asymmetric import ec  # noqa: PLC0415
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: PLC0415
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF  # noqa: PLC0415
    pk = json.load(open(PUBKEY, encoding="utf-8"))
    pub = ec.EllipticCurvePublicNumbers(int.from_bytes(b64u_dec(pk["x"]), "big"),
                                        int.from_bytes(b64u_dec(pk["y"]), "big"), ec.SECP256R1()).public_key()
    eph = ec.generate_private_key(ec.SECP256R1())
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=INFO).derive(eph.exchange(ec.ECDH(), pub))
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, gzip.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()), None)
    epk = eph.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return {"v": 1, "epk": b64u(epk), "iv": b64u(iv), "ct": b64u(ct)}


def write_all():
    fetched = json.load(open(FETCHED, encoding="utf-8"))
    os.makedirs(DATA_DIR, exist_ok=True)
    name = fetched["at"][:13] + ".enc"   # ein Schnappschuss pro Stunde (spätere ersetzen frühere)
    with open(os.path.join(DATA_DIR, name), "w", encoding="utf-8") as f:
        json.dump(encrypt(fetched), f)
    idx = json.load(open(INDEX, encoding="utf-8")) if os.path.exists(INDEX) else {"files": []}
    files = [x for x in idx["files"] if x["f"] != name] + [{"f": name, "at": fetched["at"]}]
    files.sort(key=lambda x: x["at"])
    # Aufräumen: älter als 3 Tage -> nur der letzte Schnappschuss pro Tag bleibt
    cutoff = (datetime.now(timezone.utc) - timedelta(days=3)).strftime("%Y-%m-%dT%H")
    last_of_day = {}
    for x in files:
        last_of_day[x["at"][:10]] = x["f"]
    keep = [x for x in files if x["f"] in ("base.enc",) or x["at"][:13] >= cutoff or last_of_day[x["at"][:10]] == x["f"]]
    for x in files:
        if x not in keep and os.path.exists(os.path.join(DATA_DIR, x["f"])):
            os.remove(os.path.join(DATA_DIR, x["f"]))
    idx["files"] = keep
    idx["updatedAt"] = fetched["at"]
    with open(INDEX, "w", encoding="utf-8") as f:
        json.dump(idx, f, indent=0)
    print("gespeichert:", name, "·", len(keep), "Schnappschüsse")


if __name__ == "__main__":
    step = sys.argv[1] if len(sys.argv) > 1 else "all"
    if step in ("fetch", "all"):
        fetch_all()
    if step in ("write", "all"):
        write_all()
