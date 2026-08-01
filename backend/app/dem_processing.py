import io

import numpy as np
import rasterio
from PIL import Image
from rasterio import Affine
from rasterio.enums import Resampling
from rasterio.merge import merge as rasterio_merge
from rasterio.transform import array_bounds, rowcol, xy
from rasterio.warp import calculate_default_transform, reproject, transform_bounds
from rasterio.warp import transform as warp_transform
from scipy.ndimage import zoom
from skimage import measure

WORK_CRS = "EPSG:32652"  # UTM 52N (meters) - covers Korea including Jeju
DISPLAY_MAX_DIM = 4000  # 음영기복/경사도 PNG 생성 시 이 크기로 다운샘플링 (5m급 제주 전체까지 안전)

SLOPE_STOPS = [0, 10, 20, 35, 60]
SLOPE_COLORS = [
    (34, 139, 34),
    (154, 205, 50),
    (255, 215, 0),
    (255, 140, 0),
    (220, 20, 60),
]

ELEVATION_STOPS = [0.0, 0.25, 0.5, 0.75, 1.0]  # 고도 범위(min~max) 내 상대 위치
ELEVATION_COLORS = [
    (34, 139, 34),
    (154, 205, 50),
    (255, 215, 0),
    (139, 69, 19),
    (255, 255, 255),
]


