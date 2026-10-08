"""Momentus System - API för mobilappen.

Starta lokalt:
    uvicorn main:app --host 0.0.0.0 --port 8000

Miljövariabler (.env bredvid den här filen, samma format som skrivbordsprogrammet):
    DATABASE_URL=postgresql://user:pass@host:5432/dbname
    SESSION_DAYS=30            (valfritt)
    CORS_ORIGINS=*             (valfritt, kommaseparerat)

Interaktiv dokumentation när servern kör: http://localhost:8000/docs
Mobilappen (PWA):                         http://localhost:8000/
"""

import logging
import os
from contextlib import asynccontextmanager
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

import auth
import db
import schemas
import services
from services import AppError

log = logging.getLogger("momentus_api")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


# ---------------------------------------------------------------- livscykel

@asynccontextmanager
async def lifespan(app: FastAPI):
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL saknas. Lägg den i .env bredvid main.py.")

    # Samma inställningar som db.get_connection(use_dict_row=True): autocommit
    # så att inga lås hålls mellan anrop, dict-rader för enkel JSON.
    pool = ConnectionPool(
        conninfo=url,
        min_size=1,
        max_size=int(os.environ.get("DB_POOL_SIZE", "8")),
        kwargs={"autocommit": True, "row_factory": dict_row},
        open=True,
    )
    app.state.pool = pool

    with pool.connection() as conn:
        db.ensure_schema(conn)
        auth.ensure_auth_schema(conn)
    log.info("Databas ansluten och schema kontrollerat.")

    try:
        yield
    finally:
        pool.close()


app = FastAPI(
    title="Momentus System API",
    version="1.0.0",
    description="Lager, scan, artikelnummer och export - samma databas som skrivbordsprogrammet.",
    lifespan=lifespan,
)

_origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


api = APIRouter(prefix="/api")


def get_conn(request: Request):
    with request.app.state.pool.connection() as conn:
        yield conn


def get_warehouse(
    warehouse: Optional[str] = Query(
        default=None,
        description='Vilket lager anropet gäller: "lager" (nya) eller "legacy" (gamla). Utelämnat = gamla.',
    ),
):
    key = warehouse or services.DEFAULT_WAREHOUSE
    if key not in db.WAREHOUSES:
        raise HTTPException(status_code=400, detail="Okänt lager.")
    return key


@app.exception_handler(AppError)
async def app_error_handler(_request: Request, exc: AppError):
    return JSONResponse(status_code=exc.status, content={"detail": exc.message})


@app.exception_handler(Exception)
async def unhandled_error_handler(_request: Request, exc: Exception):
    log.exception("Oväntat fel: %s", exc)
    return JSONResponse(status_code=500, content={"detail": "Ett oväntat fel inträffade på servern."})


# ---------------------------------------------------------------- hälsa

@api.get("/health", tags=["system"])
def health(conn=Depends(get_conn)):
    conn.execute("SELECT 1")
    return {"status": "ok"}


# ---------------------------------------------------------------- auth

@api.post("/auth/login", response_model=schemas.LoginResponse, tags=["auth"])
def login(body: schemas.LoginRequest, conn=Depends(get_conn)):
    try:
        return auth.login(conn, body.username, body.password, body.device_name)
    except ValueError as e:
        raise HTTPException(status_code=401, detail=str(e))


@api.post("/auth/logout", response_model=schemas.MessageOut, tags=["auth"])
def logout(request: Request, user=Depends(auth.current_user), conn=Depends(get_conn)):
    auth.logout(conn, request.state.token)
    return {"message": "Utloggad."}


@api.get("/auth/me", response_model=schemas.UserOut, tags=["auth"])
def me(user=Depends(auth.current_user)):
    return user


# ---------------------------------------------------------------- meta

@api.get("/meta", response_model=schemas.MetaResponse, tags=["meta"])
def meta(user=Depends(auth.current_user), conn=Depends(get_conn)):
    return services.get_meta(conn)


# ---------------------------------------------------------------- artiklar

@api.get("/items", response_model=schemas.ItemListResponse, tags=["items"])
def list_items(
    search: Optional[str] = None,
    main_category: Optional[str] = None,
    vehicle_brand: Optional[str] = None,
    shelf_location: Optional[str] = None,
    sort: str = "product_name",
    desc: bool = False,
    wh=Depends(get_warehouse),
    user=Depends(auth.current_user),
    conn=Depends(get_conn),
):
    items, summary = services.list_items(
        conn, search=search, main_category=main_category, vehicle_brand=vehicle_brand,
        shelf_location=shelf_location, sort=sort, descending=desc, warehouse=wh,
    )
    return {"items": items, "summary": summary}


