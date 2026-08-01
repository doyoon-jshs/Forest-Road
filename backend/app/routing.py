import numpy as np
from rasterio import Affine
from rasterio.transform import rowcol, xy
from rasterio.warp import transform as warp_transform
from scipy.ndimage import map_coordinates, zoom
from skimage.graph import MCP_Geometric

from app.dem_processing import WORK_CRS

MAX_GRADE_PERCENT = 14.0  # 임도 설계기준 종단기울기(근사)
ABSOLUTE_MAX_GRADE_PERCENT = 30.0  # 이 이상은 통행 불가로 간주
MAX_ROUTING_DIM = 2000  # 값이 클수록 지형을 촘촘히 반영해 노선이 덜 각지지만 탐색 시간이 늘어남

# 유역면적(흐름누적) 백분위수 기준 - 절대 면적값 대신 현재 DEM 내 상대적 규모로 판단.
# 실제 설계에서는 합리식(Q=CIA) 등 정밀 수리계산으로 대체해야 하는 근사치.
CULVERT_PERCENTILE = 95.0
BRIDGE_PERCENTILE = 99.5
CULVERT_BASE_COST = 2.0
BRIDGE_BASE_COST = 15.0

D8_OFFSETS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
D8_DISTANCES = [np.sqrt(2), 1.0, np.sqrt(2), 1.0, 1.0, np.sqrt(2), 1.0, np.sqrt(2)]

# 곡선반경 스무딩 - 격자 탐색 결과(8방향 이동)는 각지게 나오므로, 핵심 꼭짓점만 남기고(단순화)
# 코너를 둥글리는 후처리(Chaikin)를 적용한다. 비용표면 재탐색은 하지 않는 근사치.
SIMPLIFY_EPSILON_CELLS = 1.5
CHAIKIN_ITERATIONS = 3
MIN_CURVE_RADIUS_M = 15.0  # 임도 설계기준 최소곡선반경(근사)

SEED_NOISE_RANGE = 0.15  # 시드가 주어지면 비용표면에 ±15% 랜덤 노이즈를 섞어 대안 노선을 유도


class RouteError(Exception):
    pass


def find_route(
    dem, start_lonlat: tuple[float, float], end_lonlat: tuple[float, float], seed: int | None = None
) -> dict:
    surface = _prepare_cost_surface(dem, seed)
    return _route_segment(surface, start_lonlat, end_lonlat, "시작점", "도착점")


def find_multi_route(dem, waypoints: list[tuple[float, float]], seed: int | None = None) -> dict:
    """waypoints를 순서대로 지나는 다구간 노선. 시작점/도착점 사이에 경유지를 몇 개든 넣을 수 있음.
    비용표면(경사·계곡 유역면적 등)은 전체 DEM에 대해 한 번만 계산해 각 구간에서 재사용한다.

    seed를 주면 비용표면에 그 시드로 생성한 랜덤 노이즈를 섞는다 - 하드 제약(통행 불가)은 그대로
    유지되면서, 비슷한 비용의 대안 경로 중 하나로 결과가 갈릴 수 있다. 같은 시드는 항상 같은 노선을
    준다(결정론적)."""
    if len(waypoints) < 2:
        raise RouteError("경유지를 포함해 최소 2개 지점이 필요합니다.")

    surface = _prepare_cost_surface(dem, seed)

    combined_path: list[dict] = []
    combined_profile: list[dict] = []
    crossings: list[dict] = []
    tight_curves: list[dict] = []
    max_grade = 0.0
    min_radius = None
    distance_offset = 0.0

    for i in range(len(waypoints) - 1):
        start_label = "시작점" if i == 0 else f"경유지 {i}"
        end_label = "도착점" if i == len(waypoints) - 2 else f"경유지 {i + 1}"
        segment = _route_segment(surface, waypoints[i], waypoints[i + 1], start_label, end_label)

        seg_path = segment["path"]
        seg_profile = segment["profile"]

        if i == 0:
            combined_path.extend(seg_path)
            combined_profile.extend(seg_profile)
        else:
            combined_path.extend(seg_path[1:])
            combined_profile.extend(
                {**p, "distance_m": p["distance_m"] + distance_offset} for p in seg_profile[1:]
            )

        crossings.extend(
            {
                **c,
                "start_distance_m": c["start_distance_m"] + distance_offset,
                "end_distance_m": c["end_distance_m"] + distance_offset,
            }
            for c in segment["crossings"]
        )
        tight_curves.extend(
            {**c, "distance_m": c["distance_m"] + distance_offset} for c in segment["tight_curves"]
        )
        if segment["min_curve_radius_m"] is not None:
            min_radius = (
                segment["min_curve_radius_m"]
                if min_radius is None
                else min(min_radius, segment["min_curve_radius_m"])
            )

        distance_offset += segment["length_m"]
        max_grade = max(max_grade, segment["max_grade_percent"])

    return {
        "path": combined_path,
        "profile": combined_profile,
        "length_m": distance_offset,
        "max_grade_percent": max_grade,
        "crossings": crossings,
        "min_curve_radius_m": min_radius,
        "tight_curves": tight_curves,
    }


