"""Affärslogik för API:t.

Allt här är en direkt spegling av vad skrivbordsprogrammet (ui_lager.py,
ui_artikelnummer.py, ui_export.py) gör mot databasen. Samma tabeller, samma
transaktioner, samma historikposter - så att det inte spelar någon roll om en
ändring gjordes från datorn eller telefonen.

Anslutningarna som skickas in kommer från en psycopg-pool med autocommit=True
och row_factory=dict_row (se main.py), precis som db.get_connection(use_dict_row=True).
"""

import io
import os
import tempfile
from datetime import date, datetime

import psycopg
from psycopg.rows import dict_row, tuple_row

import db
import lager_export
from constants import (
    ALL_COLUMN_KEYS,
    COLUMN_BY_KEY,
    CURRENCIES,
    FIELD_LABELS,
    ITEM_COLUMNS,
    MAIN_CATEGORIES,
    VEHICLE_BRAND_TO_CODE,
    VEHICLE_BRANDS,
)


class AppError(Exception):
    """Fel som ska visas för användaren med en given HTTP-status."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------- meta

def get_meta(conn):
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute("SELECT k, uu, name FROM sub_categories ORDER BY k, uu")
        subs = [{"k": str(r["k"]), "uu": str(r["uu"]), "name": r["name"]} for r in cur.fetchall()]
    return {
        "main_categories": MAIN_CATEGORIES,
        "vehicle_brands": VEHICLE_BRANDS,
        "vehicle_brand_codes": VEHICLE_BRAND_TO_CODE,
        "currencies": CURRENCIES,
        "sub_categories": subs,
        "column_definitions": [list(c) for c in COLUMN_BY_KEY.values()],
        "field_labels": FIELD_LABELS,
    }


def load_subcategory_map(conn):
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute("SELECT k, uu, name FROM sub_categories")
        return {(str(r["k"]), str(r["uu"])): r["name"] for r in cur.fetchall()}


# ---------------------------------------------------------------- gruppering (som listan i Lager)

def parse_article_number(article_number):
    if not article_number:
        return None, None
    parts = article_number.split("-")
    if len(parts) < 4:
        return None, None
    k = parts[0].strip()
    uu = parts[1].strip()
    if not k.isdigit() or not uu.isdigit():
        return None, None
    return k, uu


def group_labels_for_row(row, subcat_map):
    """(huvudrubrik, underrubrik, underkategorinamn) - samma som ui_lager."""
    article_number = (row.get("article_number") or "").strip()
    k, uu = parse_article_number(article_number)

    if k is not None and uu is not None:
        main_label = MAIN_CATEGORIES.get(k, f"{k}. OKÄND HUVUDKATEGORI")
        code = f"{k}-{uu}"
        name = subcat_map.get((k, uu))
        sub_label = f"{code} {name}" if name else code
        return main_label, sub_label, name or ""

    fallback_main = (row.get("main_category") or "").strip()
    return "Okategoriserade", fallback_main if fallback_main else "Ingen huvudkategori", ""


def _decorate(row, subcat_map):
    item = dict(row)
    if item.get("unit_cost") is not None:
        item["unit_cost"] = float(item["unit_cost"])
    main_label, sub_label, sub_name = group_labels_for_row(item, subcat_map)
    item["main_label"] = main_label
    item["sub_label"] = sub_label
    item["subcategory"] = sub_name
    return item


def _summary(rows):
    totals = {}
    total_qty = 0
    for row in rows:
        total_qty += int(row.get("quantity") or 0)
        currency = (row.get("currency") or "").strip()
        unit_cost = row.get("unit_cost")
        quantity = row.get("quantity")
        if not currency or unit_cost is None or quantity is None:
            continue
        totals[currency] = totals.get(currency, 0.0) + float(unit_cost) * int(quantity)

    ordered = [c for c in CURRENCIES if c in totals] + [c for c in totals if c not in CURRENCIES]
    return {
        "count": len(rows),
        "total_qty": total_qty,
        "value_by_currency": {c: round(totals[c], 2) for c in ordered},
    }


# ---------------------------------------------------------------- artiklar: läsa

def _matches_search(item, search_text):
    if not search_text:
        return True
    haystack = " ".join(
        str(item.get(key) or "")
        for key in (
            "product_name", "main_category", "vehicle_brand", "product_brand",
            "barcode", "org_article_no", "oem", "article_number", "shelf_location",
        )
    ).lower()
    return search_text in haystack


SORTABLE = set(ALL_COLUMN_KEYS) | {"product_name", "main_label", "sub_label", "updated_at", "id"}


def list_items(conn, search=None, main_category=None, vehicle_brand=None,
               shelf_location=None, item_ids=None, sort="product_name", descending=False):
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(f"SELECT {ITEM_COLUMNS} FROM inventory_items")
        rows = cur.fetchall()

    subcat_map = load_subcategory_map(conn)
    items = [_decorate(r, subcat_map) for r in rows]

    search_text = (search or "").strip().lower()
    if search_text:
        items = [i for i in items if _matches_search(i, search_text)]
    if main_category:
        # Accepterar både "0" och "0. MOTOR"
        key = main_category.strip()
        label = MAIN_CATEGORIES.get(key, key)
        items = [i for i in items if i["main_label"] == label or (i.get("main_category") or "") == label]
    if vehicle_brand:
        vb = vehicle_brand.strip().upper()
        items = [i for i in items if vb in [b.strip().upper() for b in (i.get("vehicle_brand") or "").split("/")]]
    if shelf_location:
        sl = shelf_location.strip().lower()
        items = [i for i in items if (i.get("shelf_location") or "").strip().lower() == sl]
    if item_ids:
        wanted = set(item_ids)
        items = [i for i in items if i["id"] in wanted]

    sort_key = sort if sort in SORTABLE else "product_name"

    def sort_value(i):
        v = i.get(sort_key)
        if v is None:
            return (1, "")
        if isinstance(v, (int, float)):
            return (0, v)
        if isinstance(v, (date, datetime)):
            return (0, v.isoformat())
        return (0, str(v).lower())

    items.sort(key=sort_value, reverse=descending)
    return items, _summary(items)


def get_item(conn, item_id: int):
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(f"SELECT {ITEM_COLUMNS} FROM inventory_items WHERE id = %s", (item_id,))
        row = cur.fetchone()
    if not row:
        raise AppError("Artikeln kunde inte hittas.", 404)
    return _decorate(row, load_subcategory_map(conn))


def find_by_barcode(conn, barcode: str):
    barcode = (barcode or "").strip()
    if not barcode:
        raise AppError("Streckkod saknas.")
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            f"""
            SELECT {ITEM_COLUMNS}
            FROM inventory_items
            WHERE UPPER(TRIM(barcode)) = UPPER(%s)
            """,
            (barcode,),
        )
        matches = cur.fetchall()
    if not matches:
        raise AppError(f"Ingen artikel hittades för streckkod: {barcode}", 404)
    if len(matches) > 1:
        raise AppError(f"Flera artiklar har streckkod {barcode}. Rätta dublett i databasen.", 409)
    return _decorate(matches[0], load_subcategory_map(conn))


# ---------------------------------------------------------------- artiklar: skriva

def _clean_item_input(data: dict):
    product_name = (data.get("product_name") or "").strip()
    if not product_name:
        raise AppError("Produktnamn måste fyllas i.")

    currency = (data.get("currency") or "").strip()
    if currency not in CURRENCIES:
        raise AppError("Ogiltig valuta.")

    main_category = (data.get("main_category") or "").strip()
    if main_category and main_category not in MAIN_CATEGORIES.values():
        # Tillåt att appen skickar nyckeln "0" i stället för hela etiketten.
        if main_category in MAIN_CATEGORIES:
            main_category = MAIN_CATEGORIES[main_category]
        else:
            raise AppError("Ogiltig huvudkategori.")

    try:
        quantity = int(data.get("quantity") or 0)
    except (TypeError, ValueError):
        raise AppError("Antal måste vara ett heltal.")

    unit_cost = data.get("unit_cost")
    if unit_cost in ("", None):
        unit_cost = None
    else:
        try:
            unit_cost = float(str(unit_cost).replace(",", "."))
        except ValueError:
            raise AppError("Inköpspris måste vara ett nummer.")

    lic = data.get("last_inventory_check")
    if isinstance(lic, str):
        lic = lic.strip()
        if lic:
            try:
                lic = datetime.strptime(lic, "%Y-%m-%d").date()
            except ValueError:
                raise AppError("Senast inventerad måste vara i formatet ÅÅÅÅ-MM-DD.")
        else:
            lic = None

    return {
        "product_name": product_name,
        "main_category": main_category,
        "vehicle_brand": (data.get("vehicle_brand") or "").strip(),
        "product_brand": (data.get("product_brand") or "").strip(),
        "barcode": (data.get("barcode") or "").strip().upper(),
        "org_article_no": (data.get("org_article_no") or "").strip(),
        "oem": (data.get("oem") or "").strip(),
        "quantity": quantity,
        "unit_cost": unit_cost,
        "currency": currency,
        "article_number": (data.get("article_number") or "").strip(),
        "shelf_location": (data.get("shelf_location") or "").strip(),
        "last_inventory_check": lic,
    }


def _check_org_article_no_free(conn, org_article_no, exclude_id=None):
    if not org_article_no:
        return
    with conn.cursor(row_factory=tuple_row) as cur:
        if exclude_id is None:
            cur.execute(
                "SELECT id FROM inventory_items WHERE TRIM(org_article_no) = %s",
                (org_article_no,),
            )
        else:
            cur.execute(
                "SELECT id FROM inventory_items WHERE TRIM(org_article_no) = %s AND id <> %s",
                (org_article_no, exclude_id),
            )
        if cur.fetchone():
            raise AppError("Det finns redan en artikel med detta Org.Artikelnummer.", 409)


def _history_changes(old: dict, new: dict):
    """Samma jämförelse som editorn i ui_lager - ger identiska historikposter."""
    changes = []
    for field, label in FIELD_LABELS.items():
        old_val = old.get(field)
        new_val = new.get(field)

        if field == "unit_cost":
            try:
                old_num = float(old_val) if old_val not in (None, "") else None
            except (TypeError, ValueError):
                old_num = None
            if old_num != new_val:
                old_str = "" if old_num is None else f"{old_num:.2f}"
                new_str = "" if new_val is None else f"{new_val:.2f}"
                changes.append((label, old_str, new_str))
            continue

        if field == "last_inventory_check":
            old_str = old_val.strftime("%Y-%m-%d") if isinstance(old_val, date) else (old_val or "")
            new_str = new_val.strftime("%Y-%m-%d") if isinstance(new_val, date) else (new_val or "")
        else:
            old_str = "" if old_val is None else str(old_val)
            new_str = "" if new_val is None else str(new_val)

        if old_str != new_str:
            changes.append((label, old_str, new_str))
    return changes


def create_item(conn, data: dict):
    values = _clean_item_input(data)
    _check_org_article_no_free(conn, values["org_article_no"])

    try:
        with conn.transaction():
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """
                    INSERT INTO inventory_items
                    (product_name, main_category, vehicle_brand, product_brand, barcode,
                     org_article_no, oem, quantity, unit_cost, currency, article_number,
                     shelf_location, last_inventory_check, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, CURRENT_TIMESTAMP)
                    RETURNING id
                    """,
                    (
                        values["product_name"], values["main_category"], values["vehicle_brand"],
                        values["product_brand"], values["barcode"], values["org_article_no"],
                        values["oem"], values["quantity"], values["unit_cost"], values["currency"],
                        values["article_number"], values["shelf_location"], values["last_inventory_check"],
                    ),
                )
                new_id = cur.fetchone()["id"]
            db.log_item_changes(conn, new_id, [("Artikel", "", "Skapad")])
    except psycopg.errors.UniqueViolation:
        raise AppError("Det finns redan en artikel med detta Org.Artikelnummer eller Artikelnummer.", 409)
    except psycopg.errors.CheckViolation:
        raise AppError("Ogiltig huvudkategori.")

    return get_item(conn, new_id)


def update_item(conn, item_id: int, data: dict, expected_updated_at=None):
    values = _clean_item_input(data)
    _check_org_article_no_free(conn, values["org_article_no"], exclude_id=item_id)

    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(f"SELECT {ITEM_COLUMNS} FROM inventory_items WHERE id = %s", (item_id,))
        old = cur.fetchone()
    if not old:
        raise AppError("Artikeln kunde inte hittas.", 404)

    # Om appen inte skickar expected_updated_at används det värde vi just läste
    # - då skyddar vi i alla fall mot ändringar under själva sparandet.
    lock_ts = expected_updated_at if expected_updated_at is not None else old["updated_at"]
    if lock_ts is not None and getattr(lock_ts, "tzinfo", None) is not None:
        lock_ts = lock_ts.replace(tzinfo=None)

    changes = _history_changes(old, values)

    try:
        with conn.transaction():
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE inventory_items
                    SET product_name = %s,
                        main_category = %s,
                        vehicle_brand = %s,
                        product_brand = %s,
                        barcode = %s,
                        org_article_no = %s,
                        oem = %s,
                        quantity = %s,
                        unit_cost = %s,
                        currency = %s,
                        article_number = %s,
                        shelf_location = %s,
                        last_inventory_check = %s,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = %s
                      AND updated_at IS NOT DISTINCT FROM %s::timestamp
                    """,
                    (
                        values["product_name"], values["main_category"], values["vehicle_brand"],
                        values["product_brand"], values["barcode"], values["org_article_no"],
                        values["oem"], values["quantity"], values["unit_cost"], values["currency"],
                        values["article_number"], values["shelf_location"], values["last_inventory_check"],
                        item_id, lock_ts,
                    ),
                )
                if cur.rowcount == 0:
                    raise AppError(
                        "Artikeln har ändrats eller tagits bort av någon annan sedan du öppnade den. "
                        "Ladda om artikeln och försök igen.",
                        409,
                    )
            db.log_item_changes(conn, item_id, changes)
    except psycopg.errors.UniqueViolation:
        raise AppError("Det finns redan en artikel med detta Org.Artikelnummer eller Artikelnummer.", 409)
    except psycopg.errors.CheckViolation:
        raise AppError("Ogiltig huvudkategori.")

    return get_item(conn, item_id)