@api.get("/items/by-barcode/{barcode}", response_model=schemas.ItemOut, tags=["items"])
def item_by_barcode(barcode: str, wh=Depends(get_warehouse), user=Depends(auth.current_user), conn=Depends(get_conn)):
    return services.find_by_barcode(conn, barcode, warehouse=wh)


@api.get("/items/{item_id}", response_model=schemas.ItemOut, tags=["items"])
def get_item(item_id: int, wh=Depends(get_warehouse), user=Depends(auth.current_user), conn=Depends(get_conn)):
    return services.get_item(conn, item_id, warehouse=wh)


@api.post("/items", response_model=schemas.ItemOut, status_code=201, tags=["items"])
def create_item(body: schemas.ItemIn, wh=Depends(get_warehouse), user=Depends(auth.current_user), conn=Depends(get_conn)):
    return services.create_item(conn, body.model_dump(), warehouse=wh)


@api.put("/items/{item_id}", response_model=schemas.ItemOut, tags=["items"])
def update_item(item_id: int, body: schemas.ItemIn, wh=Depends(get_warehouse), user=Depends(auth.current_user), conn=Depends(get_conn)):
    data = body.model_dump()
    expected = data.pop("expected_updated_at", None)
    return services.update_item(conn, item_id, data, expected_updated_at=expected, warehouse=wh)


@api.delete("/items/{item_id}", response_model=schemas.MessageOut, tags=["items"])
def delete_item(item_id: int, wh=Depends(get_warehouse), user=Depends(auth.current_user), conn=Depends(get_conn)):
    row = services.delete_item(conn, item_id, warehouse=wh)
    return {"message": f"Tog bort {row['product_name'] or ''} {row['article_number'] or ''}".strip()}


@api.post("/items/{item_id}/inventoried", response_model=schemas.ItemOut, tags=["items"])
def mark_inventoried(
    item_id: int,
    day: Optional[date] = Query(default=None, description="Dagens datum på telefonen, ÅÅÅÅ-MM-DD"),
    wh=Depends(get_warehouse),
    user=Depends(auth.current_user),
    conn=Depends(get_conn),
):
    return services.mark_inventoried(conn, item_id, day, warehouse=wh)


@api.post("/items/{item_id}/adjust", response_model=schemas.ScanResponse, tags=["scan"])
def adjust_quantity(item_id: int, body: schemas.AdjustRequest, wh=Depends(get_warehouse), user=Depends(auth.current_user), conn=Depends(get_conn)):
    item, tx = services.adjust_quantity(conn, item_id, body.delta, note=body.note or "Scan", warehouse=wh)
    sign = "+" if body.delta > 0 else ""
    return {
        "item": item,
        "transaction": tx,
        "message": f"{item['product_name']}: {sign}{body.delta} | nytt saldo: {item['quantity']}",
    }


@api.get("/items/{item_id}/history", response_model=list[schemas.HistoryOut], tags=["history"])
def item_history(item_id: int, wh=Depends(get_warehouse), user=Depends(auth.current_user), conn=Depends(get_conn)):
    return services.item_history(conn, item_id, warehouse=wh)


@api.get("/items/{item_id}/transactions", response_model=list[schemas.TransactionOut], tags=["scan"])
def item_transactions(item_id: int, limit: int = 100, wh=Depends(get_warehouse), user=Depends(auth.current_user), conn=Depends(get_conn)):
    return services.list_transactions(conn, item_id=item_id, limit=limit, warehouse=wh)


# ---------------------------------------------------------------- scan

@api.post("/scan", response_model=schemas.ScanResponse, tags=["scan"])
def scan(body: schemas.ScanRequest, wh=Depends(get_warehouse), user=Depends(auth.current_user), conn=Depends(get_conn)):
    return services.scan(conn, body.barcode, body.mode, body.qty, warehouse=wh)


@api.post("/transactions/{tx_id}/undo", response_model=schemas.ScanResponse, tags=["scan"])
def undo_transaction(tx_id: int, wh=Depends(get_warehouse), user=Depends(auth.current_user), conn=Depends(get_conn)):
    return services.undo_transaction(conn, tx_id, warehouse=wh)