def _apply_seed_noise(cost: np.ndarray, seed: int) -> np.ndarray:
    """하드 제약(통행 불가, cost=inf)은 그대로 두고, 나머지 셀의 비용에만 ±SEED_NOISE_RANGE
    만큼 시드 기반 랜덤 배율을 곱한다. 같은 seed는 항상 같은 노이즈 → 같은 노선(재현 가능)."""
    rng = np.random.default_rng(seed)
    noise = rng.uniform(1.0 - SEED_NOISE_RANGE, 1.0 + SEED_NOISE_RANGE, size=cost.shape)
    return np.where(np.isfinite(cost), cost * noise, cost)


def _prepare_cost_surface(dem, seed: int | None = None) -> dict:
    elevation, transform, valid = _downsampled_grid(dem, MAX_ROUTING_DIM)
    cellsize = abs(transform.a)
    land = _land_mask(elevation, valid)

    slope_percent = _slope_percent(elevation, cellsize)
    accumulation = _flow_accumulation(elevation)
    is_valley_shape = _local_concavity(elevation) > 0
    culvert_threshold, bridge_threshold = _stream_thresholds(accumulation, land)
    cost = _cost_surface(slope_percent, land, accumulation, is_valley_shape, culvert_threshold, bridge_threshold)

    if seed is not None:
        cost = _apply_seed_noise(cost, seed)

    return {
        "transform": transform,
        "elevation": elevation,
        "cost": cost,
        "accumulation": accumulation,
        "is_valley_shape": is_valley_shape,
        "culvert_threshold": culvert_threshold,
        "bridge_threshold": bridge_threshold,
    }


def _route_segment(
    surface: dict,
    start_lonlat: tuple[float, float],
    end_lonlat: tuple[float, float],
    start_label: str,
    end_label: str,
) -> dict:
    transform = surface["transform"]
    cost = surface["cost"]

    start_rc = _lonlat_to_rowcol(start_lonlat, transform)
    end_rc = _lonlat_to_rowcol(end_lonlat, transform)
    _validate_rc(start_rc, cost, start_label)
    _validate_rc(end_rc, cost, end_label)

    mcp = MCP_Geometric(cost, fully_connected=True)
    mcp.find_costs([start_rc], [end_rc])
    try:
        path = mcp.traceback(end_rc)
    except ValueError as exc:
        raise RouteError(
            f"{start_label}과 {end_label}을 잇는 경로를 찾을 수 없습니다 (경사·해역 제약 때문일 수 있음)."
        ) from exc

    rows = np.array([p[0] for p in path], dtype=np.float64)
    cols = np.array([p[1] for p in path], dtype=np.float64)
    rows, cols = _simplify_path(rows, cols, SIMPLIFY_EPSILON_CELLS)
    rows, cols = _chaikin_smooth(rows, cols, CHAIKIN_ITERATIONS)

    return _build_result(
        rows,
        cols,
        transform,
        surface["elevation"],
        surface["accumulation"],
        surface["is_valley_shape"],
        surface["culvert_threshold"],
        surface["bridge_threshold"],
    )