def delete_item(conn, item_id: int):
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute("SELECT product_name, article_number FROM inventory_items WHERE id = %s", (item_id,))
        row = cur.fetchone()
    if not row:
        raise AppError("Artikeln kunde inte hittas.", 404)
    with conn.cursor() as cur:
        cur.execute("DELETE FROM inventory_items WHERE id = %s", (item_id,))
    return row


def mark_inventoried(conn, item_id: int, today: date = None):
    # Datumet kommer från telefonen (dagens datum där användaren står), inte
    # från databasservern - samma tanke som Idag-knappen i skrivbordsprogrammet.
    today = today or date.today()
    with conn.transaction():
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT last_inventory_check FROM inventory_items WHERE id = %s FOR UPDATE",
                (item_id,),
            )
            row = cur.fetchone()
            if not row:
                raise AppError("Artikeln kunde inte hittas.", 404)
            cur.execute(
                """
                UPDATE inventory_items
                SET last_inventory_check = %s, updated_at = CURRENT_TIMESTAMP
                WHERE id = %s
                """,
                (today, item_id),
            )
        old_value = row["last_inventory_check"]
        old_str = old_value.strftime("%Y-%m-%d") if old_value else ""
        new_str = today.strftime("%Y-%m-%d")
        if old_str != new_str:
            db.log_item_changes(conn, item_id, [("Senast inventerad", old_str, new_str)])
    return get_item(conn, item_id)


