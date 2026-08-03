# CONTEXT.md — 이 프로젝트를 처음 보는 LLM을 위한 문서

이 문서는 README.md(사용자용 기능 설명)와 별개로, **이 코드베이스를 이어받아 작업할 다른 LLM/개발자**가
"왜 이렇게 짜여 있는지"까지 빠르게 파악하도록 쓴 기술 컨텍스트 문서다. 코드를 처음부터 다 읽지 않아도
이 문서 하나로 아키텍처, 핵심 알고리즘의 근거, 이미 겪은 버그와 그 원인, 알려진 한계까지 파악할 수 있게
작성했다.

## 한 줄 요약

DEM(수치표고모델) 기반으로 임도(산림 도로) 노선을 자동 설계·최적화하는 개인 연구용 풀스택 웹앱.
FastAPI 백엔드 + React/Leaflet 프런트엔드. 제주도 Copernicus DEM으로 테스트됨(`sample_data/`).

## 기술 스택

- **백엔드**: Python, FastAPI, `rasterio`(DEM 입출력/재투영), `numpy`, `scipy.ndimage`(리샘플링/보간),
  `scikit-image`(`skimage.graph.MCP_Geometric` 최소비용경로, `skimage.measure` 등고선)
- **프런트엔드**: React + Vite, Leaflet.js (지도), 순수 SVG로 종단면도 렌더링(차트 라이브러리 없음)
- 상태관리 라이브러리 없음 — `App.jsx` 하나의 컴포넌트 안에 `useState`/`useEffect`로 전부 관리
- 백엔드는 파일 저장 없이 인메모리 캐시(`_dem_cache: dict[str, Dem]`)로 DEM 보관 — 서버 재시작하면 날아감

## 디렉터리 구조

```
backend/app/
  dem_processing.py   DEM 로드/재투영/시각화 PNG 생성/등고선/고도 조회
  routing.py           노선 탐색 알고리즘 전체 (비용표면 → 최소비용경로 → 스무딩 → 결과 조립)
  earthwork.py         절/성토 물량 산출 (교량 구간 제외 처리 포함)
  main.py              FastAPI 앱, 엔드포인트 정의
frontend/src/
  App.jsx              메인 컴포넌트 — 지도, 툴바, 노선 상태, 비교 패널 전부 여기
  ElevationProfile.jsx  종단면도 SVG 차트 (리사이즈 가능)
  api.js               백엔드 API 호출 래퍼
  export.js            GeoJSON/CSV 내보내기 유틸
  App.css
sample_data/jeju_copernicus_dem.tif   테스트용 제주 DEM (git에 커밋되어 있음)
```

## 핵심 개념 1 — 좌표계(CRS) 두 개를 구분해서 써야 한다

- **`WORK_CRS = EPSG:32652`** (UTM 52N, 미터 단위) — `dem_processing.py`의 `Dem` 클래스는 어떤 좌표계의
  DEM이 업로드되든 **생성자에서 무조건 이 좌표계로 재투영**한다(`dem_processing.py:41-63`). 이후
  slope/hillshade/flow accumulation/routing 등 내부 계산은 전부 이 좌표계(등거리 미터 격자) 위에서
  이루어진다. **왜 필요한가**: Copernicus DEM 등은 EPSG:4326(도 단위)로 오는 경우가 많은데, 셀 크기를
  미터로 가정하고 경사·거리를 계산하면 완전히 틀린 값이 나온다(초기에 실제로 겪은 버그).
