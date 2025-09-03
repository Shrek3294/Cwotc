import json, re, time, hashlib
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import streamlit as st
import pydeck as pdk

# ---------------- Page config ----------------
st.set_page_config(page_title="Auction Map (CWCOT)", layout="wide")
st.title("🏠 Auction.com Property Explorer")

# ---------------- Helpers ----------------
def parse_money(s):
    if s in (None, ""): return np.nan
    try: return float(re.sub(r"[^0-9.]", "", str(s)))
    except: return np.nan

def parse_float(s):
    if s in (None, ""): return np.nan
    try: return float(str(s).replace(",", "").strip())
    except: return np.nan

def clean_address(raw: str) -> str:
    if not raw: return ""
    s = str(raw)
    # Insert space before capital letters in street names
    s = re.sub(r"([a-z])([A-Z][a-z])", r"\1 \2", s)
    # Add space after street type abbreviations
    s = re.sub(r"\b(Dr|St|Ave|Rd|Ct|Ln|Pl|Blvd|Pkwy|Ter|Cir|Drive|Street|Avenue|Road|Court|Lane|Place|Boulevard|Parkway|Terrace|Circle)([A-Z])", r"\1, \2", s)
    # Split into parts by comma and clean each part
    parts = [p.strip() for p in s.split(",")]
    # Clean up any remaining CamelCase in the first part (street address)
    if parts: 
        parts[0] = re.sub(r"([a-z])([A-Z][a-z])", r"\1 \2", parts[0])
    return ", ".join(parts).replace("  ", " ").strip()

def best_address(row):
    for k in ["address", "cityStateZip"]:
        if row.get(k): return clean_address(row[k])
    return ""

def file_sig(p: Path) -> tuple[str, float]:
    b = p.read_bytes()
    return hashlib.sha1(b).hexdigest(), p.stat().st_mtime

# ---------------- Load JSON (cached by file signature) ----------------
@st.cache_data(show_spinner=False)
def load_raw_records(path_str: str, sha1: str, mtime: float):
    data = json.loads(Path(path_str).read_text(encoding="utf-8"))
    if not isinstance(data, list): raise ValueError("JSON must be a list of objects")
    return data

# ---------------- Persistent geocode cache on disk ----------------
CACHE_PATH = Path(".geocache.json")

@st.cache_resource
def load_geo_cache() -> dict[str, list[float]]:
    if CACHE_PATH.exists():
        try:
            return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}

def save_geo_cache(cache: dict):
    try:
        CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass

GEO_CACHE = load_geo_cache()

def geocode_network(addr: str, mapbox_token: str = ""):
    try:
        if mapbox_token:
            url = f"https://api.mapbox.com/geocoding/v5/mapbox.places/{requests.utils.quote(addr)}.json"
            r = requests.get(url, params={"limit": 1, "access_token": mapbox_token}, timeout=10)
            if r.ok and r.json().get("features"):
                lng, lat = r.json()["features"][0]["center"]
                return float(lat), float(lng)
        else:
            r = requests.get("https://nominatim.openstreetmap.org/search",
                             params={"format": "json", "limit": 1, "q": addr},
                             headers={"User-Agent": "cwotc-streamlit"}, timeout=15)
            if r.ok:
                j = r.json()
                if j:
                    return float(j[0]["lat"]), float(j[0]["lon"])
    except Exception:
        pass
    return None

# ---------------- Inputs / file ----------------
default_path = Path("report.json")
path_str = st.sidebar.text_input("Report file path", value=str(default_path))
path = Path(path_str)
if not path.exists():
    st.warning(f"File not found: `{path}`")
    st.stop()

sha1, mtime = file_sig(path)
raw = load_raw_records(str(path), sha1, mtime)
df = pd.DataFrame(raw)

# Normalize
for col in ["address", "cityStateZip", "url", "addendum_url", "saleWindow", "propertyType", "beds", "baths", "sqft", "price"]:
    if col not in df.columns: df[col] = ""
    df[col] = df[col].astype(str)

df["isCWCOT"] = df.get("isCWCOT", False)
df["isCWCOT"] = df["isCWCOT"].fillna(False).astype(bool)

df["address_clean"] = df.apply(best_address, axis=1)
df["price_num"] = df.get("price").apply(parse_money)
df["beds_num"]  = df.get("beds").apply(parse_float)
df["baths_num"] = df.get("baths").apply(parse_float)
df["sqft_num"]  = df.get("sqft").apply(parse_float)
df["has_addendum"] = df["addendum_url"].str.len().fillna(0).astype(int).gt(0)
df["county"] = df["address"].str.extract(r",\s*([^,]*County)\s*$", expand=False).fillna("")