class Dem:
    def __init__(self, elevation: np.ndarray, transform, crs, nodata: float):
        self.nodata = nodata

        if crs == WORK_CRS:
            self.elevation = elevation
            self.transform = transform
            self.height, self.width = elevation.shape
        else:
            src_height, src_width = elevation.shape
            bounds = array_bounds(src_height, src_width, transform)
            self.transform, self.width, self.height = calculate_default_transform(
                crs, WORK_CRS, src_width, src_height, *bounds
            )
            destination = np.full((self.height, self.width), self.nodata, dtype=np.float64)
            reproject(
                source=elevation,
                destination=destination,
                src_transform=transform,
                src_crs=crs,
                dst_transform=self.transform,
                dst_crs=WORK_CRS,
                src_nodata=self.nodata,
                dst_nodata=self.nodata,
                resampling=Resampling.bilinear,
            )
            self.elevation = destination

        self.crs = WORK_CRS
        self.cellsize = abs(self.transform.a)
        west = self.transform.c
        north = self.transform.f
        east = west + self.width * self.transform.a
        south = north + self.height * self.transform.e
        self.bounds_wgs84 = transform_bounds(WORK_CRS, "EPSG:4326", west, south, east, north)
        self.valid_mask = self.elevation != self.nodata

    @classmethod
    def from_file(cls, path: str) -> "Dem":
        with rasterio.open(path) as src:
            elevation = src.read(1).astype(np.float64)
            transform = src.transform
            crs = src.crs
            nodata = src.nodata if src.nodata is not None else -9999.0
        return cls(elevation, transform, crs, nodata)

    @classmethod
    def from_files(cls, paths: list[str]) -> "Dem":
        if len(paths) == 1:
            return cls.from_file(paths[0])

        datasets = [rasterio.open(p) for p in paths]
        try:
            crs_values = {ds.crs for ds in datasets}
            if len(crs_values) > 1:
                raise ValueError(
                    "업로드한 파일들의 좌표계가 서로 다릅니다. 동일한 좌표계의 DEM 타일만 병합할 수 있습니다."
                )
            crs = datasets[0].crs
            nodata = datasets[0].nodata if datasets[0].nodata is not None else -9999.0
            mosaic, out_transform = rasterio_merge(datasets, nodata=nodata)
        finally:
            for ds in datasets:
                ds.close()

        return cls(mosaic[0].astype(np.float64), out_transform, crs, nodata)

    @property
    def min_elevation(self) -> float:
        return float(np.min(self.elevation[self.valid_mask]))

    @property
    def max_elevation(self) -> float:
        return float(np.max(self.elevation[self.valid_mask]))

    def info(self) -> dict:
        west, south, east, north = self.bounds_wgs84
        return {
            "width": self.width,
            "height": self.height,
            "cellsize_m": self.cellsize,
            "min_elevation_m": self.min_elevation,
            "max_elevation_m": self.max_elevation,
            "bounds": {"west": west, "south": south, "east": east, "north": north},
        }

    def _display_grid(self):
        """음영기복/경사도/고도 PNG 생성 전용 다운샘플 격자. 원본 self.elevation/self.valid_mask는
        그대로 두고(고도 조회·등고선·노선탐색은 각자 필요한 해상도로 별도 처리), 화면 표시용
        이미지만 DISPLAY_MAX_DIM으로 캡핑해 대용량 DEM에서도 PNG가 과도하게 커지지 않게 한다."""
        scale = min(1.0, DISPLAY_MAX_DIM / max(self.height, self.width))
        if scale >= 1.0:
            return self.elevation, self.valid_mask, self.cellsize, self.transform

        fill_value = float(np.mean(self.elevation[self.valid_mask]))
        filled = np.where(self.valid_mask, self.elevation, fill_value)
        elevation = zoom(filled, scale, order=1)
        valid = zoom(self.valid_mask.astype(np.float32), scale, order=0) > 0.5
        cellsize = self.cellsize / scale
        transform = self.transform * Affine.scale(1.0 / scale)
        return elevation, valid, cellsize, transform

    def slope_percent(self, elevation: np.ndarray | None = None, cellsize: float | None = None) -> np.ndarray:
        if elevation is None:
            elevation, cellsize = self.elevation, self.cellsize
        dzdy, dzdx = np.gradient(elevation, cellsize)
        return np.sqrt(dzdx**2 + dzdy**2) * 100.0

    def hillshade(
        self,
        elevation: np.ndarray | None = None,
        cellsize: float | None = None,
        azimuth: float = 315.0,
        altitude: float = 45.0,
    ) -> np.ndarray:
        if elevation is None:
            elevation, cellsize = self.elevation, self.cellsize
        dzdy, dzdx = np.gradient(elevation, cellsize)
        slope = np.arctan(np.sqrt(dzdx**2 + dzdy**2))
        aspect = np.arctan2(-dzdx, dzdy)

        azimuth_rad = np.radians(360.0 - azimuth + 90.0)
        altitude_rad = np.radians(altitude)

        shaded = np.sin(altitude_rad) * np.cos(slope) + np.cos(altitude_rad) * np.sin(
            slope
        ) * np.cos(azimuth_rad - aspect)
        return np.clip(shaded * 255, 0, 255).astype(np.uint8)

    def hillshade_png(self) -> bytes:
        elevation, valid, cellsize, transform = self._display_grid()
        gray = self.hillshade(elevation, cellsize)
        rgba = np.zeros((*gray.shape, 4), dtype=np.uint8)
        rgba[..., 0] = gray
        rgba[..., 1] = gray
        rgba[..., 2] = gray
        rgba[..., 3] = np.where(valid, 255, 0).astype(np.uint8)
        return _rgba_to_wgs84_png(rgba, transform, *gray.shape)

    def elevation_at(self, lon: float, lat: float) -> float | None:
        xs, ys = warp_transform("EPSG:4326", WORK_CRS, [lon], [lat])
        row, col = rowcol(self.transform, xs[0], ys[0])
        if not (0 <= row < self.height and 0 <= col < self.width):
            return None
        if not self.valid_mask[row, col]:
            return None
        return float(self.elevation[row, col])

    def contours(self, interval: float | None = None, max_dim: int = 1000) -> dict:
        scale = min(1.0, max_dim / max(self.height, self.width))
        if scale >= 1.0:
            elevation = self.elevation
            transform = self.transform
        else:
            elevation = zoom(self.elevation, scale, order=1)
            transform = self.transform * Affine.scale(1.0 / scale)

        land_elevation = elevation[elevation > 0]
        if land_elevation.size == 0:
            return {"type": "FeatureCollection", "features": []}

        if interval is None:
            interval = _nice_interval(float(land_elevation.max() - land_elevation.min()))

        start = np.ceil(land_elevation.min() / interval) * interval
        levels = np.arange(start, land_elevation.max(), interval)

        features = []
        for level in levels:
            for contour in measure.find_contours(elevation, level):
                if len(contour) < 2:
                    continue
                rows, cols = contour[:, 0], contour[:, 1]
                xs, ys = xy(transform, rows, cols)
                lons, lats = warp_transform(WORK_CRS, "EPSG:4326", list(xs), list(ys))
                features.append(
                    {
                        "type": "Feature",
                        "properties": {"elevation_m": float(level)},
                        "geometry": {
                            "type": "LineString",
                            "coordinates": [[lon, lat] for lon, lat in zip(lons, lats)],
                        },
                    }
                )

        return {"type": "FeatureCollection", "features": features}

    def elevation_png(self) -> bytes:
        elevation, valid, _, transform = self._display_grid()
        land = valid & (elevation > 0.0)

        land_elev = elevation[land]
        if land_elev.size == 0:
            rgba = np.zeros((*elevation.shape, 4), dtype=np.uint8)
            return _rgba_to_wgs84_png(rgba, transform, *elevation.shape)

        min_e = float(land_elev.min())
        max_e = float(land_elev.max())
        elev_range = max_e - min_e or 1.0
        normalized = np.clip((elevation - min_e) / elev_range, 0, 1)

        r = np.interp(normalized, ELEVATION_STOPS, [c[0] for c in ELEVATION_COLORS])
        g = np.interp(normalized, ELEVATION_STOPS, [c[1] for c in ELEVATION_COLORS])
        b = np.interp(normalized, ELEVATION_STOPS, [c[2] for c in ELEVATION_COLORS])

        rgba = np.zeros((*elevation.shape, 4), dtype=np.uint8)
        rgba[..., 0] = r.astype(np.uint8)
        rgba[..., 1] = g.astype(np.uint8)
        rgba[..., 2] = b.astype(np.uint8)
        rgba[..., 3] = np.where(land, 200, 0).astype(np.uint8)
        return _rgba_to_wgs84_png(rgba, transform, *elevation.shape)

    def slope_png(self) -> bytes:
        elevation, valid, cellsize, transform = self._display_grid()
        slope = self.slope_percent(elevation, cellsize)
        r = np.interp(slope, SLOPE_STOPS, [c[0] for c in SLOPE_COLORS])
        g = np.interp(slope, SLOPE_STOPS, [c[1] for c in SLOPE_COLORS])
        b = np.interp(slope, SLOPE_STOPS, [c[2] for c in SLOPE_COLORS])

        rgba = np.zeros((*slope.shape, 4), dtype=np.uint8)
        rgba[..., 0] = r.astype(np.uint8)
        rgba[..., 1] = g.astype(np.uint8)
        rgba[..., 2] = b.astype(np.uint8)
        rgba[..., 3] = np.where(valid, 200, 0).astype(np.uint8)
        return _rgba_to_wgs84_png(rgba, transform, *slope.shape)