- **EPSG:4326 (WGS84, 위경도)** — API 입출력(요청의 lat/lng, 응답의 path 좌표)과 Leaflet 표시용.
- **시각화 이미지의 이중 재투영 문제**: `_rgba_to_wgs84_png()` (`dem_processing.py:271-291`)가 중요하다.
  히트맵(음영기복/경사도/고도)은 UTM(WORK_CRS)에서 픽셀 단위로 계산한 뒤, **Leaflet에 넘기기 직전에
  다시 EPSG:4326으로 재투영**한다. 이유: Leaflet의 `imageOverlay`는 이미지를 위경도 사각형 경계에
  선형으로 늘려 붙이는데, 위도에 따라 경도 1도의 실거리가 달라진다(제주 위도 약 33.5°에서는 위도 1도의
  약 83%). UTM 격자(진짜 정사각형 미터 셀)를 위경도 bounds에 그대로 늘려버리면 동서 방향으로 압축되어
  실제 지도와 어긋난다 — 이건 이 세션에서 실제로 겪고 고친 버그다(이미지 종횡비가 0.845 → 1.017로
  교정됨, Hallasan/해안선이 실제 지도 라벨과 맞는지 눈으로 확인함).

## 핵심 개념 2 — 노선 탐색 파이프라인 (`routing.py`)

전체 흐름: `find_multi_route()` → 비용표면 1회 생성 → 구간별 `_route_segment()` 반복 → 결과 이어붙이기.

### 1) 비용표면 생성 (`_prepare_cost_surface`, routing.py:121-143)

1. `_downsampled_grid(dem, MAX_ROUTING_DIM=2000)` — 원본 DEM이 2000px보다 크면 다운샘플링한다.
   **왜**: `MCP_Geometric`은 전체 격자에 대해 다익스트라류 탐색을 하므로 원본 해상도(수천~수만 px)로는
   느리다. 제주 전체 기준 셀 크기가 약 57m 정도로 줄어든다. **주의**: 절/성토 계산(`earthwork.py`)은
   이 다운샘플 격자를 쓰지 않고 원본 해상도 DEM에서 다시 샘플링한다 — 노선탐색과 절성토가 서로 다른
   해상도를 쓴다는 걸 헷갈리면 안 된다.
2. `_land_mask()` — `valid & (elevation > 0.0)`. **왜 nodata만으로 안 되는가**: Copernicus 등 글로벌
   DEM은 바다를 nodata가 아니라 실제 고도값(대체로 0 부근)으로 채워놓는 경우가 많아서, nodata 마스크만
   쓰면 바다 위로 노선이 뚫린다 — 실제로 겪은 버그(바다 클릭 시 노선이 그려짐).
3. `_slope_percent()` — `np.gradient` 기반 경사(%).
4. `_flow_accumulation()` — D8 알고리즘으로 유역면적 프록시 계산(아래 "핵심 개념 3" 참고).
5. `_local_concavity()` — 각 셀이 상하좌우 이웃 평균보다 얼마나 낮은지(오목한 정도). D8 아티팩트
   필터링용(아래 참고).
6. `_stream_thresholds()` — 유역면적의 95th(`CULVERT_PERCENTILE`)/99.5th(`BRIDGE_PERCENTILE`)
   백분위수를 암거/교량 임계값으로 사용. **절대 면적이 아니라 지금 업로드된 DEM 범위 안에서의 상대적
   순위**라는 점이 중요 — 같은 실제 계곡도 업로드 범위가 달라지면 분류가 달라질 수 있다.
7. `_cost_surface()` — 최종 비용 = `1 + grade_penalty + crossing_penalty`.
   - `grade_penalty`: 경사가 `MAX_GRADE_PERCENT=14%` 이하면 `(slope/14)^2`로 완만하게 증가, 넘으면
     `1 + 20*(slope-14)`로 급증. `ABSOLUTE_MAX_GRADE_PERCENT=30%` 초과는 `cost=inf`(통행 불가).
   - `crossing_penalty`(`_crossing_cost`, routing.py:356-366): 오목 지형이면서 유역면적이 culvert
     임계값 이상이면 `CULVERT_BASE_COST=2.0 * (accumulation/culvert_threshold)`, bridge 임계값
     이상이면 `BRIDGE_BASE_COST=15.0 * (accumulation/bridge_threshold)`.
   - 바다(`~land`)도 `cost=inf`.
