import json, re, time, hashlib, os
from pathlib import Path
from dotenv import load_dotenv

import numpy as np
import pandas as pd
import requests
import streamlit as st
import pydeck as pdk

# Load environment variables from .env file (local development)
load_dotenv()

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
    
    # Fix common typos
    s = s.replace("Strret", "Street")
    s = s.replace("Statio", "Station")
    
    # Handle hyphenated house numbers and units before other processing
    s = re.sub(r'(\d+)-(\d+)\s*([A-Za-z])', r'\1-\2 \3', s)  # Fix "153-16Tuskegee"
    
    # Add space after numbered routes/highways
    s = re.sub(r'(Route|Rte|Rt|Highway|Hwy|State Route|County Route|CR)\s*(\d+[A-Za-z]?)([A-Z])', r'\1 \2 \3', s)
    
    # Handle unit numbers
    s = re.sub(r'(Unit|Apt|Suite|Ste|#)\s*([0-9A-Za-z-]+)([A-Z][a-z])', r'\1 \2 \3', s)
    
    # Handle street types (expanded list)
    street_types = r'\b(Dr|St|Ave|Rd|Ct|Ln|Pl|Blvd|Pkwy|Ter|Cir|Way|Rte|Rt|Drive|Street|Avenue|Road|Court|Lane|Place|Boulevard|Parkway|Terrace|Circle|Route|Highway|Path)'
    s = re.sub(f'{street_types}([A-Z])', r'\1 \2', s)
    
    # Add space before capital letters that start new words
    s = re.sub(r'([a-z])([A-Z][a-z])', r'\1 \2', s)
    
    # Clean up any multiple spaces
    s = re.sub(r'\s+', ' ', s)
    
    # Split into parts by comma and clean each part
    parts = [p.strip() for p in s.split(",")]
    
    # For the street address part (first part)
    if parts:
        # Fix spaces around hyphens in building numbers
        parts[0] = re.sub(r'(\d+)-(\d+)', r'\1-\2', parts[0])
        # Ensure space after numbered streets
        parts[0] = re.sub(r'(\d+)(st|nd|rd|th)', r'\1\2 ', parts[0], flags=re.IGNORECASE)
    
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
            # Standard (cheapest) endpoint: mapbox.places
            url = f"https://api.mapbox.com/geocoding/v5/mapbox.places/{requests.utils.quote(addr)}.json"
            params = {
                "limit": 1,
                "access_token": mapbox_token,
                "types": "address,place,postcode",
                "country": "US",
                # NY-ish bbox: left, bottom, right, top
                "bbox": "-79.76,40.49,-71.85,45.01",
                "autocomplete": "false",
            }
            r = requests.get(url, params=params, timeout=10)
            if r.ok and r.json().get("features"):
                lng, lat = r.json()["features"][0]["center"]
                return float(lat), float(lng)
        else:
            r = requests.get(
                "https://nominatim.openstreetmap.org/search",
                params={"format": "json", "limit": 1, "q": addr, "countrycodes": "us"},
                headers={"User-Agent": "cwotc-streamlit"},
                timeout=15
            )
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

DEFAULT_TOKEN = st.secrets.get("MAPBOX_TOKEN") or os.getenv("MAPBOX_TOKEN", "")
if not DEFAULT_TOKEN:
    st.sidebar.warning("⚠️ No Mapbox token found in environment or secrets")
mapbox_token = st.sidebar.text_input("Mapbox token", value=DEFAULT_TOKEN, type="password")

# set pydeck token (for basemap). Comment the next line if you want to use OSM tiles only.
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
    remaining_mask = df["lat"].isna() | df["lng"].isna()
    todo = df.loc[remaining_mask, ["address_clean"]].dropna()
    if not todo.empty:
        # unique addresses that aren't cached yet
        uniq = todo["address_clean"].drop_duplicates()
        to_hit = [a for a in uniq if a not in GEO_CACHE]

        st.info(f"Geocoding {len(to_hit)} unique address(es)…")
        prog = st.progress(0)
        addr2coords = {}

        for i, addr in enumerate(to_hit, start=1):
            coords = geocode_network(addr, mapbox_token)
            if coords:
                GEO_CACHE[addr] = [coords[0], coords[1]]
                addr2coords[addr] = coords
                save_geo_cache(GEO_CACHE)
                # Only sleep when we actually hit OSM (no token)
                if not mapbox_token:
                    time.sleep(0.35)
            prog.progress(i / max(1, len(to_hit)))

        # fill from cache for all remaining rows (includes fresh + old cache)
        fill = todo["address_clean"].map(lambda a: GEO_CACHE.get(a))
        # expand [lat,lng] to two columns
        latlng = fill.dropna().apply(lambda x: pd.Series({"lat": x[0], "lng": x[1]}))
        df.loc[latlng.index, ["lat", "lng"]] = latlng.values

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

        # Scatter plot for property locations
        scatter_layer = pdk.Layer(
            "ScatterplotLayer",
            data=filtered,
            get_position=["lng", "lat"],
            get_fill_color="fill_color",
            get_radius=marker_radius_m,
            radius_units="meters",
            radius_min_pixels=marker_min_px,
            radius_max_pixels=marker_max_px,
            pickable=True,
            auto_highlight=True,
            # Add glow effect
            filled=True,
            opacity=0.8,
            stroked=True,
            get_line_color=[255, 255, 255],
            get_line_width=2,
        )

        # Add a heatmap layer for density visualization
        heatmap_layer = pdk.Layer(
            "HeatmapLayer",
            data=filtered,
            get_position=["lng", "lat"],
            get_weight="price_num",
            radiusPixels=50,
            opacity=0.25,
            visible=True
        )

        tooltip = {
            "html": "<div style='font-family: system-ui; padding: 10px;'>"
                   "<h3 style='margin:0 0 8px'>{address_clean}</h3>"
                   "<p style='margin:0'><b>Price:</b> {price_fmt}</p>"
                   "<p style='margin:0'><b>Beds/Baths:</b> {beds} / {baths}</p>"
                   "<p style='margin:0'><b>Type:</b> {propertyType}</p>"
                   "<div style='margin-top:8px'>"
                   "<a href='{url}' target='_blank' style='color:#4CAF50'>View listing ↗</a> "
                   "{addendum_html}</div></div>",
            "style": {
                "backgroundColor": "rgba(16,24,48,.95)",
                "color": "white",
                "borderRadius": "4px",
                "boxShadow": "0 2px 8px rgba(0,0,0,0.3)"
            }
        }

        view_state = pdk.ViewState(
            latitude=mid_lat,
            longitude=mid_lng,
            zoom=6,
            pitch=45,  # Increased pitch for better 3D effect
            bearing=0
        )

        # Choose a more detailed map style
        map_style = ("mapbox://styles/mapbox/dark-v10" if mapbox_token else None)
        
        deck = pdk.Deck(
            layers=[heatmap_layer, scatter_layer],  # Heatmap first, then scatter points on top
            initial_view_state=view_state,
            tooltip=tooltip,
            map_style=map_style,
            effects=[{"lighting": True}]  # Enable lighting effects
        )
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
