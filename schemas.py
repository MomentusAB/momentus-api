"""Pydantic-modeller för in- och utdata i API:t."""

from datetime import date, datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------- auth

class LoginRequest(BaseModel):
    username: str
    password: str
    device_name: Optional[str] = None


class UserOut(BaseModel):
    id: int
    username: str
    display_name: Optional[str] = None


class LoginResponse(BaseModel):
    token: str
    user: UserOut


# ---------------------------------------------------------------- meta

class SubCategory(BaseModel):
    k: str
    uu: str
    name: str


class MetaResponse(BaseModel):
    main_categories: dict            # {"0": "0. MOTOR", ...}
    vehicle_brands: list[str]
    vehicle_brand_codes: dict        # {"VOLVO": "VO", ...}
    currencies: list[str]
    sub_categories: list[SubCategory]
    column_definitions: list         # [(key, label, width, anchor)]
    field_labels: dict
    warehouses: list = []            # [{"key": "lager", "name": "Lager", "number_by": ..., "number_prefix": ...}]
    suppliers: list = []             # [{"code": "SMP", "name": "SAMPA"}]


# ---------------------------------------------------------------- artiklar

class ItemOut(BaseModel):
    id: int
    product_name: str
    main_category: Optional[str] = None
    vehicle_brand: Optional[str] = None
    product_brand: Optional[str] = None
    barcode: Optional[str] = None
    org_article_no: Optional[str] = None
    oem: Optional[str] = None
    quantity: int
    unit_cost: Optional[float] = None
    currency: Optional[str] = None
    article_number: Optional[str] = None
    shelf_location: Optional[str] = None
    last_inventory_check: Optional[date] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    # Grupperingsetiketter, samma som listan i skrivbordsprogrammet
    main_label: str = ""
    sub_label: str = ""
    subcategory: str = ""


class ItemIn(BaseModel):
    product_name: str
    main_category: str = ""
    vehicle_brand: str = ""
    product_brand: str = ""
    barcode: str = ""
    org_article_no: str = ""
    oem: str = ""
    quantity: int = 0
    unit_cost: Optional[float] = None
    currency: str = "SEK"
    article_number: str = ""
    shelf_location: str = ""
    last_inventory_check: Optional[date] = None
    # Vid uppdatering: updated_at som appen läste när den öppnade artikeln.
    # Skiljer det sig från databasen har någon annan hunnit ändra -> 409.
    expected_updated_at: Optional[datetime] = None


class SummaryOut(BaseModel):
    count: int
    total_qty: int
    value_by_currency: dict          # {"SEK": 1234.5}


class ItemListResponse(BaseModel):
    items: list[ItemOut]
    summary: SummaryOut


# ---------------------------------------------------------------- scan / saldo

class ScanRequest(BaseModel):
    barcode: str
    mode: Literal["lookup", "in", "out"] = "lookup"
    qty: int = Field(default=1, ge=1)


class AdjustRequest(BaseModel):
    delta: int                       # +5 = inleverans, -2 = uttag
    note: Optional[str] = None


class TransactionOut(BaseModel):
    id: int
    item_id: int
    barcode: Optional[str] = None
    action_type: str
    qty_change: int
    qty_before: int
    qty_after: int
    note: Optional[str] = None
    created_at: datetime
    product_name: Optional[str] = None
    article_number: Optional[str] = None


class ScanResponse(BaseModel):
    item: ItemOut
    transaction: Optional[TransactionOut] = None
    message: str


# ---------------------------------------------------------------- historik

class HistoryOut(BaseModel):
    id: int
    field_name: str
    old_value: Optional[str] = None
    new_value: Optional[str] = None
    created_at: datetime


# ---------------------------------------------------------------- artikelnummer

class GenerateArticleNumberRequest(BaseModel):
    k: str                                   # huvudkategori "0"-"9"
    uu: str                                  # underkategori "01".."99"
    vehicle_brands: list[str] = []           # ["VOLVO", "SCANIA"] -> "SCVO"
    multifit: bool = False                   # -> "UNI"
    supplier: Optional[str] = None           # nya lagret: leverantörskod, t.ex. "SMP" (tomt = den första)
    item_id: Optional[int] = None            # koppla numret till denna artikel
    org_article_no: Optional[str] = None     # ...eller till artikeln med detta org-nummer
    overwrite: bool = False                  # tillåt att ersätta befintligt artikelnummer


class GenerateArticleNumberResponse(BaseModel):
    article_number: str
    item: Optional[ItemOut] = None


class UsedNumberOut(BaseModel):
    article_number: str
    created_at: str      # used_numbers.created_at kan vara TEXT i äldre databaser


# ---------------------------------------------------------------- dubbletter

class DuplicateGroup(BaseModel):
    value: str
    count: int
    ids: list[int]


class DuplicatesResponse(BaseModel):
    org_article_no: list[DuplicateGroup]
    article_number: list[DuplicateGroup]
    barcode: list[DuplicateGroup]


# ---------------------------------------------------------------- vyer

class SavedViewOut(BaseModel):
    name: str
    columns: list[str]


class SavedViewIn(BaseModel):
    columns: list[str]


# ---------------------------------------------------------------- export

class ExportRequest(BaseModel):
    format: Literal["xlsx", "csv", "pdf", "docx"] = "xlsx"
    title: str = "Lagerlista"
    columns: list[str] = []                  # tomt = alla kolumner
    search: Optional[str] = None
    main_category: Optional[str] = None
    vehicle_brand: Optional[str] = None
    shelf_location: Optional[str] = None
    item_ids: Optional[list[int]] = None     # exportera bara dessa
    grouped: bool = True
    landscape: bool = True
    page_break_per_main: bool = False
    include_summary: bool = True


class MessageOut(BaseModel):
    message: str