# ---------------------------------------------------------------- saldo / scan

def adjust_quantity(conn, item_id: int, delta: int, barcode: str = None, note: str = "Scan"):
    if delta == 0:
        raise AppError("Ändringen måste vara skild från noll.")
    action_type = "IN" if delta > 0 else "OUT"

    with conn.transaction():
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                f"SELECT {ITEM_COLUMNS} FROM inventory_items WHERE id = %s FOR UPDATE",
                (item_id,),
            )
            locked = cur.fetchone()
            if not locked:
                raise AppError("Artikeln kunde inte låsas för uppdatering.", 404)

            qty_before = int(locked["quantity"] or 0)
            qty_after = qty_before + delta
            if qty_after < 0:
                raise AppError(
                    f"Kan inte ta ut {abs(delta)} st. "
                    f"Nuvarande saldo för {locked['product_name']} är {qty_before}."
                )

            cur.execute(
                "UPDATE inventory_items SET quantity = %s, updated_at = CURRENT_TIMESTAMP WHERE id = %s",
                (qty_after, item_id),
            )
            cur.execute(
                """
                INSERT INTO inventory_transactions
                (item_id, barcode, action_type, qty_change, qty_before, qty_after, note)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id, item_id, barcode, action_type, qty_change, qty_before, qty_after, note,
                          created_at AT TIME ZONE current_setting('TimeZone') AS created_at
                """,
                (
                    item_id,
                    barcode if barcode is not None else (locked["barcode"] or ""),
                    action_type, delta, qty_before, qty_after, note or "Scan",
                ),
            )
            tx = cur.fetchone()

    item = get_item(conn, item_id)
    tx = dict(tx)
    tx["product_name"] = item["product_name"]
    tx["article_number"] = item.get("article_number")
    return item, tx