def _simplify_path(rows: np.ndarray, cols: np.ndarray, epsilon: float) -> tuple[np.ndarray, np.ndarray]:
    """Douglas-Peucker: 거의 일직선인 중간점을 제거해 실제 방향전환 지점만 남긴다."""
    n = len(rows)
    if n < 3:
        return rows, cols

    points = np.stack([rows, cols], axis=1)
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]

    while stack:
        i0, i1 = stack.pop()
        if i1 <= i0 + 1:
            continue
        start, end = points[i0], points[i1]
        segment = points[i0 : i1 + 1]
        line_vec = end - start
        line_len = np.hypot(*line_vec)
        if line_len == 0:
            dists = np.hypot(*(segment - start).T)
        else:
            dists = np.abs(np.cross(line_vec, segment - start)) / line_len
        local_idx = int(np.argmax(dists))
        if dists[local_idx] > epsilon:
            global_idx = i0 + local_idx
            keep[global_idx] = True
            stack.append((i0, global_idx))
            stack.append((global_idx, i1))

    return rows[keep], cols[keep]


def _chaikin_smooth(rows: np.ndarray, cols: np.ndarray, iterations: int) -> tuple[np.ndarray, np.ndarray]:
    """코너커팅 스무딩. 양 끝점은 고정하고, 각 구간을 1/4·3/4 지점 두 점으로 대체해 각진 부분을 둥글린다."""
    if len(rows) < 3:
        return rows, cols

    for _ in range(iterations):
        new_rows = [rows[0]]
        new_cols = [cols[0]]
        for i in range(len(rows) - 1):
            r0, c0 = rows[i], cols[i]
            r1, c1 = rows[i + 1], cols[i + 1]
            new_rows.append(0.75 * r0 + 0.25 * r1)
            new_cols.append(0.75 * c0 + 0.25 * c1)
            new_rows.append(0.25 * r0 + 0.75 * r1)
            new_cols.append(0.25 * c0 + 0.75 * c1)
        new_rows.append(rows[-1])
        new_cols.append(cols[-1])
        rows, cols = np.array(new_rows), np.array(new_cols)

    return rows, cols


def _curve_radii(xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    """연속한 3점의 외접원 반지름(실좌표계, m). 배열 길이는 len(xs)-2."""
    if len(xs) < 3:
        return np.array([])

    x0, y0 = xs[:-2], ys[:-2]
    x1, y1 = xs[1:-1], ys[1:-1]
    x2, y2 = xs[2:], ys[2:]

    a = np.hypot(x1 - x0, y1 - y0)
    b = np.hypot(x2 - x1, y2 - y1)
    c = np.hypot(x2 - x0, y2 - y0)
    area2 = np.abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0))  # = 2 * 삼각형 면적

    with np.errstate(divide="ignore", invalid="ignore"):
        radius = np.where(area2 > 1e-9, (a * b * c) / (2 * area2), np.inf)
    return radius


def _find_tight_curves(cum_dist: np.ndarray, radii: np.ndarray, min_radius: float) -> list[dict]:
    """설계기준 최소곡선반경 미만인 구간을 연속 구간별로 묶어서 반환."""
    tight_mask = radii < min_radius
    curves = []
    i = 0
    n = len(radii)
    while i < n:
        if tight_mask[i]:
            j = i
            worst = radii[i]
            while j < n and tight_mask[j]:
                worst = min(worst, radii[j])
                j += 1
            curves.append({"distance_m": float(cum_dist[i + 1]), "radius_m": float(worst)})
            i = j
        else:
            i += 1
    return curves


def _downsampled_grid(dem, max_dim: int):
    scale = min(1.0, max_dim / max(dem.height, dem.width))
    if scale >= 1.0:
        return dem.elevation, dem.transform, dem.valid_mask

    fill_value = float(np.mean(dem.elevation[dem.valid_mask]))
    filled = np.where(dem.valid_mask, dem.elevation, fill_value)
    elevation = zoom(filled, scale, order=1)
    valid = zoom(dem.valid_mask.astype(np.float32), scale, order=0) > 0.5
    transform = dem.transform * Affine.scale(1.0 / scale)
    return elevation, transform, valid


