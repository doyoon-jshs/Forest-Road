import numpy as np
from rasterio.transform import rowcol
from rasterio.warp import transform as warp_transform

from app.dem_processing import WORK_CRS

DEFAULT_ROAD_WIDTH_M = 4.0  # 임도 유효폭 근사치
CUT_SLOPE_RATIO = 1.0  # 절토 사면 기울기 (수평:수직 = 1:1)
FILL_SLOPE_RATIO = 1.5  # 성토 사면 기울기 (수평:수직 = 1.5:1)
SAMPLE_INTERVAL_M = 10.0


def estimate_earthwork(
    dem, path: list[dict], profile: list[dict], road_width_m: float = DEFAULT_ROAD_WIDTH_M
) -> dict:
    """경로의 station(=path/profile의 각 점)을 잇는 직선 구배를 설계 노면으로 보고,
    원본 해상도 DEM에서 촘촘히 재샘플링한 실제 지형고와 비교해 절/성토 단면적·물량을 추정한다.

    station 사이 간격(라우팅 격자 다운샘플링 때문에 보통 수백 m)보다 촘촘하게 지형을 다시
    읽는 이유는, 실제 도로는 station 사이를 직선으로 잇지만 지형은 그 사이에서도 오르내리기
    때문 — station에서만 비교하면 그 굴곡이 전부 누락된다."""

    if len(profile) < 2:
        return _empty_result(road_width_m)

    distances = np.array([p["distance_m"] for p in profile])
    design_elevations = np.array([p["elevation_m"] for p in profile])
    total_length = distances[-1]
    if total_length <= 0:
        return _empty_result(road_width_m)

    lats = np.array([p["lat"] for p in path])
    lons = np.array([p["lng"] for p in path])

    sample_distances = np.arange(0.0, total_length, SAMPLE_INTERVAL_M)
    if sample_distances[-1] < total_length:
        sample_distances = np.append(sample_distances, total_length)

    sample_lats = np.interp(sample_distances, distances, lats)
    sample_lons = np.interp(sample_distances, distances, lons)
    design_at_samples = np.interp(sample_distances, distances, design_elevations)
    terrain_at_samples = _sample_elevations(dem, sample_lons, sample_lats)

    diff = terrain_at_samples - design_at_samples  # 양수: 절토 필요, 음수: 성토 필요
    cut_depth = np.clip(diff, 0, None)
    fill_depth = np.clip(-diff, 0, None)

    cut_area = road_width_m * cut_depth + CUT_SLOPE_RATIO * cut_depth**2
    fill_area = road_width_m * fill_depth + FILL_SLOPE_RATIO * fill_depth**2

    seg_len = np.diff(sample_distances)
    cut_volume = float(np.sum((cut_area[:-1] + cut_area[1:]) / 2 * seg_len))
    fill_volume = float(np.sum((fill_area[:-1] + fill_area[1:]) / 2 * seg_len))

    sections = [
        {
            "distance_m": float(d),
            "terrain_elevation_m": float(t),
            "design_elevation_m": float(g),
            "cut_depth_m": float(c),
            "fill_depth_m": float(f),
        }
        for d, t, g, c, f in zip(sample_distances, terrain_at_samples, design_at_samples, cut_depth, fill_depth)
    ]

    return {
        "cut_volume_m3": cut_volume,
        "fill_volume_m3": fill_volume,
        "road_width_m": road_width_m,
        "sections": sections,
    }


def _sample_elevations(dem, lons: np.ndarray, lats: np.ndarray) -> np.ndarray:
    xs, ys = warp_transform("EPSG:4326", WORK_CRS, lons.tolist(), lats.tolist())
    rows, cols = rowcol(dem.transform, xs, ys)
    rows = np.clip(np.asarray(rows), 0, dem.height - 1)
    cols = np.clip(np.asarray(cols), 0, dem.width - 1)
    return dem.elevation[rows, cols]


def _empty_result(road_width_m: float) -> dict:
    return {"cut_volume_m3": 0.0, "fill_volume_m3": 0.0, "road_width_m": road_width_m, "sections": []}
