import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";
import "./App.css";
import { elevationHeatmapUrl, fetchContours, fetchElevation, findRoute, hillshadeUrl, slopeUrl, uploadDem } from "./api";
import ElevationProfile from "./ElevationProfile";

export default function App() {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const overlayRef = useRef(null);
  const markersLayerRef = useRef(null);
  const routeLayerRef = useRef(null);
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

  useEffect(() => {
    mapRef.current = L.map(mapContainerRef.current).setView([33.38, 126.55], 11);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
    }).addTo(mapRef.current);
    markersLayerRef.current = L.layerGroup().addTo(mapRef.current);
    routeLayerRef.current = L.layerGroup().addTo(mapRef.current);

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
    findRoute(demInfo.dem_id, routePoints, roadWidthM)
      .then((result) => {
        setRouteResult(result);
        const ew = result.earthwork;
        const curveWarning =
          result.tight_curves && result.tight_curves.length > 0
            ? ` / 최소곡선반경 ${result.min_curve_radius_m.toFixed(0)}m (기준 미달 ${result.tight_curves.length}곳)`
            : "";
        setRouteStatus(
          `노선 길이 ${(result.length_m / 1000).toFixed(2)}km / 최대경사 ${result.max_grade_percent.toFixed(1)}%` +
            (ew ? ` / 절토 ${(ew.cut_volume_m3 / 1000).toFixed(1)}천㎥ / 성토 ${(ew.fill_volume_m3 / 1000).toFixed(1)}천㎥` : "") +
            curveWarning
        );
        const latlngs = result.path.map((p) => [p.lat, p.lng]);
        L.polyline(latlngs, { color: "#1f6feb", weight: 4 }).addTo(routeLayerRef.current);
      })
      .catch((err) => setRouteStatus(`오류: ${err.message}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routePoints, roadWidthM]);

  useEffect(() => {
    mapRef.current?.invalidateSize();
  }, [routeResult]);

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
  }

  function undoLastPoint() {
    setRoutePoints((prev) => prev.slice(0, -1));
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
          </div>
        )}
      </div>

      {routeResult && (
        <ElevationProfile
          lengthM={routeResult.length_m}
          maxGradePercent={routeResult.max_grade_percent}
          earthwork={routeResult.earthwork}
        />
      )}
    </div>
  );
}