def scan(conn, barcode: str, mode: str, qty: int):
    item = find_by_barcode(conn, barcode)

    if mode == "lookup":
        return {
            "item": item,
            "transaction": None,
            "message": f"Hittade: {item['product_name']} | saldo: {item['quantity']}",
        }

    delta = qty if mode == "in" else -qty
    item, tx = adjust_quantity(conn, item["id"], delta, barcode=barcode.strip(), note="Scan")
    sign = "+" if delta > 0 else ""
    return {
        "item": item,
        "transaction": tx,
        "message": f"{item['product_name']}: {sign}{delta} | nytt saldo: {item['quantity']}",
    }


def undo_transaction(conn, tx_id: int):
    with conn.transaction():
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                """
                SELECT id, item_id, action_type, qty_change, qty_before, qty_after
                FROM inventory_transactions
                WHERE id = %s
                FOR UPDATE
                """,
                (tx_id,),
            )
            tx = cur.fetchone()
            if not tx:
                raise AppError("Scan-händelsen kunde inte hittas.", 404)
            if tx["action_type"] not in ("IN", "OUT"):
                raise AppError("Endast in/ut-scan kan ångras.")

            cur.execute(
                f"SELECT {ITEM_COLUMNS} FROM inventory_items WHERE id = %s FOR UPDATE",
                (tx["item_id"],),
            )
            item = cur.fetchone()
            if not item:
                raise AppError("Artikeln för scan-händelsen finns inte längre.", 404)

            current_qty = int(item["quantity"] or 0)
            if current_qty != int(tx["qty_after"]):
                raise AppError(
                    "Lagret har ändrats sedan denna scan. Ångra stoppad för att undvika fel saldo.",
                    409,
                )

            reverse_delta = -int(tx["qty_change"])
            new_qty = current_qty + reverse_delta
            if new_qty < 0:
                raise AppError("Ångra skulle ge negativt saldo.")

            cur.execute(
                "UPDATE inventory_items SET quantity = %s, updated_at = CURRENT_TIMESTAMP WHERE id = %s",
                (new_qty, tx["item_id"]),
            )
            reverse_action = "UNDO_IN" if tx["action_type"] == "IN" else "UNDO_OUT"
            cur.execute(
                """
                INSERT INTO inventory_transactions
                (item_id, barcode, action_type, qty_change, qty_before, qty_after, note)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id, item_id, barcode, action_type, qty_change, qty_before, qty_after, note,
                          created_at AT TIME ZONE current_setting('TimeZone') AS created_at
                """,
                (
                    tx["item_id"], item["barcode"] or "", reverse_action,
                    reverse_delta, current_qty, new_qty, f"Undo av tx {tx['id']}",
                ),
            )
            undo_tx = dict(cur.fetchone())

    refreshed = get_item(conn, tx["item_id"])
    undo_tx["product_name"] = refreshed["product_name"]
    undo_tx["article_number"] = refreshed.get("article_number")
    return {
        "item": refreshed,
        "transaction": undo_tx,
        "message": f"Ångrade scan för {refreshed['product_name']}. Nytt saldo: {new_qty}",
    }


