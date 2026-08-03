import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";
import "./App.css";
import { elevationHeatmapUrl, fetchContours, fetchElevation, findRoute, hillshadeUrl, slopeUrl, uploadDem } from "./api";
import ElevationProfile from "./ElevationProfile";
import { combinedGeoJSON, downloadText, geoJSONToRoutes, routeToCSV, routeToGeoJSON } from "./export";

const ROUTE_COLORS = ["#1f6feb", "#e65100", "#2e7d32", "#ad1457", "#6a1b9a", "#00838f", "#8d6e63"];
const BRIDGE_COLOR = "#6a1b9a";

const tightCurveIcon = L.divIcon({
  className: "tight-curve-icon",
  html: "⚠",
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

function getTightCurvePoints(result) {
  const curves = result.tight_curves || [];
  if (curves.length === 0 || !result.profile || !result.path) return [];

  return curves
    .map((tc) => {
      let bestIdx = 0;
      let bestDiff = Infinity;
      result.profile.forEach((p, i) => {
        const diff = Math.abs(p.distance_m - tc.distance_m);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestIdx = i;
        }
      });
      const pt = result.path[bestIdx];
      return pt ? { lat: pt.lat, lng: pt.lng, radius_m: tc.radius_m, distance_m: tc.distance_m } : null;
    })
    .filter(Boolean);
}

function getBridgeSegments(result) {
  const bridges = (result.crossings || []).filter((c) => c.structure === "교량");
  if (bridges.length === 0 || !result.profile || !result.path) return [];

  const segments = [];
  bridges.forEach((bridge) => {
    const points = [];
    result.profile.forEach((p, i) => {
      if (p.distance_m >= bridge.start_distance_m && p.distance_m <= bridge.end_distance_m) {
        const pt = result.path[i];
        if (pt) points.push([pt.lat, pt.lng]);
      }
    });
    if (points.length >= 2) segments.push(points);
  });
  return segments;
}

export default function App() {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const overlayRef = useRef(null);
  const markersLayerRef = useRef(null);
  const routeLayerRef = useRef(null);
  const savedRoutesLayerRef = useRef(null);
  const contoursLayerRef = useRef(null);
  const contoursDataRef = useRef(null);
  const hoverTimeoutRef = useRef(null);

  const [demInfo, setDemInfo] = useState(null);
  const [layer, setLayer] = useState("hillshade");
  const [overlayOpacity, setOverlayOpacity] = useState(0.85);
  const [status, setStatus] = useState("");
  const [showContours, setShowContours] = useState(false);
  const [elevationLabel, setElevationLabel] = useState("");

  const [routePoints, setRoutePoints] = useState([]);
  const [routeResult, setRouteResult] = useState(null);
  const [routeStatus, setRouteStatus] = useState("");
  const [roadWidthM, setRoadWidthM] = useState(4);
  const [savedRoutes, setSavedRoutes] = useState([]);
  const [routeSeed, setRouteSeed] = useState(null);
  const [profileHeight, setProfileHeight] = useState(220);
  const [selectedRouteId, setSelectedRouteId] = useState(null);

  useEffect(() => {
    mapRef.current = L.map(mapContainerRef.current).setView([33.38, 126.55], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(mapRef.current);
    markersLayerRef.current = L.layerGroup().addTo(mapRef.current);
    routeLayerRef.current = L.layerGroup().addTo(mapRef.current);
    savedRoutesLayerRef.current = L.layerGroup().addTo(mapRef.current);

    return () => mapRef.current?.remove();
  }, []);

  useEffect(() => {
    if (!demInfo || !mapRef.current) return;

    const { south, west, north, east } = demInfo.bounds;
    const bounds = L.latLngBounds([south, west], [north, east]);
    const url =
      layer === "hillshade"
        ? hillshadeUrl(demInfo.dem_id)
        : layer === "slope"
          ? slopeUrl(demInfo.dem_id)
          : elevationHeatmapUrl(demInfo.dem_id);

    overlayRef.current?.remove();
    overlayRef.current = L.imageOverlay(url, bounds, { opacity: overlayOpacity }).addTo(mapRef.current);
    mapRef.current.fitBounds(bounds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demInfo, layer]);

  useEffect(() => {
    overlayRef.current?.setOpacity(overlayOpacity);
  }, [overlayOpacity]);

  useEffect(() => {
    contoursDataRef.current = null;
    contoursLayerRef.current?.remove();
    contoursLayerRef.current = null;
  }, [demInfo]);

  useEffect(() => {
    if (!showContours || !demInfo || !mapRef.current) {
      contoursLayerRef.current?.remove();
      contoursLayerRef.current = null;
      return;
    }

    let cancelled = false;
    async function load() {
      if (!contoursDataRef.current) {
        contoursDataRef.current = await fetchContours(demInfo.dem_id);
      }
      if (cancelled) return;
      contoursLayerRef.current = L.geoJSON(contoursDataRef.current, {
        style: { color: "#8b5e3c", weight: 1, opacity: 0.7 },
        onEachFeature: (feature, layer) => {
          layer.bindTooltip(`${feature.properties.elevation_m}m`, { sticky: true });
        },
      }).addTo(mapRef.current);
    }
    load().catch((err) => setStatus(`등고선 오류: ${err.message}`));

    return () => {
      cancelled = true;
    };
  }, [showContours, demInfo]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    function handleMouseMove(e) {
      if (!demInfo) return;
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
      const { lat, lng } = e.latlng;
      hoverTimeoutRef.current = setTimeout(() => {
        fetchElevation(demInfo.dem_id, lat, lng)
          .then((res) => {
            setElevationLabel(res.elevation_m != null ? `고도: ${res.elevation_m.toFixed(1)}m` : "고도: -");
          })
          .catch(() => {});
      }, 150);
    }

    map.on("mousemove", handleMouseMove);
    return () => {
      map.off("mousemove", handleMouseMove);
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, [demInfo]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    function handleClick(e) {
      if (!demInfo) {
        setRouteStatus("먼저 DEM을 업로드하세요.");
        return;
      }
      const clicked = { lat: e.latlng.lat, lng: e.latlng.lng };
      setRoutePoints((prev) => [...prev, clicked]);
    }

    map.on("click", handleClick);
    return () => map.off("click", handleClick);
  }, [demInfo]);

  useEffect(() => {
    markersLayerRef.current?.clearLayers();
    routeLayerRef.current?.clearLayers();
    setRouteResult(null);

    routePoints.forEach((p, i) => {
      const isFirst = i === 0;
      const isLast = i === routePoints.length - 1 && routePoints.length > 1;
      const color = isFirst ? "#2e7d32" : isLast ? "#c62828" : "#f57c00";
      L.circleMarker([p.lat, p.lng], {
        radius: 7,
        color,
        fillColor: color,
        fillOpacity: 1,
      }).addTo(markersLayerRef.current);
    });

    if (routePoints.length === 0) {
      setRouteStatus("");
      return;
    }
    if (routePoints.length === 1) {
      setRouteStatus("경유지 또는 도착점을 클릭하세요.");
      return;
    }

    setRouteStatus("노선 탐색 중...");
    findRoute(demInfo.dem_id, routePoints, roadWidthM, routeSeed)
      .then((result) => {
        setRouteResult(result);
        const curveWarning =
          result.tight_curves && result.tight_curves.length > 0
            ? `최소곡선반경 ${result.min_curve_radius_m.toFixed(0)}m (기준 미달 ${result.tight_curves.length}곳)`
            : "";
        const seedInfo = routeSeed != null ? `대안 시드 ${routeSeed}` : "";
        setRouteStatus([curveWarning, seedInfo].filter(Boolean).join(" / "));
        const latlngs = result.path.map((p) => [p.lat, p.lng]);
        L.polyline(latlngs, { color: "#1f6feb", weight: 4 }).addTo(routeLayerRef.current);
        getBridgeSegments(result).forEach((points) => {
          L.polyline(points, { color: BRIDGE_COLOR, weight: 7, opacity: 0.9 }).addTo(routeLayerRef.current);
        });
        getTightCurvePoints(result).forEach((tc) => {
          L.marker([tc.lat, tc.lng], { icon: tightCurveIcon })
            .bindTooltip(`급커브 반경 ${tc.radius_m.toFixed(1)}m (기준 15m 미달)`)
            .addTo(routeLayerRef.current);
        });
      })
      .catch((err) => setRouteStatus(`오류: ${err.message}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routePoints, roadWidthM, routeSeed]);

  useEffect(() => {
    mapRef.current?.invalidateSize();
  }, [routeResult]);

  useEffect(() => {
    const layer = savedRoutesLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    savedRoutes.forEach((route) => {
      if (!route.visible) return;
      const latlngs = route.result.path.map((p) => [p.lat, p.lng]);
      L.polyline(latlngs, { color: route.color, weight: 4, dashArray: "8 4" }).addTo(layer);
      getBridgeSegments(route.result).forEach((points) => {
        L.polyline(points, { color: BRIDGE_COLOR, weight: 7, opacity: 0.9 }).addTo(layer);
      });
      getTightCurvePoints(route.result).forEach((tc) => {
        L.marker([tc.lat, tc.lng], { icon: tightCurveIcon })
          .bindTooltip(`급커브 반경 ${tc.radius_m.toFixed(1)}m (기준 15m 미달) — ${route.label}`)
          .addTo(layer);
      });
    });
  }, [savedRoutes]);

  async function handleFileChange(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    setStatus(`업로드 중... (${files.length}개 파일 병합)`);
    try {
      const info = await uploadDem(files);
      setDemInfo(info);
      setStatus(
        `표고 ${info.min_elevation_m.toFixed(1)}m ~ ${info.max_elevation_m.toFixed(1)}m / 셀크기 ${info.cellsize_m.toFixed(1)}m`
      );
    } catch (err) {
      setStatus(`오류: ${err.message}`);
    }
  }

  function resetRoute() {
    setRoutePoints([]);
    setRouteSeed(null);
    setSelectedRouteId(null);
  }

  async function handleGeoJSONImport(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const geojson = JSON.parse(await file.text());
      const imported = geoJSONToRoutes(geojson);
      if (imported.length === 0) {
        setStatus("오류: 가져올 노선(LineString)이 파일에 없습니다.");
        return;
      }
      setSavedRoutes((prev) => [
        ...prev,
        ...imported.map((route, i) => ({
          id: Date.now() + i,
          color: ROUTE_COLORS[(prev.length + i) % ROUTE_COLORS.length],
          visible: true,
          ...route,
        })),
      ]);
      setStatus(`GeoJSON에서 노선 ${imported.length}개를 불러왔습니다.`);
    } catch (err) {
      setStatus(`오류: GeoJSON을 읽을 수 없습니다 (${err.message})`);
    }
  }

  function generateAlternativeRoute() {
    setRouteSeed(Math.floor(Math.random() * 1_000_000_000));
  }

  function handleProfileDragStart(e) {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = profileHeight;
    function onMove(ev) {
      const delta = startY - ev.clientY;
      setProfileHeight(Math.min(600, Math.max(100, startHeight + delta)));
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function undoLastPoint() {
    setRoutePoints((prev) => prev.slice(0, -1));
  }

  function saveCurrentRoute() {
    if (!routeResult) return;
    const label = `노선 ${String.fromCharCode(65 + (savedRoutes.length % 26))}`;
    const color = ROUTE_COLORS[savedRoutes.length % ROUTE_COLORS.length];
    setSavedRoutes((prev) => [
      ...prev,
      { id: Date.now(), label, color, visible: true, roadWidthM, seed: routeSeed, result: routeResult },
    ]);
    setRoutePoints([]);
    setRouteSeed(null);
  }

  function toggleRouteVisibility(id) {
    setSavedRoutes((prev) => prev.map((r) => (r.id === id ? { ...r, visible: !r.visible } : r)));
  }

  function removeSavedRoute(id) {
    setSavedRoutes((prev) => prev.filter((r) => r.id !== id));
    setSelectedRouteId((prev) => (prev === id ? null : prev));
  }

  function exportRoute(route, format) {
    const safeLabel = route.label.replace(/\s+/g, "_");
    if (format === "geojson") {
      downloadText(`${safeLabel}.geojson`, JSON.stringify(routeToGeoJSON(route), null, 2), "application/geo+json");
    } else {
      downloadText(`${safeLabel}.csv`, routeToCSV(route), "text/csv");
    }
  }

  function exportAllRoutes() {
    downloadText("노선_비교.geojson", JSON.stringify(combinedGeoJSON(savedRoutes), null, 2), "application/geo+json");
  }

  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        undoLastPoint();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="app">
      <div className="toolbar">
        <div className="toolbar-row">
          <span className="brand">지형 기반 임도 노선 최적화</span>
          <label className="btn file-btn">
            DEM 업로드
            <input type="file" accept=".tif,.tiff" multiple onChange={handleFileChange} style={{ display: "none" }} />
          </label>
          <label className="btn file-btn">
            GeoJSON 불러오기
            <input type="file" accept=".geojson,.json" onChange={handleGeoJSONImport} style={{ display: "none" }} />
          </label>
          <span className="status-text">{status}</span>
        </div>

        <div className="toolbar-row">
          <div className="segmented">
            <button className={layer === "hillshade" ? "active" : ""} onClick={() => setLayer("hillshade")}>
              음영기복
            </button>
            <button className={layer === "slope" ? "active" : ""} onClick={() => setLayer("slope")}>
              경사도
            </button>
            <button className={layer === "elevation" ? "active" : ""} onClick={() => setLayer("elevation")}>
              고도
            </button>
          </div>

          <label className="control-group">
            투명도
            <input
              type="range"
              min="0.1"
              max="1"
              step="0.05"
              value={overlayOpacity}
              onChange={(e) => setOverlayOpacity(Number(e.target.value))}
            />
          </label>

          <label className="control-group">
            <input type="checkbox" checked={showContours} onChange={(e) => setShowContours(e.target.checked)} />
            등고선
          </label>

          <label className="control-group">
            도로폭
            <input
              type="number"
              min="1"
              max="20"
              step="0.5"
              value={roadWidthM}
              onChange={(e) => setRoadWidthM(Number(e.target.value))}
            />
            m
          </label>

          <button className="btn" onClick={undoLastPoint} disabled={routePoints.length === 0}>
            되돌리기
          </button>
          <button className="btn" onClick={resetRoute}>
            노선 초기화
          </button>
          <button className="btn" onClick={saveCurrentRoute} disabled={!routeResult}>
            이 노선 저장 (비교용)
          </button>
          <button className="btn" onClick={generateAlternativeRoute} disabled={routePoints.length < 2}>
            다른 경로 생성
          </button>
          <label className="control-group">
            시드
            <input
              type="number"
              placeholder="랜덤"
              value={routeSeed ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setRouteSeed(v === "" ? null : Number(v));
              }}
              className="seed-input"
            />
          </label>
          <span className="hint">지도 클릭 = 지점 추가, 계속 클릭하면 경유지로 연결 (Ctrl/Cmd+Z로도 되돌리기)</span>
          <span className="route-status">{routeStatus}</span>
        </div>
      </div>

      <div className="map-wrap">
        <div ref={mapContainerRef} className="map-el" />
        {demInfo && (
          <div className="floating-panel elevation-panel">
            {elevationLabel || "지도에 마우스를 올리면 고도가 표시됩니다"}
          </div>
        )}
        {demInfo && layer === "slope" && (
          <div className="floating-panel legend-panel">
            <span className="legend-title">경사도</span>
            <div className="legend-gradient" />
            <div className="legend-scale">
              <span>0%</span>
              <span>10%</span>
              <span>20%</span>
              <span>35%+</span>
            </div>
          </div>
        )}
        {demInfo && layer === "elevation" && (
          <div className="floating-panel legend-panel">
            <span className="legend-title">고도</span>
            <div className="legend-gradient legend-gradient-elevation" />
            <div className="legend-scale">
              <span>0m</span>
              <span>{(demInfo.max_elevation_m / 2).toFixed(0)}m</span>
              <span>{demInfo.max_elevation_m.toFixed(0)}m</span>
            </div>
          </div>
        )}
        {routePoints.length > 0 && (
          <div className="floating-panel point-legend" style={{ top: 10, left: 10 }}>
            <span>
              <span className="dot" style={{ background: "#2e7d32" }} /> 시작점
            </span>
            <span>
              <span className="dot" style={{ background: "#f57c00" }} /> 경유지
            </span>
            <span>
              <span className="dot" style={{ background: "#c62828" }} /> 도착점
            </span>
            {getBridgeSegments(routeResult || { path: [], profile: [], crossings: [] }).length > 0 && (
              <span>
                <span className="dot" style={{ background: BRIDGE_COLOR }} /> 교량
              </span>
            )}
            {routeResult && getTightCurvePoints(routeResult).length > 0 && (
              <span>⚠ 급커브(15m 미달)</span>
            )}
          </div>
        )}
        {savedRoutes.length > 0 && (
          <div className="floating-panel compare-panel">
            <div className="compare-header">
              <span className="legend-title">노선 비교 ({savedRoutes.length})</span>
              <button className="btn-mini" onClick={exportAllRoutes}>
                전체 GeoJSON
              </button>
            </div>
            <table className="compare-table">
              <thead>
                <tr>
                  <th></th>
                  <th>노선</th>
                  <th>길이</th>
                  <th>최대경사</th>
                  <th>절토</th>
                  <th>성토</th>
                  <th>교량</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {savedRoutes.map((route) => {
                  const ew = route.result.earthwork;
                  const isSelected = route.id === selectedRouteId;
                  return (
                    <tr
                      key={route.id}
                      className={isSelected ? "selected-row" : ""}
                      style={{ opacity: route.visible ? 1 : 0.4 }}
                    >
                      <td>
                        <input
                          type="checkbox"
                          checked={route.visible}
                          onChange={() => toggleRouteVisibility(route.id)}
                        />
                      </td>
                      <td
                        className="route-label-cell"
                        onClick={() => setSelectedRouteId((prev) => (prev === route.id ? null : route.id))}
                        title="클릭하면 아래에 이 노선의 종단면도가 표시됩니다"
                      >
                        <span className="dot" style={{ background: route.color }} /> {route.label}
                      </td>
                      <td>{(route.result.length_m / 1000).toFixed(2)}km</td>
                      <td>{route.result.max_grade_percent.toFixed(1)}%</td>
                      <td>{ew ? (ew.cut_volume_m3 / 1000).toFixed(1) : "-"}천㎥</td>
                      <td>{ew ? (ew.fill_volume_m3 / 1000).toFixed(1) : "-"}천㎥</td>
                      <td>{ew && ew.bridge_length_m > 0 ? `${ew.bridge_length_m.toFixed(0)}m` : "-"}</td>
                      <td className="compare-actions">
                        <button className="btn-mini" onClick={() => exportRoute(route, "geojson")} title="GeoJSON 내보내기">
                          GeoJSON
                        </button>
                        <button className="btn-mini" onClick={() => exportRoute(route, "csv")} title="CSV 내보내기">
                          CSV
                        </button>
                        <button className="btn-mini" onClick={() => removeSavedRoute(route.id)} title="삭제">
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(() => {
        const selectedRoute = savedRoutes.find((r) => r.id === selectedRouteId);
        const profileSource = selectedRoute ? selectedRoute.result : routeResult;
        if (!profileSource) return null;
        return (
          <>
            <div className="profile-resize-handle" onMouseDown={handleProfileDragStart} />
            <ElevationProfile
              lengthM={profileSource.length_m}
              maxGradePercent={profileSource.max_grade_percent}
              earthwork={profileSource.earthwork}
              height={profileHeight}
              label={selectedRoute?.label}
            />
          </>
        );
      })()}
    </div>
  );
}
