"""
Generate an Excel spreadsheet from report.json in the current folder.

Usage:
  python exel.py [input_json] [output_xlsx]

Defaults:
  input_json = ./report.json
  output_xlsx = ./cwcot-<zip>-<yyyy-mm-dd>.xlsx
"""

import json
import sys
import re
from datetime import datetime
from pathlib import Path

# Try pandas for Excel output; fall back to CSV if unavailable.
try:
    import pandas as pd  # type: ignore
    HAS_PANDAS = True
except Exception:  # pragma: no cover
    HAS_PANDAS = False


def load_rows(path: Path):
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict):
        if isinstance(data.get("items"), list):
            return data["items"]
        return [data]
    return list(data)


def to_records(rows):
    def g(d, k):
        v = d.get(k, "")
        return "" if v is None else v

    recs = []
    for r in rows:
        recs.append({
            "Scraped At": g(r, "scraped_at"),
            "Address": g(r, "address"),
            "City/State/Zip": g(r, "cityStateZip"),
            "Beds": g(r, "beds"),
            "Baths": g(r, "baths"),
            "SqFt": g(r, "sqft"),
            "Lot Acres": g(r, "lotSizeAcres"),
            "Year Built": g(r, "yearBuilt"),
            "Property Type": g(r, "propertyType"),
            "Price": g(r, "price"),
            "Est Resale Value": g(r, "estResaleValue"),
            "Sale Window": g(r, "saleWindow"),
            "Is CWCOT": g(r, "isCWCOT"),
            "CWCOT Hits": ", ".join(g(r, "cwcot_hits") or []) if isinstance(g(r, "cwcot_hits"), list) else g(r, "cwcot_hits"),
            "Filename": g(r, "filename"),
            "Addendum Source": g(r, "detection_source"),
            "Selection Reason": g(r, "selection_reason"),
            "Listing URL": g(r, "url"),
            "Addendum URL": g(r, "addendum_url"),
            "Cookie Healthy": g(r, "cookie_healthy"),
            "Cookie Hint": g(r, "cookie_hint"),
            "Error": g(r, "error"),
        })
    return recs


def write_excel_pandas(records, out_path: Path, engine: str | None = None):
    # Only include CWCOT True rows per request
    df_true = pd.DataFrame.from_records(records)
    if not df_true.empty:
        df_true = df_true[df_true["Is CWCOT"].astype(str).str.lower() == "true"].copy()

    def make_hyperlink(url, text="Open"):
        if not url:
            return ""
        url_str = str(url).replace('"', '""')
        text_str = str(text).replace('"', '""')
        return f'=HYPERLINK("{url_str}", "{text_str}")'

    if not df_true.empty:
        df_true["Listing"] = df_true["Listing URL"].map(lambda u: make_hyperlink(u, "Open listing"))
        df_true["Addendum"] = df_true["Addendum URL"].map(lambda u: make_hyperlink(u, "Open PDF"))

        # Remove less-useful columns for quick view
        drop_cols = [
            "Sale Window", "Is CWCOT", "CWCOT Hits", "Filename",
            "Addendum Source", "Selection Reason",
        ]
        df_true = df_true.drop(columns=[c for c in drop_cols if c in df_true.columns])

        # Preferred order for quick scan
        keep_order = [
            "Scraped At","Address","City/State/Zip","Beds","Baths","SqFt",
            "Lot Acres","Year Built","Property Type","Price","Est Resale Value",
            "Listing","Addendum","Listing URL","Addendum URL",
        ]
        df_true = df_true[[c for c in keep_order if c in df_true.columns] +
                          [c for c in df_true.columns if c not in keep_order]]

    if engine is None:
        writer_ctx = pd.ExcelWriter(out_path)
    else:
        writer_ctx = pd.ExcelWriter(out_path, engine=engine)
    with writer_ctx as writer:
        df_true.to_excel(writer, index=False, sheet_name="CWCOT")

        # Widths keyed by column name; fallback width if not listed
        width_by_name = {
            "Scraped At": 22,
            "Address": 34,
            "City/State/Zip": 28,
            "Beds": 6,
            "Baths": 6,
            "SqFt": 8,
            "Lot Acres": 10,
            "Year Built": 10,
            "Property Type": 20,
            "Price": 12,
            "Est Resale Value": 18,
            "Listing": 16,
            "Addendum": 16,
            "Listing URL": 50,
            "Addendum URL": 50,
        }

        def _col_letter(idx: int) -> str:
            # 0-based index to Excel column letters
            letters = ""
            idx += 1
            while idx:
                idx, rem = divmod(idx - 1, 26)
                letters = chr(65 + rem) + letters
            return letters

        try:
            ws = writer.sheets["CWCOT"]
            cols = list(df_true.columns)
            for i, name in enumerate(cols):
                width = width_by_name.get(name, 20)
                col = _col_letter(i)
                ws.set_column(f"{col}:{col}", width)
        except Exception:
            # Some engines (or missing deps) may not support set_column
            pass