def list_transactions(conn, item_id: int = None, limit: int = 100):
    limit = max(1, min(int(limit), 1000))
    sql = """
        SELECT t.id, t.item_id, t.barcode, t.action_type, t.qty_change, t.qty_before,
               t.qty_after, t.note,
               t.created_at AT TIME ZONE current_setting('TimeZone') AS created_at,
               i.product_name, i.article_number
        FROM inventory_transactions t
        LEFT JOIN inventory_items i ON i.id = t.item_id
    """
    params = []
    if item_id is not None:
        sql += " WHERE t.item_id = %s"
        params.append(item_id)
    sql += " ORDER BY t.created_at DESC, t.id DESC LIMIT %s"
    params.append(limit)
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(sql, params)
        return cur.fetchall()


# ---------------------------------------------------------------- historik

def item_history(conn, item_id: int):
    return db.get_item_history(conn, item_id)


def delete_history_entry(conn, history_id: int):
    db.delete_history_entry(conn, history_id)


# ---------------------------------------------------------------- dubbletter

def duplicates(conn):
    result = {
        "org_article_no": db.find_duplicate_values(conn, "org_article_no"),
        "article_number": db.find_duplicate_values(conn, "article_number"),
    }
    # Streckkod är inte unik i databasen, men scan-läget kräver att den är det.
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            """
            SELECT UPPER(BTRIM(barcode)) AS value, COUNT(*) AS cnt, ARRAY_AGG(id ORDER BY id) AS ids
            FROM inventory_items
            WHERE barcode IS NOT NULL AND BTRIM(barcode) <> ''
            GROUP BY UPPER(BTRIM(barcode))
            HAVING COUNT(*) > 1
            ORDER BY value
            """
        )
        result["barcode"] = [{"value": r["value"], "count": r["cnt"], "ids": r["ids"]} for r in cur.fetchall()]
    return result