def _land_mask(elevation: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """바다는 통행 불가로 간주한다. Copernicus DEM 등 글로벌 DEM은 해역도 nodata가 아닌
    실제 고도값(대체로 0 부근)을 담고 있어 nodata 마스크만으로는 바다를 걸러낼 수 없다."""
    return valid & (elevation > 0.0)


def _slope_percent(elevation: np.ndarray, cellsize: float) -> np.ndarray:
    dzdy, dzdx = np.gradient(elevation, cellsize)
    return np.sqrt(dzdx**2 + dzdy**2) * 100.0


def _flow_accumulation(elevation: np.ndarray) -> np.ndarray:
    """D8 방식 흐름누적(유역면적 프록시). 각 셀의 최급강하 방향으로 물이 흐른다고 보고
    고도 내림차순으로 처리해 상류 셀 개수를 하류 셀에 누적한다."""
    height, width = elevation.shape
    padded = np.pad(elevation, 1, mode="constant", constant_values=np.inf)

    rows, cols = np.meshgrid(np.arange(height), np.arange(width), indexing="ij")
    best_slope = np.full((height, width), -np.inf)
    target = np.full((height, width), -1, dtype=np.int64)

    for (dr, dc), dist in zip(D8_OFFSETS, D8_DISTANCES):
        neighbor = padded[1 + dr : 1 + dr + height, 1 + dc : 1 + dc + width]
        slope = (elevation - neighbor) / dist
        nr, nc = rows + dr, cols + dc
        in_bounds = (nr >= 0) & (nr < height) & (nc >= 0) & (nc < width)
        candidate = np.where(in_bounds, nr * width + nc, -1)
        better = in_bounds & (slope > best_slope)
        best_slope = np.where(better, slope, best_slope)
        target = np.where(better, candidate, target)

    order = np.argsort(-elevation.ravel())
    accumulation = np.ones(height * width, dtype=np.float64)
    target_flat = target.ravel()
    for idx in order:
        t = target_flat[idx]
        if t >= 0:
            accumulation[t] += accumulation[idx]

    return accumulation.reshape(height, width)


def _local_concavity(elevation: np.ndarray) -> np.ndarray:
    """중심 셀이 상하좌우 이웃 평균보다 얼마나 낮은지(양수 = 오목 = 계곡 형태).
    D8 흐름누적은 완전히 평탄한 지형에서도 방향 결정의 tie 때문에 특정 셀에 유량이
    쏠리는 아티팩트를 만들 수 있는데, 그런 셀은 실제로는 오목하지 않다 - 이 값으로 걸러낸다."""
    return (
        np.roll(elevation, 1, axis=0)
        + np.roll(elevation, -1, axis=0)
        + np.roll(elevation, 1, axis=1)
        + np.roll(elevation, -1, axis=1)
        - 4 * elevation
    )


def _stream_thresholds(accumulation: np.ndarray, valid: np.ndarray) -> tuple[float, float]:
    land_values = accumulation[valid]
    culvert = float(np.percentile(land_values, CULVERT_PERCENTILE))
    bridge = float(np.percentile(land_values, BRIDGE_PERCENTILE))
    return culvert, bridge


def _crossing_cost(
    accumulation: np.ndarray, is_valley_shape: np.ndarray, culvert_threshold: float, bridge_threshold: float
) -> np.ndarray:
    cost = np.zeros_like(accumulation)

    culvert_mask = is_valley_shape & (accumulation >= culvert_threshold) & (accumulation < bridge_threshold)
    bridge_mask = is_valley_shape & (accumulation >= bridge_threshold)

    cost[culvert_mask] = CULVERT_BASE_COST * (accumulation[culvert_mask] / culvert_threshold)
    cost[bridge_mask] = BRIDGE_BASE_COST * (accumulation[bridge_mask] / bridge_threshold)
    return cost


def _cost_surface(
    slope_percent: np.ndarray,
    land: np.ndarray,
    accumulation: np.ndarray,
    is_valley_shape: np.ndarray,
    culvert_threshold: float,
    bridge_threshold: float,
) -> np.ndarray:
    grade_penalty = np.where(
        slope_percent <= MAX_GRADE_PERCENT,
        (slope_percent / MAX_GRADE_PERCENT) ** 2,
        1.0 + 20.0 * (slope_percent - MAX_GRADE_PERCENT),
    )
    crossing_penalty = _crossing_cost(accumulation, is_valley_shape, culvert_threshold, bridge_threshold)

    cost = 1.0 + grade_penalty + crossing_penalty
    cost[slope_percent > ABSOLUTE_MAX_GRADE_PERCENT] = np.inf
    cost[~land] = np.inf
    return cost.astype(np.float64)


def _lonlat_to_rowcol(lonlat: tuple[float, float], transform) -> tuple[int, int]:
    lon, lat = lonlat
    xs, ys = warp_transform("EPSG:4326", WORK_CRS, [lon], [lat])
    row, col = rowcol(transform, xs[0], ys[0])
    return int(row), int(col)


def _validate_rc(rc: tuple[int, int], cost: np.ndarray, label: str) -> None:
    row, col = rc
    if not (0 <= row < cost.shape[0] and 0 <= col < cost.shape[1]):
        raise RouteError(f"{label}이 DEM 범위를 벗어났습니다.")
    if not np.isfinite(cost[row, col]):
        raise RouteError(f"{label}이 통행 불가 지역(해역·급경사)입니다.")


def _summarize_crossings(
    distances: np.ndarray,
    accumulation_values: np.ndarray,
    valley_shape_values: np.ndarray,
    culvert_threshold: float,
    bridge_threshold: float,
) -> list[dict]:
    stream_mask = (accumulation_values >= culvert_threshold) & (valley_shape_values > 0.5)
    crossings = []
    i = 0
    n = len(distances)
    while i < n:
        if stream_mask[i]:
            j = i
            peak = accumulation_values[i]
            while j < n and stream_mask[j]:
                peak = max(peak, accumulation_values[j])
                j += 1
            structure = "교량" if peak >= bridge_threshold else "암거"
            crossings.append(
                {
                    "structure": structure,
                    "relative_catchment": float(peak / culvert_threshold),
                    "start_distance_m": float(distances[i]),
                    "end_distance_m": float(distances[j - 1]),
                }
            )
            i = j
        else:
            i += 1
    return crossings


def _build_result(
    rows: np.ndarray,
    cols: np.ndarray,
    transform,
    elevation: np.ndarray,
    accumulation: np.ndarray,
    is_valley_shape: np.ndarray,
    culvert_threshold: float,
    bridge_threshold: float,
) -> dict:
    xs, ys = xy(transform, rows, cols)
    xs = np.asarray(xs)
    ys = np.asarray(ys)

    lons, lats = warp_transform(WORK_CRS, "EPSG:4326", xs.tolist(), ys.tolist())

    # 스무딩 후 좌표는 격자 정수 위치가 아닐 수 있어 보간 샘플링(order=1)을 사용한다.
    coords = np.stack([rows, cols])
    elevations = map_coordinates(elevation, coords, order=1, mode="nearest")
    accumulation_values = map_coordinates(accumulation, coords, order=1, mode="nearest")
    valley_shape_values = map_coordinates(is_valley_shape.astype(np.float64), coords, order=1, mode="nearest")

    seg_dist = np.sqrt(np.diff(xs) ** 2 + np.diff(ys) ** 2)
    cum_dist = np.concatenate([[0.0], np.cumsum(seg_dist)])

    grades = np.zeros_like(cum_dist)
    nonzero = seg_dist > 0
    grades[1:][nonzero] = np.abs(np.diff(elevations)[nonzero]) / seg_dist[nonzero] * 100.0

    crossings = _summarize_crossings(cum_dist, accumulation_values, valley_shape_values, culvert_threshold, bridge_threshold)

    radii = _curve_radii(xs, ys)
    min_radius = float(np.min(radii)) if len(radii) else None
    tight_curves = _find_tight_curves(cum_dist, radii, MIN_CURVE_RADIUS_M)

    return {
        "path": [{"lat": float(lat), "lng": float(lon)} for lat, lon in zip(lats, lons)],
        "profile": [
            {"distance_m": float(d), "elevation_m": float(e), "grade_percent": float(g)}
            for d, e, g in zip(cum_dist, elevations, grades)
        ],
        "length_m": float(cum_dist[-1]) if len(cum_dist) else 0.0,
        "max_grade_percent": float(grades.max()) if len(grades) else 0.0,
        "crossings": crossings,
        "min_curve_radius_m": min_radius,
        "tight_curves": tight_curves,
    }