8. `seed`가 주어지면 `_apply_seed_noise()`로 하드 제약(`inf`)은 그대로 둔 채 나머지 셀에 시드 기반
   ±15%(`SEED_NOISE_RANGE`) 곱셈 노이즈를 섞는다 — "다른 경로 생성" 기능의 핵심(아래 참고).

### 2) 최소비용경로 탐색 (`_route_segment`, routing.py:146-184)

- `skimage.graph.MCP_Geometric(cost, fully_connected=True)`로 8방향 다익스트라류 탐색.
- 경유지가 여러 개면 구간별로 나눠 탐색(`find_multi_route`가 반복 호출)하고 좌표열을 이어붙인다.
  **비용표면은 전체 DEM에 대해 한 번만 계산해서 모든 구간이 재사용**한다(반복 계산 방지).
- 8방향 격자 탐색 결과는 계단처럼 각지므로 후처리 필요 → Douglas-Peucker + Chaikin (아래).

### 3) 경로 스무딩

- **Douglas-Peucker** (`_simplify_path`, routing.py:187-217): 시작~끝을 잇는 직선에서
  `SIMPLIFY_EPSILON_CELLS=1.5`셀보다 멀리 떨어진 점만 재귀적으로 남기고, 거의 일직선인 중간점(8방향
  이동 때문에 생긴 계단 노이즈)은 제거한다.
- **Chaikin 코너커팅** (`_chaikin_smooth`, routing.py:220-239): 남은 꼭짓점들 사이 뾰족한 연결을
  둥글린다. 각 구간을 25%/75% 지점 두 점으로 대체하는 걸 `CHAIKIN_ITERATIONS=3`번 반복 — 무한 반복하면
  2차 B-스플라인에 수렴하는 성질이 있는 표준 코너커팅 알고리즘.
- 스무딩된 좌표에 대해서만 3점 외접원 공식(`_curve_radii`, routing.py:242-258)으로 곡선반경을 계산해
  `MIN_CURVE_RADIUS_M=15.0` 미만 구간을 `tight_curves`로 보고한다. 스무딩 전에 계산하면 격자 이동
  아티팩트 때문에 전부 급커브로 잘못 잡힌다.

### 4) 결과 조립 (`_build_result`, routing.py:438-484)

- 스무딩된 좌표는 격자 정수 위치가 아닐 수 있어 `scipy.ndimage.map_coordinates(order=1)`로 보간
  샘플링해서 고도/유역면적/오목여부 값을 얻는다.
- `_summarize_crossings()`가 연속된 "하천 셀 구간"을 하나의 crossing으로 묶어서 `structure`(교량/암거),
  `start_distance_m`/`end_distance_m`(구간 시작~끝 거리, earthwork.py가 성토 제외 범위 판단에 사용),
  `relative_catchment`(peak accumulation / culvert_threshold)를 반환한다.

## 핵심 개념 3 — 교량 vs 암거 판단 로직과 그 한계 (자주 나온 질문)

**판정 기준** (routing.py:412, 423):
1. 그 지점의 유역면적(D8 흐름누적)이 `culvert_threshold`(상위 5%) 이상이고, 동시에 실제로 오목한
   지형(`is_valley_shape`)이면 → "하천을 건너는 구간"으로 인정.
2. 그 구간 안 유역면적 peak가 `bridge_threshold`(상위 0.5%) 이상이면 → **교량**, 아니면 → **암거**.

즉 실제 유량(㎥/s)을 계산하는 게 아니라 **"이 DEM 안에서 상대적으로 얼마나 큰 계곡이냐"만 보는
근사치**다.

**왜 오목 지형 확인이 추가됐나 (`_local_concavity`, routing.py:336-346)**: D8 흐름누적은 완전히
평탄/대칭인 지형에서 방향 결정의 tie 때문에 특정 셀에 유량이 인위적으로 쏠리는 아티팩트를 만들 수
있다. 이 세션에서 실제로 "교량 표시가 지형상 계곡이 아닌 곳에 나타남" 버그를 겪었고, 그 셀이
상하좌우 이웃보다 실제로 낮은지(오목한지) 재확인하는 필터를 추가해서 고쳤다. **중요**: 오목함은
"유역면적이 큰데 진짜 계곡 맞아?"를 재확인하는 게이트일 뿐이고, 오목하기만 하고 유역면적이 기준
미달이면 애초에 crossing 자체로 안 잡힌다(교량도 암거도 아님).