# ---------------------------------------------------------------- artikelnummer

def _validate_subcategory(conn, k: str, uu: str):
    if not k.isdigit() or not (0 <= int(k) <= 9):
        raise AppError("Välj huvudkategori.")
    if not uu.isdigit():
        raise AppError("Välj underkategori.")
    uu = f"{int(uu):02d}"
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute("SELECT 1 FROM sub_categories WHERE k = %s AND uu = %s", (int(k), uu))
        if not cur.fetchone():
            raise AppError(f"Underkategori {uu} är inte giltig för vald huvudkategori.")
    return uu


def _brand_code(vehicle_brands, multifit):
    if multifit:
        return "UNI"
    selected = [b.strip().upper() for b in vehicle_brands if b and b.strip()]
    if "UNIVERSAL" in selected:
        return "UNI"
    codes = sorted({VEHICLE_BRAND_TO_CODE[b] for b in selected if b in VEHICLE_BRAND_TO_CODE})
    if not codes:
        raise AppError(
            'Fyll i "Märke" (vilka fordonsmärken den passar) innan du genererar, '
            "eller markera Multi-fit (UNI)."
        )
    return "".join(codes)


def generate_article_number(conn, k: str, uu: str, vehicle_brands, multifit: bool,
                            item_id=None, org_article_no=None, overwrite=False):
    k = (k or "").strip()
    uu = _validate_subcategory(conn, k, (uu or "").strip())
    mmm = _brand_code(vehicle_brands or [], multifit)

    # Hitta artikeln som numret ska kopplas till (om någon).
    target = None
    if item_id is not None:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("SELECT id, product_name, article_number FROM inventory_items WHERE id = %s", (item_id,))
            target = cur.fetchone()
        if not target:
            raise AppError("Artikeln kunde inte hittas.", 404)
    elif org_article_no:
        org = org_article_no.strip()
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT id, product_name, article_number FROM inventory_items WHERE TRIM(org_article_no) = %s",
                (org,),
            )
            rows = cur.fetchall()
        if not rows:
            raise AppError(f"Ingen artikel i lagret hittades med Org.Artikelnummer: {org}", 404)
        if len(rows) > 1:
            raise AppError(
                f"Flera lagerartiklar har samma Org.Artikelnummer: {org}. Rensa dubletter i lagret först.",
                409,
            )
        target = rows[0]

    if target and (target["article_number"] or "").strip() and not overwrite:
        raise AppError(
            f"Den här artikeln har redan artikelnummer: {target['article_number']}. "
            "Skicka overwrite=true för att ersätta det.",
            409,
        )

    try:
        nr = db.generate_article_number(conn, k, uu, mmm)
    except ValueError as e:
        raise AppError(str(e))

    item = None
    if target:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE inventory_items SET article_number = %s, updated_at = CURRENT_TIMESTAMP WHERE id = %s",
                (nr, target["id"]),
            )
        db.log_item_changes(
            conn, target["id"],
            [("Artikelnummer", (target["article_number"] or "").strip(), nr)],
        )
        item = get_item(conn, target["id"])

    return nr, item