@api.get("/transactions", response_model=list[schemas.TransactionOut], tags=["scan"])
def list_transactions(limit: int = 100, wh=Depends(get_warehouse), user=Depends(auth.current_user), conn=Depends(get_conn)):
    return services.list_transactions(conn, limit=limit, warehouse=wh)


# ---------------------------------------------------------------- historik

@api.delete("/history/{history_id}", response_model=schemas.MessageOut, tags=["history"])
def delete_history(history_id: int, wh=Depends(get_warehouse), user=Depends(auth.current_user), conn=Depends(get_conn)):
    services.delete_history_entry(conn, history_id, warehouse=wh)
    return {"message": "Historikposten togs bort."}


# ---------------------------------------------------------------- dubbletter

@api.get("/duplicates", response_model=schemas.DuplicatesResponse, tags=["items"])
def duplicates(wh=Depends(get_warehouse), user=Depends(auth.current_user), conn=Depends(get_conn)):
    return services.duplicates(conn, warehouse=wh)


# ---------------------------------------------------------------- artikelnummer

@api.post("/article-numbers/generate", response_model=schemas.GenerateArticleNumberResponse, tags=["article-numbers"])
def generate_article_number(body: schemas.GenerateArticleNumberRequest, wh=Depends(get_warehouse), user=Depends(auth.current_user), conn=Depends(get_conn)):
    nr, item = services.generate_article_number(
        conn, body.k, body.uu, body.vehicle_brands, body.multifit,
        item_id=body.item_id, org_article_no=body.org_article_no, overwrite=body.overwrite,
        supplier=body.supplier, warehouse=wh,
    )
    return {"article_number": nr, "item": item}


@api.get("/article-numbers", response_model=list[schemas.UsedNumberOut], tags=["article-numbers"])
def latest_article_numbers(
    search: Optional[str] = None,
    limit: int = 200,
    sort: str = "created_at",
    desc: bool = True,
    user=Depends(auth.current_user),
    conn=Depends(get_conn),
):
    return services.latest_used_numbers(conn, search=search, limit=limit, sort=sort, descending=desc)


@api.delete("/article-numbers/{article_number}", response_model=schemas.MessageOut, tags=["article-numbers"])
def delete_article_number(article_number: str, user=Depends(auth.current_user), conn=Depends(get_conn)):
    services.delete_used_number(conn, article_number)
    return {"message": f"Tog bort {article_number}."}


# ---------------------------------------------------------------- vyer

@api.get("/views", response_model=list[schemas.SavedViewOut], tags=["views"])
def views(user=Depends(auth.current_user), conn=Depends(get_conn)):
    return services.saved_views(conn)


@api.put("/views/{name}", response_model=schemas.SavedViewOut, tags=["views"])
def save_view(name: str, body: schemas.SavedViewIn, user=Depends(auth.current_user), conn=Depends(get_conn)):
    return services.save_view(conn, name, body.columns)


@api.delete("/views/{name}", response_model=schemas.MessageOut, tags=["views"])
def delete_view(name: str, user=Depends(auth.current_user), conn=Depends(get_conn)):
    services.delete_view(conn, name)
    return {"message": f"Vyn {name} togs bort."}


# ---------------------------------------------------------------- export

@api.post("/export", tags=["export"])
def export(body: schemas.ExportRequest, wh=Depends(get_warehouse), user=Depends(auth.current_user), conn=Depends(get_conn)):
    data, filename, media_type = services.build_export(conn, body.model_dump(), warehouse=wh)
    return Response(
        content=data,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ---------------------------------------------------------------- montering

app.include_router(api)

# Mobilappen (PWA) serveras från mappen web/ på samma adress som API:t.
# Registreras sist så att /api/... och /docs matchas först.
_web_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")


@app.middleware("http")
async def no_cache_for_app_files(request: Request, call_next):
    """Appens egna filer ska alltid hämtas färska så att uppdateringar syns direkt.
    Ikoner får cachas."""
    response = await call_next(request)
    path = request.url.path
    if not path.startswith("/api/") and not path.startswith("/icons/"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
    return response


if os.path.isdir(_web_dir):
    app.mount("/", StaticFiles(directory=_web_dir, html=True), name="web")
