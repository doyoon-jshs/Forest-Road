import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from app.dem_processing import Dem
from app.earthwork import DEFAULT_ROAD_WIDTH_M, estimate_earthwork
from app.routing import RouteError, find_multi_route


class LatLng(BaseModel):
    lat: float
    lng: float


class RouteRequest(BaseModel):
    waypoints: list[LatLng]
    road_width_m: float = DEFAULT_ROAD_WIDTH_M
    seed: int | None = None

STORAGE_DIR = Path(__file__).resolve().parent.parent / "storage"
STORAGE_DIR.mkdir(exist_ok=True)

app = FastAPI(title="Forest Road API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_dem_cache: dict[str, Dem] = {}


def _get_dem(dem_id: str) -> Dem:
    dem = _dem_cache.get(dem_id)
    if dem is None:
        raise HTTPException(status_code=404, detail="DEM not found")
    return dem


@app.post("/api/dem/upload")
async def upload_dem(files: list[UploadFile]):
    dem_id = uuid.uuid4().hex
    paths = []
    for i, file in enumerate(files):
        dest = STORAGE_DIR / f"{dem_id}_{i}.tif"
        with dest.open("wb") as f:
            f.write(await file.read())
        paths.append(str(dest))

    try:
        dem = Dem.from_files(paths)
    except Exception as exc:
        for p in paths:
            Path(p).unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail=f"Invalid DEM file(s): {exc}") from exc

    _dem_cache[dem_id] = dem
    return {"dem_id": dem_id, **dem.info()}


@app.get("/api/dem/{dem_id}/info")
async def dem_info(dem_id: str):
    return _get_dem(dem_id).info()


@app.get("/api/dem/{dem_id}/hillshade")
async def dem_hillshade(dem_id: str):
    png = _get_dem(dem_id).hillshade_png()
    return Response(content=png, media_type="image/png")


@app.get("/api/dem/{dem_id}/slope")
async def dem_slope(dem_id: str):
    png = _get_dem(dem_id).slope_png()
    return Response(content=png, media_type="image/png")


@app.get("/api/dem/{dem_id}/elevation-heatmap")
async def dem_elevation_heatmap(dem_id: str):
    png = _get_dem(dem_id).elevation_png()
    return Response(content=png, media_type="image/png")


@app.get("/api/dem/{dem_id}/elevation")
async def dem_elevation(dem_id: str, lat: float, lng: float):
    dem = _get_dem(dem_id)
    return {"elevation_m": dem.elevation_at(lng, lat)}


@app.get("/api/dem/{dem_id}/contours")
async def dem_contours(dem_id: str, interval: float | None = None):
    dem = _get_dem(dem_id)
    return dem.contours(interval=interval)


@app.post("/api/dem/{dem_id}/route")
async def dem_route(dem_id: str, req: RouteRequest):
    dem = _get_dem(dem_id)
    if len(req.waypoints) < 2:
        raise HTTPException(status_code=400, detail="경유지를 포함해 최소 2개 지점이 필요합니다.")

    waypoints = [(wp.lng, wp.lat) for wp in req.waypoints]
    try:
        result = find_multi_route(dem, waypoints, req.seed)
    except RouteError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    result["earthwork"] = estimate_earthwork(
        dem, result["path"], result["profile"], req.road_width_m, result["crossings"]
    )
    return result