def latest_used_numbers(conn, search: str = None, limit: int = 200,
                        sort: str = "created_at", descending: bool = True):
    params = []
    where_sql = ""
    if search and search.strip():
        where_sql = """
            WHERE CAST(article_number AS TEXT) ILIKE %s
               OR CAST(created_at AS TEXT) ILIKE %s
        """
        params += [f"%{search.strip()}%", f"%{search.strip()}%"]
    order_col = sort if sort in ("article_number", "created_at") else "created_at"
    order_dir = "DESC" if descending else "ASC"
    params.append(max(1, min(int(limit), 1000)))
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(
            f"""
            SELECT article_number,
                   CAST(created_at AS TEXT) AS created_at
            FROM used_numbers
            {where_sql}
            ORDER BY {order_col} {order_dir}
            LIMIT %s
            """,
            params,
        )
        return cur.fetchall()


def delete_used_number(conn, article_number: str):
    """Tar bort ett genererat nummer ur used_numbers (som skrivbordsprogrammet).
    Stoppar om numret fortfarande sitter på en lagerartikel."""
    article_number = (article_number or "").strip()
    with conn.cursor(row_factory=tuple_row) as cur:
        cur.execute("SELECT id FROM inventory_items WHERE article_number = %s", (article_number,))
        if cur.fetchone():
            raise AppError("Numret används av en lagerartikel och kan inte tas bort.", 409)
        cur.execute("DELETE FROM used_numbers WHERE article_number = %s", (article_number,))
        if cur.rowcount == 0:
            raise AppError("Numret kunde inte hittas.", 404)