**알려진 한계 (실무와의 괴리)**:
- D8은 단일 흐름방향 단순화 모델이고, DEM에 sink-fill(움푹 팬 지점 채우기) 전처리가 없다 — 실무
  수문 툴(TauDEM, RichDEM, ArcGIS Fill 등)과 다르다.
- 다운샘플링된 라우팅 격자(제주 전체 기준 ~57m 셀) 위에서 계산되므로 작은 지류는 뭉개진다.
- 백분위수 임계값은 **절대치가 아니라 업로드 범위 안에서의 상대 순위** — 물리적으로 고정된 값이 아니다.
- 강수량·토양·식생 등 실제 수문 요소를 전혀 반영하지 않는다.
- **제주 특유의 문제**: 현무암의 높은 공극률 때문에 제주 하천은 대부분 "건천"(상시 유수 없이 폭우 때만
  흐름)이다. 이 모델은 지형 형태(오목+상대적 유역면적)만 보므로, 상시 유수가 없는 마른 골짜기도 지형이
  크게 파여 있으면 교량급으로 분류될 수 있다. 다만 폭우 시 급격한 유출이 몰리는 지점이라는 신호로는
  여전히 어느 정도 유효할 수 있음 — 정밀하게 하려면 지역별 유출계수를 반영한 합리식(Q=CIA) 계산이
  필요하지만 지금 구조(DEM만 입력)로는 강우자료·토양자료 없이 불가능하다.
- 실제 설계는 유량 계산 외에도 성토고 대비 경제성, 사면 안정성, 생태통로 등을 종합적으로 고려하는데
  이 모델은 그중 상대적 유역면적 하나만 근사한다.

## 핵심 개념 4 — 시드 기반 대안 노선 생성

같은 시작/경유/도착점이면 알고리즘은 결정론적이라 항상 같은 노선이 나온다. `seed`를 주면
(`_apply_seed_noise`, routing.py:113-118) 하드 제약(`inf`, 통행 불가)은 그대로 두고 유한한 비용
셀에만 `np.random.default_rng(seed)`로 생성한 균등분포 ±15% 곱셈 노이즈를 섞어서 재탐색한다. 같은
seed는 항상 같은 노이즈 → 같은 노선(재현 가능). 프런트엔드는 "다른 경로 생성" 버튼(랜덤 정수 시드)과
수동 시드 입력 필드(`routeSeed` state, `App.jsx:53`) 둘 다 제공한다.

## 핵심 개념 5 — 절/성토(cut/fill) 산출과 교량 제외 처리 (`earthwork.py`)

- 노선의 station(=routing 결과의 `path`/`profile` 각 점)을 잇는 직선 구배를 설계 노면으로 보고,
  `SAMPLE_INTERVAL_M=10.0`m 간격으로 **원본 해상도 DEM**을 재샘플링해 실제 지형고와 비교한다. station
  간격(다운샘플링 때문에 보통 수백 m)보다 촘촘히 다시 읽는 이유: 실제 도로는 station 사이를 직선으로
  잇지만 지형은 그 사이에서도 오르내리기 때문에, station에서만 비교하면 굴곡이 누락된다.
- 단면적 = `road_width_m * depth + slope_ratio * depth^2` (절토 1:1, 성토 1:1.5 사다리꼴 단면 공식),
  양단면적평균법(end-area method)으로 물량 누적.