# Bring through any provided coordinates
if "lat" in df.columns and "lng" in df.columns:
    df["lat"] = pd.to_numeric(df["lat"], errors="coerce")
    df["lng"] = pd.to_numeric(df["lng"], errors="coerce")
elif "latitude" in df.columns and "longitude" in df.columns:
    df["lat"] = pd.to_numeric(df["latitude"], errors="coerce")
    df["lng"] = pd.to_numeric(df["longitude"], errors="coerce")
else:
    df["lat"] = np.nan
    df["lng"] = np.nan

# ---------------- Sidebar controls ----------------
st.sidebar.subheader("Geocoding")
mapbox_token = st.sidebar.text_input("Mapbox token (optional)", value="", type="password")
if mapbox_token:
    pdk.settings.mapbox_api_key = mapbox_token

auto_geocode = st.sidebar.checkbox("Auto geocode on load (only when file changes)", value=False)
do_geocode = st.sidebar.button("Geocode missing now")

with st.sidebar.expander("Cache", expanded=False):
    st.caption(f"Geocoded addresses cached: **{len(GEO_CACHE)}** (disk: `{CACHE_PATH.name}`)")
    if st.button("Clear geocode cache"):
        GEO_CACHE.clear()
        save_geo_cache(GEO_CACHE)
        st.success("Cleared geocode cache."); st.rerun()

# Marker size (so points stay visible when zoomed out)
st.sidebar.subheader("Marker size")
marker_radius_m = st.sidebar.slider("Base radius (meters)", 50, 3000, 800, step=50)
marker_min_px   = st.sidebar.slider("Min pixel radius", 1, 10, 10)
marker_max_px   = st.sidebar.slider("Max pixel radius", 10, 50, 10)

# ---------------- Prefill coordinates from disk cache (instant, no sleep) ----------------
# Only rows that are missing lat/lng
need = df["lat"].isna() | df["lng"].isna()
if need.any():
    addrs = df.loc[need, "address_clean"]
    hits_idx = addrs[addrs.isin(GEO_CACHE.keys())].index
    if len(hits_idx):
        coords = [GEO_CACHE[a] for a in df.loc[hits_idx, "address_clean"]]
        # coords are [lat, lng]
        latlng = pd.DataFrame(coords, index=hits_idx, columns=["lat", "lng"])
        df.loc[hits_idx, ["lat", "lng"]] = latlng

# Decide if we should run network geocoding now
sig = f"{sha1}:{int(mtime)}"
prev_sig = st.session_state.get("geo_sig")
geo_done = st.session_state.get("geo_done", False)

should_geocode = do_geocode or (auto_geocode and (prev_sig != sig or not geo_done))

# ---------------- Network geocoding (only remaining missing & only when triggered) ----------------
if should_geocode:
    remaining = df["lat"].isna() | df["lng"].isna()
    todo = df[remaining].copy()
    if len(todo):
        st.info(f"Geocoding {len(todo)} record(s)… (cached hits were already filled)")
        prog = st.progress(0)
        for i, (idx, row) in enumerate(todo.iterrows(), start=1):
            addr = row["address_clean"]
            coords = geocode_network(addr, mapbox_token)
            if coords:
                df.at[idx, "lat"] = coords[0]
                df.at[idx, "lng"] = coords[1]
                GEO_CACHE[addr] = [coords[0], coords[1]]
                save_geo_cache(GEO_CACHE)
                # Sleep ONLY when we actually hit the network (no Mapbox token)
                if not mapbox_token:
                    time.sleep(0.35)
            prog.progress(i / len(todo))
        prog.empty()
    st.session_state["geo_sig"] = sig
    st.session_state["geo_done"] = True

mapped = df.dropna(subset=["lat", "lng"])
if mapped.empty:
    st.warning("No mappable rows yet. Provide lat/lng in your JSON or click 'Geocode missing now'.")
    st.stop()

# ---------------- Filters ----------------
st.sidebar.subheader("Filters")
only_cwcot = st.sidebar.checkbox("Only CWCOT", value=False)
has_add = st.sidebar.checkbox("Has addendum", value=False)
min_price = int(np.nanmin(df["price_num"])) if df["price_num"].notna().any() else 0
max_price = int(np.nanmax(df["price_num"])) if df["price_num"].notna().any() else 1_000_000
sel_price = st.sidebar.slider("Max price", min_value=min_price, max_value=max_price, value=max_price, step=1000)
search = st.sidebar.text_input("Search (city/county/zip)", value="").strip()