def write_csv(records, out_path: Path):
    import csv
    out_csv = out_path.with_suffix('.csv')
    if records:
        with open(out_csv, 'w', newline='', encoding='utf-8') as f:
            w = csv.DictWriter(f, fieldnames=list(records[0].keys()))
            w.writeheader()
            w.writerows(records)
    print(f"Wrote CSV fallback: {out_csv}")


def _choose_engine() -> str | None:
    # Prefer xlsxwriter (fast, rich features). Fallback to openpyxl if present.
    try:
        import xlsxwriter  # noqa: F401
        return "xlsxwriter"
    except Exception:
        try:
            import openpyxl  # noqa: F401
            return "openpyxl"
        except Exception:
            return None


def _guess_zip(rows) -> str:
    # 1) Try input.json in current dir
    try:
        cfg_path = Path('input.json')
        if cfg_path.exists():
            with open(cfg_path, 'r', encoding='utf-8') as f:
                cfg = json.load(f)
            if isinstance(cfg, list):
                cfg = (cfg or [{}])[0]
            z = cfg.get('zip') or cfg.get('ZIP') or cfg.get('Zip')
            if z:
                return str(z)
    except Exception:
        pass
    # 2) Try to extract a 5-digit ZIP from any cityStateZip field
    try:
        for r in rows:
            m = re.search(r"\b(\d{5})(?:-\d{4})?\b", str(r.get('cityStateZip', '')))
            if m:
                return m.group(1)
    except Exception:
        pass
    return "unknown"


def main():
    in_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('report.json')

    rows = load_rows(in_path)
    records = to_records(rows)

    # Default output name: cwcot-<zip>-<yyyy-mm-dd>.xlsx
    if len(sys.argv) > 2:
        out_path = Path(sys.argv[2])
    else:
        zip_code = _guess_zip(rows)
        date_str = datetime.now().strftime('%Y-%m-%d')
        out_path = Path(f'cwcot-{zip_code}-{date_str}.xlsx')

    if HAS_PANDAS:
        engine = _choose_engine()
        if engine is not None:
            try:
                write_excel_pandas(records, out_path, engine=engine)
                print(f"Wrote Excel: {out_path} (engine={engine})")
                return
            except Exception as e:
                print(f"Excel write failed with {engine} ({e}); trying other engine...")
                # Try alternate engine once
                other = "openpyxl" if engine == "xlsxwriter" else "xlsxwriter"
                try:
                    __import__(other)
                    write_excel_pandas(records, out_path, engine=other)
                    print(f"Wrote Excel: {out_path} (engine={other})")
                    return
                except Exception as e2:
                    print(f"Excel write failed with {other} as well ({e2}); falling back to CSV...")
        else:
            print("Neither xlsxwriter nor openpyxl available; falling back to CSV...")

    write_csv(records, out_path)


if __name__ == '__main__':
    main()