- **교량 구간 제외** (`earthwork.py:59-69`): `routing.py`가 반환한 `crossings` 중 `structure=="교량"`인
  구간의 `start_distance_m`~`end_distance_m` 범위는 `cut_area`/`fill_area`를 0으로 만들고, 대신
  `bridge_length_m`으로 별도 집계한다. **왜**: 이 처리가 없으면 깊은 계곡을 다리로 건너는 게 아니라
  흙으로 다 메우는 것처럼 계산되어 비현실적인 성토량이 나온다(실제로 겪고 고친 버그 — 60m 깊이 합성
  계곡 테스트에서 169,200㎥ 비현실적 성토 → 교량 처리 후 0㎥ + 35m 교량 길이로 교정 확인).

## 프런트엔드 구조 (`App.jsx`)

하나의 컴포넌트에 전부 있다. 주요 state:

| state | 용도 |
|---|---|
| `demInfo` | 업로드된 DEM 메타(dem_id, bounds, 표고 범위 등) |
| `layer` | 지도 오버레이 종류(`hillshade`/`slope`/`elevation`) |
| `routePoints` | 클릭으로 찍은 시작/경유/도착점 배열 |
| `routeResult` | 현재 계산된 노선 결과(path/profile/earthwork 등 전체) |
| `routeSeed` | 대안 노선 시드(null이면 기본 결정론적 경로) |
| `savedRoutes` | "비교용 저장"한 노선들 (색상·표시여부·seed·전체 result 포함) |
| `profileHeight` | 종단면도 패널 높이(드래그로 조절) |

주요 로직:
- 지도 클릭 → `routePoints`에 추가 → `[routePoints, roadWidthM, routeSeed]` 의존성 effect가
  자동으로 `findRoute()` 호출 (디바운스 없음, 클릭할 때마다 즉시 재계산).
- `getBridgeSegments(result)` (App.jsx:12-28): `crossings`의 `start/end_distance_m`을 `profile`의
  `distance_m`과 매칭해서 `path`의 대응 좌표 구간을 뽑아낸다 — 백엔드 변경 없이 프런트에서만 계산.
  지도 위 노선에 굵은 보라색(`BRIDGE_COLOR = "#6a1b9a"`) 선으로 겹쳐 그리는 데 사용.
- `handleProfileDragStart` (App.jsx:253-267): 종단면도 위 드래그 핸들 — `window`에 mousemove/mouseup
  리스너를 동적으로 붙였다 떼는 클로저 패턴으로 구현(리렌더 사이 stale closure 방지).
- 저장된 노선(`savedRoutes`)은 점선(`dashArray: "8 4"`)으로 별도 레이어(`savedRoutesLayerRef`)에
  그려서 현재 계산 중인 노선과 구분한다.
- 노선 상태 텍스트(`routeStatus`)는 **의도적으로 최소한만 보여준다** — 길이/경사/절토/성토는 이미
  `ElevationProfile` 패널에 표시되므로 중복 표시하지 않고, 오류/곡선반경 경고/대안 시드 정보만 남긴다
  (App.jsx:194-199) — 세션 중 사용자 피드백으로 중복 제거함.

## `ElevationProfile.jsx` — 종단면도 SVG

- `ResizeObserver`로 부모 컨테이너의 실제 픽셀 크기를 측정해서 `viewBox`를 그 크기와 **1:1로 맞춘다**
  (`viewBox={0 0 ${measuredWidth} ${measuredHeight}}`, `width="100%" height="100%"`, 별도
  `preserveAspectRatio` 지정 없음 = 기본 meet인데 크기가 정확히 같으므로 스케일 1). **왜 이렇게
  하는가**: 이전에는 고정 760×200 좌표계를 `preserveAspectRatio="none"`으로 컨테이너에 억지로 늘려
  채웠는데, 컨테이너 실제 비율이 3.8:1(760:200)이 아니면 텍스트 글꼴까지 비균일하게 늘어나 찌그러지는
  버그가 있었다(사용자가 "폰트 늘어남"으로 신고). 실제 크기를 그대로 좌표계로 쓰면 늘릴 필요 자체가
  없어져서 근본적으로 해결됨.