filtered = mapped.copy()
filtered = filtered[filtered["price_num"].fillna(np.inf) <= sel_price]
if only_cwcot: filtered = filtered[filtered["isCWCOT"]]
if has_add:    filtered = filtered[filtered["has_addendum"]]
if search:
    m = (
        filtered["address_clean"].str.contains(search, case=False, na=False) |
        filtered["cityStateZip"].str.contains(search, case=False, na=False) |
        filtered["county"].str.contains(search, case=False, na=False)
    )
    filtered = filtered[m]

st.caption(f"Showing **{len(filtered)}** of {len(mapped)} mappable records (total {len(df)}).")

# ---------------- Tabs ----------------
tab_map, tab_table, tab_stats = st.tabs(["🗺️ Map", "📄 Table", "ℹ️ Stats"])

with tab_map:
    if filtered.empty:
        st.info("No rows match filters.")
    else:
        def color_row(row):
            return [102, 227, 164, 220] if row["isCWCOT"] else [122, 162, 255, 220]
        filtered = filtered.copy()
        filtered["fill_color"] = filtered.apply(color_row, axis=1)
        filtered["price_fmt"] = filtered.get("price", "")
        filtered["addendum_html"] = np.where(
            filtered["has_addendum"],
            "<a href='{0}' target='_blank'>addendum</a>".format(filtered["addendum_url"]),
            ""
        )

        mid_lat, mid_lng = float(filtered["lat"].mean()), float(filtered["lng"].mean())

        layer = pdk.Layer(
            "ScatterplotLayer",
            data=filtered,
            get_position=["lng", "lat"],
            get_fill_color="fill_color",
            get_radius=marker_radius_m,           # meters
            radius_units="meters",
            radius_min_pixels=marker_min_px,      # visible when zoomed out
            radius_max_pixels=marker_max_px,      # cap when zoomed in
            pickable=True,
            auto_highlight=True,
        )

        tooltip = {
            "html": "<b>{address_clean}</b><br/>"
                    "<b>Price:</b> {price_fmt}<br/>"
                    "<b>Beds/Baths:</b> {beds} / {baths}<br/>"
                    "<b>Type:</b> {propertyType}<br/>"
                    "<a href='{url}' target='_blank'>Open listing ↗</a> {addendum_html}",
            "style": {"backgroundColor": "rgba(16,24,48,.95)", "color": "white"}
        }

        view_state = pdk.ViewState(latitude=mid_lat, longitude=mid_lng, zoom=6, pitch=35)
        deck = pdk.Deck(layers=[layer],
                        initial_view_state=view_state,
                        tooltip=tooltip,
                        map_style="mapbox://styles/mapbox/light-v9" if mapbox_token else None)
        st.pydeck_chart(deck, use_container_width=True)

with tab_table:
    if filtered.empty:
        st.info("No rows match filters.")
    else:
        cfg = {
            "url": st.column_config.LinkColumn("Listing", display_text="Open"),
            "addendum_url": st.column_config.LinkColumn("Addendum", display_text="PDF"),
            "price_num": st.column_config.NumberColumn("Price ($)", format="%,d"),
            "beds_num": st.column_config.NumberColumn("Beds", format="%.1f"),
            "baths_num": st.column_config.NumberColumn("Baths", format="%.1f"),
            "sqft_num": st.column_config.NumberColumn("Sqft", format="%,.0f"),
        }
        cols = ["address_clean","url","addendum_url","isCWCOT","price_num","beds_num","baths_num","sqft_num","propertyType","saleWindow","county"]
        cols = [c for c in cols if c in filtered.columns]
        st.dataframe(filtered[cols], width='stretch', hide_index=True, column_config=cfg)

        csv = filtered.to_csv(index=False).encode("utf-8")
        st.download_button("Download filtered CSV", data=csv, file_name="auction_filtered.csv", mime="text/csv")

with tab_stats:
    st.metric("Total records", len(df))
    st.metric("Total CWCOT", int(df["isCWCOT"].sum()))
    st.metric("Mappable records", len(mapped))
    st.metric("Mappable CWCOT", int(mapped["isCWCOT"].sum()))
    st.metric("With addendum", int(mapped["has_addendum"].sum()))
    
    # Show unmapped addresses
    unmapped = df[df["lat"].isna() | df["lng"].isna()]
    if not unmapped.empty:
        st.subheader("Unmapped Addresses")
        st.caption(f"{len(unmapped)} addresses could not be geocoded:")
        for _, row in unmapped.iterrows():
            raw = row["address"]
            cleaned = clean_address(raw)
            st.text(f"Raw: {raw}\nCleaned: {cleaned}\n")