# ---------------------------------------------------------------- vyer

def saved_views(conn):
    return db.load_saved_views(conn)


def save_view(conn, name: str, columns):
    name = (name or "").strip()
    if not name:
        raise AppError("Vyn måste ha ett namn.")
    cols = [c for c in columns if c in ALL_COLUMN_KEYS]
    if not cols:
        raise AppError("Vyn måste innehålla minst en giltig kolumn.")
    db.save_view(conn, name, cols)
    return {"name": name, "columns": cols}


def delete_view(conn, name: str):
    db.delete_view(conn, name)


# ---------------------------------------------------------------- export

MEDIA_TYPES = {
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "csv": "text/csv",
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}


def build_export(conn, req: dict):
    """Bygger en ExportSpec exakt som exportdialogen och skriver filen med
    lager_export.py. Returnerar (bytes, filnamn, media type)."""
    fmt = req.get("format", "xlsx")
    if fmt not in MEDIA_TYPES:
        raise AppError("Okänt filformat.")

    column_keys = [c for c in (req.get("columns") or []) if c in ALL_COLUMN_KEYS] or ALL_COLUMN_KEYS
    columns = [COLUMN_BY_KEY[k] for k in column_keys]

    items, summary = list_items(
        conn,
        search=req.get("search"),
        main_category=req.get("main_category"),
        vehicle_brand=req.get("vehicle_brand"),
        shelf_location=req.get("shelf_location"),
        item_ids=req.get("item_ids"),
    )
    # Samma ordning som listan: huvudkategori, underkategori, produktnamn.
    items.sort(key=lambda i: (i["main_label"], i["sub_label"], (i["product_name"] or "").lower()))

    rows = []
    for i in items:
        row = {"_main": i["main_label"], "_sub": i["sub_label"], "product_name": i["product_name"]}
        for key in column_keys:
            row[key] = i.get(key)
        rows.append(row)

    subtitle = []
    if req.get("search"):
        subtitle.append(f"Sökning: {req['search']}")
    if req.get("main_category"):
        subtitle.append(f"Huvudkategori: {MAIN_CATEGORIES.get(req['main_category'], req['main_category'])}")
    if req.get("vehicle_brand"):
        subtitle.append(f"Märke: {req['vehicle_brand']}")
    if req.get("shelf_location"):
        subtitle.append(f"Hylla: {req['shelf_location']}")
    if req.get("item_ids"):
        subtitle.append(f"Urval: {len(req['item_ids'])} markerade artiklar")
    if not subtitle:
        subtitle.append("Hela lagret")

    spec = lager_export.ExportSpec(
        title=req.get("title") or "Lagerlista",
        subtitle_lines=subtitle,
        columns=columns,
        rows=rows,
        grouped=bool(req.get("grouped", True)),
        landscape=bool(req.get("landscape", True)),
        page_break_per_main=bool(req.get("page_break_per_main", False)),
        summary=summary if req.get("include_summary", True) else None,
    )

    fd, path = tempfile.mkstemp(suffix=f".{fmt}")
    os.close(fd)
    try:
        try:
            lager_export.export_to_file(path, spec)
        except lager_export.MissingDependency as e:
            raise AppError(str(e), 501)
        with open(path, "rb") as f:
            data = f.read()
    finally:
        try:
            os.remove(path)
        except OSError:
            pass

    stamp = datetime.now().strftime("%Y-%m-%d_%H%M")
    filename = f"lager_{stamp}.{fmt}"
    return data, filename, MEDIA_TYPES[fmt]