def _to_png_bytes(rgba: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG")
    return buf.getvalue()


def _rgba_to_wgs84_png(rgba: np.ndarray, transform, height: int, width: int) -> bytes:
    """UTM(등거리 미터 격자)에서 만든 RGBA를 위경도(EPSG:4326) 격자로 재투영한 뒤 PNG로 인코딩한다.
    Leaflet의 imageOverlay는 이미지를 위경도 사각형에 선형으로 늘려 붙이는데, 위도에 따라 경도 1도의
    실거리가 달라지기 때문에(예: 위도 33.5도에서는 위도 1도의 약 83%) UTM 격자를 그대로 내보내면
    동서 방향으로 왜곡되어 실제 지도와 어긋난다."""
    bounds = array_bounds(height, width, transform)
    dst_transform, dst_width, dst_height = calculate_default_transform(
        WORK_CRS, "EPSG:4326", width, height, *bounds
    )
    dst_rgba = np.zeros((dst_height, dst_width, 4), dtype=np.uint8)
    for band in range(4):
        reproject(
            source=rgba[..., band],
            destination=dst_rgba[..., band],
            src_transform=transform,
            src_crs=WORK_CRS,
            dst_transform=dst_transform,
            dst_crs="EPSG:4326",
            resampling=Resampling.nearest,
        )
    return _to_png_bytes(dst_rgba)


def _nice_interval(elevation_range: float, target_lines: int = 15) -> float:
    if elevation_range <= 0:
        return 10.0
    raw = max(elevation_range / target_lines, 1.0)
    magnitude = 10 ** np.floor(np.log10(raw))
    for m in (1, 2, 5, 10):
        if magnitude * m >= raw:
            return float(magnitude * m)
    return float(magnitude * 10)
