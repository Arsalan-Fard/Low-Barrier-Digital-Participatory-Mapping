import time


def utc_now_iso(timestamp=None):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(timestamp))


def sanitize_storage_name(raw, fallback):
    """`raw` reduced to letters, digits, - and _ (safe in a filename), or `fallback` if nothing is left."""
    text = str(raw or "").strip()
    cleaned = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in text).strip("._-")
    return cleaned or str(fallback)
