"""Konstanter som speglar ui_lager.py / ui_artikelnummer.py.

Hålls här så att API:t och den mobila appen använder exakt samma listor som
skrivbordsprogrammet. Ändras något i skrivbordsprogrammet ska det ändras här också.
"""

MAIN_CATEGORIES = {
    "0": "0. MOTOR",
    "1": "1. BRÄNSLE/AVGASSYSTEM",
    "2": "2. ELSYSTEM/INDIKERINGSSYSTEM",
    "3": "3. DRIVLINA",
    "4": "4. CHASSI",
    "5": "5. BROMSSYSTEM",
    "6": "6. KAROSS",
    "7": "7. ALLMÄNNA KOMPONENTER",
    "8": "8. VÄTSKA",
    "9": "9. HJUL",
}
MAIN_LABEL_TO_KEY = {v: k for k, v in MAIN_CATEGORIES.items()}

VEHICLE_BRANDS = [
    "VOLVO",
    "SCANIA",
    "MAN",
    "MERCEDES",
    "DAF",
    "RENAULT",
    "IVECO",
    "UNIVERSAL",
]

# UNI är reserverat för riktigt universella delar och sätts bara när
# Multi-fit är ikryssat eller märket är UNIVERSAL - aldrig automatiskt.
VEHICLE_BRAND_TO_CODE = {
    "VOLVO": "VO",
    "SCANIA": "SC",
    "MAN": "MA",
    "MERCEDES": "ME",
    "DAF": "DA",
    "RENAULT": "RE",
    "IVECO": "IV",
}

CURRENCIES = ["SEK", "EUR", "PLN"]

# Kolumnnycklar/rubriker - samma som COLUMN_DEFINITIONS i ui_lager.py.
COLUMN_DEFINITIONS = [
    ("shelf_location", "Hylla", 90, "center"),
    ("subcategory", "Underkategori", 130, "w"),
    ("article_number", "Artikelnummer", 120, "w"),
    ("vehicle_brand", "Märke", 75, "w"),
    ("product_brand", "Märke Produkt", 110, "w"),
    ("org_article_no", "Org.Artikelnummer", 120, "w"),
    ("oem", "OEM", 130, "w"),
    ("barcode", "Streckkod", 120, "w"),
    ("quantity", "Antal", 60, "center"),
    ("unit_cost", "Inköpspris", 80, "e"),
    ("currency", "Valuta", 60, "center"),
    ("last_inventory_check", "Senast inventerad", 110, "center"),
]
ALL_COLUMN_KEYS = [key for key, *_ in COLUMN_DEFINITIONS]
COLUMN_BY_KEY = {key: (key, label, width, anchor) for key, label, width, anchor in COLUMN_DEFINITIONS}

# Fältetiketter i historiken - måste vara identiska med skrivbordsprogrammet
# så att historikposter ser likadana ut oavsett var ändringen gjordes.
FIELD_LABELS = {
    "product_name": "Produktnamn",
    "main_category": "Huvudkategori",
    "vehicle_brand": "Märke",
    "product_brand": "Märke Produkt",
    "barcode": "Streckkod",
    "org_article_no": "Org.Artikelnummer",
    "oem": "OEM",
    "quantity": "Antal",
    "unit_cost": "Inköpspris",
    "currency": "Valuta",
    "article_number": "Artikelnummer",
    "shelf_location": "Hylla",
    "last_inventory_check": "Senast inventerad",
}

ITEM_COLUMNS = """
    id,
    product_name,
    main_category,
    vehicle_brand,
    product_brand,
    barcode,
    org_article_no,
    oem,
    quantity,
    unit_cost,
    currency,
    article_number,
    shelf_location,
    last_inventory_check,
    created_at,
    updated_at
"""