- `height` prop을 부모(`App.jsx`)가 `profileHeight` state로 제어 → 드래그 리사이즈와 연동.
- 절토/성토 구간을 반투명 폴리곤으로 채색, 교량 구간은 보라색 굵은 선으로 겹쳐 그림.
- `earthwork.sections`가 600개보다 많으면 `decimate()`로 균등 서브샘플링(렌더링 성능/SVG 포인트 수
  제한 목적).

## `export.js`

- `routeToGeoJSON(route)` / `combinedGeoJSON(routes)`: 노선을 GeoJSON `LineString` Feature로 변환,
  properties에 길이/최대경사/최소곡선반경/절토/성토/교량길이/도로폭 포함.
- `routeToCSV(route)`: `earthwork.sections`(station별 상세 데이터)를 CSV로.
- `downloadText()`: Blob + `<a download>` 클릭으로 브라우저 다운로드 트리거(서버 왕복 없음).

## API 엔드포인트 (`main.py`)

| method | path | 설명 |
|---|---|---|
| POST | `/api/dem/upload` | 파일 여러 개면 자동 병합(mosaic), `Dem` 인스턴스를 `_dem_cache`에 저장 |
| GET | `/api/dem/{id}/info` | 메타데이터 |
| GET | `/api/dem/{id}/hillshade` \| `/slope` \| `/elevation-heatmap` | PNG (WGS84 재투영됨) |
| GET | `/api/dem/{id}/elevation?lat&lng` | 지점 고도 조회 |
| GET | `/api/dem/{id}/contours?interval` | GeoJSON 등고선 |
| POST | `/api/dem/{id}/route` | body: `{waypoints, road_width_m, seed}` → 노선+절성토 결과 |

`_dem_cache`는 프로세스 메모리에만 있음 — 서버 재시작하면 이전 `dem_id`는 전부 무효화된다(테스트 시
프런트를 새로고침만 해도 DEM 재업로드가 필요할 수 있음, 서버까지 재시작했다면 반드시 필요).

## 개발 환경 관련 특이사항

- 이 머신은 sudo가 없어서 Homebrew(`/opt/homebrew`)에 쓰기 권한이 없다 — Node.js는 `nvm`으로 설치함.
- 터미널 git에는 GitHub 인증 정보가 없어서 `git push`는 사용자가 GitHub Desktop으로 직접 함.
- 브라우저 자동화 테스트 시 `<input type="file">`은 OS 파일 다이얼로그라 직접 자동화가 안 되므로,
  테스트용 DEM(`sample_data/jeju_copernicus_dem.tif`)을 `frontend/public/`에 임시 복사해두고
  `fetch()`로 읽어 `File`/`DataTransfer`를 만든 뒤 `input.files`에 주입 + `change` 이벤트를 dispatch하는
  방식으로 업로드를 재현했다. 테스트 후 `frontend/public/`의 임시 파일은 삭제한다(git에 안 들어가야
  함 — 원본은 `sample_data/`에 이미 있음).

## 지금까지 논의됐지만 아직 미착수인 개선안

- **횡단(도로 폭 방향) 지형 반영**: 지금 절/성토는 도로 중심선 기준 종단 방향만 본다. 실제로는 도로
  폭 방향으로도 지형이 기울어 있으면 절/성토가 비대칭이 되는데, 이건 반영 안 됨. 사용자에게 한 번
  제안했지만 요청받아 진행한 적은 없음.
- 제주 건천 특성을 반영한 지역별 유출계수 보정 — 강우/토양 데이터가 추가로 필요해서 구조 변경이 큼.
- 보전구역·문화재구역 등 법적 제약 조건 미반영.

## 이 문서를 유지보수할 때

기능을 추가/수정하면 이 문서의 관련 섹션(특히 "핵심 개념" 번호가 붙은 섹션들과 상수/함수 줄 번호
참조)도 같이 갱신하는 게 좋다. 사용자용 설명은 `README.md`에, "왜 이렇게 짜여있나/무슨 버그를 겪고
고쳤나" 같은 구현 배경은 이 파일에 쓰는 걸로 역할을 나눈다.
